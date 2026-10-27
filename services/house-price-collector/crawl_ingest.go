package main

// crawl_ingest.go is the rig's client for shorted's CrawlIngestService (S-FETCH). In
// the ingest and shadow sinks (crawl_sink.go) the rig fetches and PUSHES each sweep
// here, and BrandBrain only ever sees counts. Everything in this file is transport:
// the workload token, the Connect calls, retries, and the mapping from a failed call
// to the round exit code the design's table names.
//
// The token is the BrandBrain-issued workload identity (design, "Workload identity").
// The co-located BrandBrain agent mints it on its loopback control API, and the token
// is never logged, never put in an error, and never written to an event.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	connectrpc "connectrpc.com/connect"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1/housingingestv1connect"
)

const (
	// ingestAudience is the token audience the ingest service verifies (design:
	// "Claims"). The loopback endpoint issues only allowlisted audiences.
	ingestAudience = "https://api.shorted.com.au/housing-ingest"
	// workloadTokenPath is the co-located agent's loopback mint endpoint. BrandBrain
	// ships it in B2; until then the client is exercised against a fake.
	workloadTokenPath = "/control/v1/workload-token"
	// ingestTokenSkew is how much life a cached token must still have. Less than this
	// and the next call re-fetches first (design: "collector calls loopback when less
	// than 60 seconds remain").
	ingestTokenSkew = 60 * time.Second
	// ingestTokenDefaultLife is assumed when the loopback reports no expiry at all.
	// Short, so an unknown expiry costs a re-fetch rather than a 401.
	ingestTokenDefaultLife = 5 * time.Minute
	// ingestMaxAttempts is the number of tries for one call (design: "retries push up
	// to 3 times"), counting the first.
	ingestMaxAttempts = 3
	// ingestLeaseRenewEvery is how often a running job renews its BrandBrain lease. The
	// lease is 10 minutes, so this leaves room for two missed renewals.
	ingestLeaseRenewEvery = 4 * time.Minute
	// ingestDeferRetryAfter holds a job back when the ingest could not take it. The
	// attempt is refunded by the queue, so the job is not burned.
	ingestDeferRetryAfter = 15 * time.Minute
	// ingestCallTimeout bounds one RPC. A dense sweep is at most 2,000 listings.
	ingestCallTimeout = 60 * time.Second
)

// The round exit codes an ingest failure ends the round with. They are the design's
// table (rc 13, 14, 15). Exit 7 is shared with the agent's other infrastructure
// failures, including a token the loopback could not mint.
const (
	exitIngestAuthRefused = 13
	exitIngestUnavailable = 14
	exitIngestContract    = 15
)

// tokenError is a workload token the loopback could not provide. It is agent
// infrastructure (exit 7), not an answer from the ingest, so it is never retried as a
// transient ingest failure.
type tokenError struct{ err error }

func (e *tokenError) Error() string { return "workload token: " + e.err.Error() }
func (e *tokenError) Unwrap() error { return e.err }

// exhaustedError is a transient ingest failure that outlasted its retries. It ends
// the round with exit 14.
type exhaustedError struct{ err error }

func (e *exhaustedError) Error() string {
	return fmt.Sprintf("ingest unavailable after %d attempts: %v", ingestMaxAttempts, e.err)
}
func (e *exhaustedError) Unwrap() error { return e.err }

// workloadTokenSource caches one workload token with its expiry. Token re-fetches
// when fewer than ingestTokenSkew remain, or when force is set (the one re-fetch after
// a 401). The mutex is held across a fetch, which is fine: a push is sequential.
type workloadTokenSource struct {
	fetch func(ctx context.Context) (string, time.Time, error)
	now   func() time.Time

	mu    sync.Mutex
	token string
	exp   time.Time
}

// Token returns a token with at least ingestTokenSkew of life, or fetches one.
func (s *workloadTokenSource) Token(ctx context.Context, force bool) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !force && s.token != "" && s.exp.Sub(s.now()) >= ingestTokenSkew {
		return s.token, nil
	}
	tok, exp, err := s.fetch(ctx)
	if err != nil {
		return "", &tokenError{err: err}
	}
	s.token, s.exp = tok, exp
	return tok, nil
}

// loopbackWorkloadToken returns the fetch function for the co-located agent's loopback
// mint endpoint. It authenticates the way refreshToken does: the control secret in
// X-Agent-Control-Secret. Its errors carry the status and never the response body,
// because the body is the token.
func loopbackWorkloadToken(client *http.Client, controlURL, secret string, now func() time.Time) func(ctx context.Context) (string, time.Time, error) {
	return func(ctx context.Context) (string, time.Time, error) {
		if controlURL == "" || secret == "" {
			return "", time.Time{}, errors.New("local agent control API not configured")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet,
			controlURL+workloadTokenPath+"?audience="+url.QueryEscape(ingestAudience), nil)
		if err != nil {
			return "", time.Time{}, errors.New("workload token request could not be built")
		}
		req.Header.Set("X-Agent-Control-Secret", secret)
		resp, err := client.Do(req)
		if err != nil {
			return "", time.Time{}, fmt.Errorf("control api unreachable: %w", err)
		}
		defer func() { _ = resp.Body.Close() }()
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if resp.StatusCode >= 300 {
			return "", time.Time{}, fmt.Errorf("control api: status %d", resp.StatusCode)
		}
		var out struct {
			AccessToken string `json:"access_token"`
			ExpiresAt   string `json:"expires_at"`
			ExpiresIn   int64  `json:"expires_in"`
		}
		if err := json.Unmarshal(rb, &out); err != nil {
			return "", time.Time{}, errors.New("control api: response is not JSON")
		}
		if out.AccessToken == "" {
			return "", time.Time{}, errors.New("control api: no access_token in response")
		}
		exp := now().Add(ingestTokenDefaultLife)
		switch {
		case out.ExpiresAt != "":
			t, err := time.Parse(time.RFC3339, out.ExpiresAt)
			if err != nil {
				return "", time.Time{}, errors.New("control api: expires_at is not RFC 3339")
			}
			exp = t
		case out.ExpiresIn > 0:
			exp = now().Add(time.Duration(out.ExpiresIn) * time.Second)
		}
		return out.AccessToken, exp, nil
	}
}

// ingestClient wraps the generated Connect client with auth, retries and the lease
// renewal that runs between retries. Its functions are fields so the tests can wire
// fakes and a zero sleep.
type ingestClient struct {
	rpc     housingingestv1connect.CrawlIngestServiceClient
	tokens  *workloadTokenSource
	renew   func(ctx context.Context, jobID string) error
	sleep   func(ctx context.Context, d time.Duration) error
	backoff func(retry int) time.Duration
}

// newIngestClient builds the client for the ingest service at baseURL. Requests are
// binary protobuf with gzip, the service's wire format.
func newIngestClient(baseURL string, tokens *workloadTokenSource) *ingestClient {
	hc := &http.Client{Timeout: ingestCallTimeout}
	return &ingestClient{
		rpc:     housingingestv1connect.NewCrawlIngestServiceClient(hc, baseURL, connectrpc.WithSendGzip()),
		tokens:  tokens,
		sleep:   sleepCtx,
		backoff: ingestBackoff,
	}
}

// ingestBackoff is the wait before retry n (1 is the first retry): 1s, 2s, capped at 8s.
func ingestBackoff(retry int) time.Duration {
	d := time.Second << uint(max(retry-1, 0))
	return min(d, 8*time.Second)
}

// sleepCtx waits d, or returns the context's error if it ends first.
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// errCode returns the Connect code of err, and false when err carries none.
func errCode(err error) (connectrpc.Code, bool) {
	var ce *connectrpc.Error
	if errors.As(err, &ce) {
		return ce.Code(), true
	}
	return 0, false
}

// connectMessage returns the Connect message of err. The ingest service writes only
// fixed reasons into these messages, so it is safe to compare against them.
func connectMessage(err error) string {
	var ce *connectrpc.Error
	if errors.As(err, &ce) {
		return ce.Message()
	}
	return ""
}

// transientIngestError reports whether a failed call is worth another try: a
// transport failure or a server-side 5xx. An auth answer, a contract or a per-job
// answer is not, and neither is a token the loopback could not give.
func transientIngestError(err error) bool {
	var te *tokenError
	if errors.As(err, &te) {
		return false
	}
	if code, ok := errCode(err); ok {
		switch code {
		case connectrpc.CodeUnavailable, connectrpc.CodeInternal, connectrpc.CodeUnknown, connectrpc.CodeDeadlineExceeded:
			return true
		default:
			return false
		}
	}
	return !errors.Is(err, context.Canceled)
}

// withRetry runs attempt, retrying transient failures. Before each retry it renews the
// job's lease (jobID "" means none), so the lease survives a slow push. It returns an
// exhaustedError once the attempts are spent. A renewal failure is logged and ignored.
func (c *ingestClient) withRetry(ctx context.Context, jobID string, attempt func() error) error {
	for n := 1; ; n++ {
		err := attempt()
		if err == nil || !transientIngestError(err) {
			return err
		}
		if n >= ingestMaxAttempts {
			return &exhaustedError{err: err}
		}
		log.Printf("[ingest] attempt %d of %d failed (retrying): %v", n, ingestMaxAttempts, err)
		if jobID != "" && c.renew != nil {
			if rerr := c.renew(ctx, jobID); rerr != nil {
				log.Printf("[ingest] lease renewal before retry failed (job=%s): %v — continuing", jobID, rerr)
			}
		}
		if serr := c.sleep(ctx, c.backoff(n)); serr != nil {
			return serr
		}
	}
}

// withAuth runs call with a workload token. An Unauthenticated answer re-fetches the
// token once (force) and tries once more. Any second refusal is returned as it is.
func (c *ingestClient) withAuth(ctx context.Context, call func(bearer string) error) error {
	tok, err := c.tokens.Token(ctx, false)
	if err != nil {
		return err
	}
	err = call(tok)
	if code, ok := errCode(err); ok && code == connectrpc.CodeUnauthenticated {
		tok, terr := c.tokens.Token(ctx, true)
		if terr != nil {
			return terr
		}
		return call(tok)
	}
	return err
}

// probe calls ProbeAuth with the same auth and retry policy as a push. It has no job,
// so there is no lease to renew.
func (c *ingestClient) probe(ctx context.Context) (*pb.ProbeAuthResponse, error) {
	var out *pb.ProbeAuthResponse
	err := c.withRetry(ctx, "", func() error {
		return c.withAuth(ctx, func(bearer string) error {
			req := connectrpc.NewRequest(&pb.ProbeAuthRequest{})
			req.Header().Set("Authorization", "Bearer "+bearer)
			resp, err := c.rpc.ProbeAuth(ctx, req)
			if err != nil {
				return err
			}
			out = resp.Msg
			return nil
		})
	})
	return out, err
}

// pushSweep sends one sweep. The idempotency key is the same across retries, so a
// retry that the server already applied is replayed, not applied twice.
func (c *ingestClient) pushSweep(ctx context.Context, req *pb.PushSweepRequest) (*pb.PushSweepResponse, error) {
	var out *pb.PushSweepResponse
	err := c.withRetry(ctx, req.GetJobId(), func() error {
		return c.withAuth(ctx, func(bearer string) error {
			r := connectrpc.NewRequest(req)
			r.Header().Set("Authorization", "Bearer "+bearer)
			resp, err := c.rpc.PushSweep(ctx, r)
			if err != nil {
				return err
			}
			out = resp.Msg
			return nil
		})
	})
	return out, err
}

// reportCycle sends one cycle's counts-only outcome. It replaces the rig's own
// crawl_run_status write, because the rig holds no database.
func (c *ingestClient) reportCycle(ctx context.Context, req *pb.ReportCycleRequest) error {
	return c.withRetry(ctx, "", func() error {
		return c.withAuth(ctx, func(bearer string) error {
			r := connectrpc.NewRequest(req)
			r.Header().Set("Authorization", "Bearer "+bearer)
			_, err := c.rpc.ReportCycle(ctx, r)
			return err
		})
	})
}

// ingestRoundExit maps a failed ingest call to the round exit it ends the round with,
// or 0 when the answer is about this job only (per-job answers are in crawl_sink.go).
//
//	token could not be minted        -> 7  (agent infrastructure)
//	Unauthenticated, PermissionDenied -> 13 (auth refused; after the one re-fetch)
//	retries exhausted (transient)     -> 14 (ingest unavailable)
//	contract_too_old                  -> 15 (the collector is too old)
func ingestRoundExit(err error) int {
	if err == nil {
		return 0
	}
	var te *tokenError
	if errors.As(err, &te) {
		return exitAgentInfra
	}
	var ex *exhaustedError
	if errors.As(err, &ex) {
		return exitIngestUnavailable
	}
	code, ok := errCode(err)
	if !ok {
		return 0
	}
	switch code {
	case connectrpc.CodeUnauthenticated, connectrpc.CodePermissionDenied:
		return exitIngestAuthRefused
	case connectrpc.CodeFailedPrecondition:
		if strings.HasPrefix(connectMessage(err), "contract_too_old") {
			return exitIngestContract
		}
	}
	return 0
}
