package brandbrain

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const fleetToken = "fleet-ops-token-SECRET-7f3a"

// fleetReq is one request the stand-in received.
type fleetReq struct {
	Method, Path, Query, Body string
	Token, Operator, Idem     string
}

// fleetStandIn records every request and answers from a handler the test sets.
type fleetStandIn struct {
	mu   sync.Mutex
	reqs []fleetReq
	// handler answers each request after it is recorded. The default is 200 {}.
	handler func(w http.ResponseWriter, r *http.Request)
}

func (s *fleetStandIn) requests() []fleetReq {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]fleetReq(nil), s.reqs...)
}

func newFleetStandIn(t *testing.T, handler func(http.ResponseWriter, *http.Request)) (*httptest.Server, *fleetStandIn) {
	t.Helper()
	st := &fleetStandIn{handler: handler}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		st.mu.Lock()
		st.reqs = append(st.reqs, fleetReq{
			Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Body: string(raw),
			Token: r.Header.Get(fleetTokenHeader), Operator: r.Header.Get(fleetOperatorHeader), Idem: r.Header.Get(idempotencyHeader),
		})
		st.mu.Unlock()
		if r.Header.Get(fleetTokenHeader) != fleetToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if st.handler == nil {
			_, _ = io.WriteString(w, `{}`)
			return
		}
		r.Body = io.NopCloser(strings.NewReader(string(raw)))
		st.handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, st
}

func fleetClient(t *testing.T, base string, timeout time.Duration) *FleetClient {
	t.Helper()
	f, err := NewFleetTestClient(base, fleetToken, timeout)
	if err != nil {
		t.Fatal(err)
	}
	return f.WithOperator("ops@shorted.com.au")
}

func TestFleetIsNotConfiguredWithoutItsToken(t *testing.T) {
	f, err := FleetFromEnv(func(string) string { return "" })
	if err != nil || f != nil {
		t.Fatalf("unset token: client=%v err=%v, want nil and nil", f, err)
	}
	var none *FleetClient
	if _, err := none.ListRigs(context.Background()); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("nil client: %v", err)
	}
}

func TestFleetFromEnvRefusesAnotherHost(t *testing.T) {
	env := map[string]string{EnvFleetOpsToken: fleetToken, EnvBaseURL: "https://evil.example.com"}
	if _, err := FleetFromEnv(func(k string) string { return env[k] }); err == nil {
		t.Fatal("a base URL off the pinned host was accepted")
	}
	env[EnvBaseURL] = ""
	f, err := FleetFromEnv(func(k string) string { return env[k] })
	if err != nil || f == nil {
		t.Fatalf("default base: %v", err)
	}
}

func TestFleetSendsItsHeadersAndNeverEchoesTheToken(t *testing.T) {
	srv, st := newFleetStandIn(t, nil)
	f := fleetClient(t, srv.URL, 0)
	if _, err := f.ListRigs(context.Background()); err != nil {
		t.Fatal(err)
	}
	reqs := st.requests()
	if len(reqs) != 1 || reqs[0].Token != fleetToken || reqs[0].Operator != "shorted-admin:ops@shorted.com.au" {
		t.Fatalf("headers = %+v", reqs)
	}
	bad, _ := NewFleetTestClient(srv.URL, "wrong", 0)
	_, err := bad.ListRigs(context.Background())
	if !errors.Is(err, ErrRejected) || strings.Contains(err.Error(), fleetToken) {
		t.Fatalf("bad token: %v", err)
	}
}

func TestFleetRedirectIsRefusedAndNeverFollowed(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("the token followed a redirect")
	}))
	t.Cleanup(other.Close)
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.Path, http.StatusTemporaryRedirect)
	})
	_, err := fleetClient(t, srv.URL, 0).ListRigs(context.Background())
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("redirect: %v, want unavailable", err)
	}
}

func TestFleetTimeoutIsUnknownNotAFailure(t *testing.T) {
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = io.WriteString(w, `{}`)
	})
	_, err := fleetClient(t, srv.URL, 20*time.Millisecond).ListRigs(context.Background())
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("timeout: %v, want unavailable", err)
	}
}

func TestFleetStatusesMapToTypedOutcomes(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"contract 404", http.StatusNotFound, `{"code":"rig_not_found"}`, ErrRigNotFound},
		{"command 404", http.StatusNotFound, `{"error":"command_not_found","code":"command_not_found"}`, ErrCommandNotFound},
		{"plain 404", http.StatusNotFound, `404 page not found`, ErrUnavailable},
		{"400", http.StatusBadRequest, `{}`, ErrInvalidRequest},
		{"403 fleet_ops_forbidden", http.StatusForbidden, `{"error":"fleet_ops_forbidden","code":"fleet_ops_forbidden"}`, ErrRejected},
		{"429", http.StatusTooManyRequests, `{"error":"rate_limited","code":"rate_limited"}`, ErrRateLimited},
		{"500", http.StatusInternalServerError, `{}`, ErrUnavailable},
		{"unexpected 418", http.StatusTeapot, `{}`, ErrUnavailable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(c.status)
				_, _ = io.WriteString(w, c.body)
			})
			_, err := fleetClient(t, srv.URL, 0).ListRigs(context.Background())
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
}

// A 409 is a typed conflict carrying BrandBrain's closed code. Nothing was created.
func TestFleetConflictCarriesTheClosedCode(t *testing.T) {
	for _, code := range []string{"rig_busy", "rig_not_active", "agent_update_required", "management_action_unsupported", "idempotency_conflict", "housing_crawl_grant_required"} {
		srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"error":"`+code+`","code":"`+code+`"}`)
		})
		_, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "k")
		var ce *ConflictError
		if !errors.Is(err, ErrConflict) || !errors.As(err, &ce) || ce.Code != code {
			t.Fatalf("409 %s: %v", code, err)
		}
		if errors.Is(err, ErrUnavailable) {
			t.Fatalf("409 %s reads as unknown; nothing was created, so it is a refusal", code)
		}
	}
}

// A 409 whose code is not a plain word (free text, a path) is reported as unknown, never echoed.
func TestFleetConflictNeverEchoesFreeText(t *testing.T) {
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"see https://evil.example/x and secret=abc"}`)
	})
	_, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "k")
	var ce *ConflictError
	if !errors.As(err, &ce) || ce.Code != "unknown" || strings.Contains(err.Error(), "evil") {
		t.Fatalf("free-text code echoed: %v", err)
	}
}

func TestFleetCrawlJobsRestrictsKindToHousing(t *testing.T) {
	srv, st := newFleetStandIn(t, nil)
	f := fleetClient(t, srv.URL, 0)
	if _, err := f.ListCrawlJobs(context.Background(), CrawlJobQuery{Source: "both"}); err != nil {
		t.Fatalf("source=both: %v", err)
	}
	if q := st.requests()[0].Query; !strings.Contains(q, "kind=housing") || !strings.Contains(q, "source=both") {
		t.Fatalf("query = %q", q)
	}
	if _, err := f.ListCrawlJobs(context.Background(), CrawlJobQuery{Kind: "other"}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("kind=other: %v, want refused", err)
	}
	if _, err := f.ListCrawlJobs(context.Background(), CrawlJobQuery{Source: "all"}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("source=all: %v, want refused", err)
	}
	if n := len(st.requests()); n != 1 {
		t.Fatalf("%d requests sent; refused queries must send none", n)
	}
}

func TestFleetRunDrainSendsOnlyTheLiveDrain(t *testing.T) {
	srv, st := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"command":{"id":"cmd-9","kind":"housing_crawl_run","status":"pending"}}`)
	})
	cmd, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "smoke-x:drain")
	if err != nil {
		t.Fatal(err)
	}
	if cmd.ID != "cmd-9" {
		t.Fatalf("command = %+v", cmd)
	}
	req := st.requests()[0]
	if req.Method != http.MethodPost || req.Path != "/api/v1/fleet/rigs/rig-1/commands" || req.Idem != "smoke-x:drain" {
		t.Fatalf("request = %+v", req)
	}
	var body struct {
		Kind    string         `json:"kind"`
		Payload map[string]any `json:"payload"`
	}
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		t.Fatal(err)
	}
	if body.Kind != "housing_crawl_run" || body.Payload["job"] != "drain" || body.Payload["dry_run"] != false || len(body.Payload) != 2 {
		t.Fatalf("body = %s", req.Body)
	}
}

func TestFleetLogRequestRefusesAnyOtherSourceWithoutSending(t *testing.T) {
	srv, st := newFleetStandIn(t, nil)
	f := fleetClient(t, srv.URL, 0)
	for _, src := range []string{"", "all", "Housing", "../runtime", "housing;x"} {
		if _, err := f.RequestRuntimeLogs(context.Background(), "rig-1", src, "logs-k"); !errors.Is(err, ErrCommandRefused) {
			t.Errorf("source %q: %v, want refused", src, err)
		}
	}
	if n := len(st.requests()); n != 0 {
		t.Fatalf("%d requests were sent for refused sources", n)
	}
}

func TestFleetCommandWithoutAnIDIsUnknown(t *testing.T) {
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"command":{"status":"pending"}}`)
	})
	if _, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "k"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("no id: %v, want unavailable", err)
	}
}

func TestFleetCommandFiveHundredIsNotRetried(t *testing.T) {
	srv, st := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	_, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "k")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("502: %v, want unavailable", err)
	}
	if n := len(st.requests()); n != 1 {
		t.Fatalf("a command with an unknown outcome was sent %d times", n)
	}
}

// A 429 on a drain is the per-rig live limit: nothing was sent, and the caller must say so.
func TestFleetDrainOver429IsRateLimitedNotFailed(t *testing.T) {
	srv, _ := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":"rate_limited","code":"rate_limited"}`)
	})
	_, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "k")
	if !errors.Is(err, ErrRateLimited) || errors.Is(err, ErrUnavailable) {
		t.Fatalf("429: %v, want rate limited (and not an unknown outcome)", err)
	}
}

// A drain never carries dry_run true, whatever the caller asks.
func TestFleetDrainNeverSendsADryRun(t *testing.T) {
	srv, st := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"command":{"id":"cmd-1"}}`)
	})
	if _, err := fleetClient(t, srv.URL, 0).RunDrain(context.Background(), "rig-1", "k"); err != nil {
		t.Fatal(err)
	}
	if body := st.requests()[0].Body; strings.Contains(body, `"dry_run":true`) || !strings.Contains(body, `"dry_run":false`) {
		t.Fatalf("drain body = %s", body)
	}
}

// A rig id that would change the route is refused before any request is built.
func TestFleetRefusesARigIDThatWouldChangeTheRoute(t *testing.T) {
	srv, st := newFleetStandIn(t, nil)
	f := fleetClient(t, srv.URL, 0)
	for _, id := range []string{"", "..", "a/../b", "rig-1/commands", "rig-1?x=1", "rig 1", "-rig"} {
		if _, err := f.CommandByRequestKey(context.Background(), id, "k"); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("rig id %q: %v, want invalid", id, err)
		}
		if _, err := f.RunDrain(context.Background(), id, "k"); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("drain on %q: %v, want invalid", id, err)
		}
	}
	if n := len(st.requests()); n != 0 {
		t.Fatalf("%d requests were sent for bad rig ids", n)
	}
}

// The request-key lookup is the only command read: it sends request_key and nothing else, and a
// key outside BrandBrain's pattern is refused before a request is built.
func TestFleetCommandByRequestKeySendsOnlyTheKey(t *testing.T) {
	srv, st := newFleetStandIn(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"command":{"id":"cmd-7","kind":"collect_runtime_logs","status":"succeeded"}}`)
	})
	f := fleetClient(t, srv.URL, 0)
	cmd, err := f.CommandByRequestKey(context.Background(), "rig-1", "logs-abc")
	if err != nil || cmd.ID != "cmd-7" {
		t.Fatalf("lookup: %+v %v", cmd, err)
	}
	if q := st.requests()[0].Query; q != "request_key=logs-abc" {
		t.Fatalf("query = %q, want only request_key", q)
	}
	if _, err := f.CommandByRequestKey(context.Background(), "rig-1", "bad key with spaces"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("bad key: %v", err)
	}
	if n := len(st.requests()); n != 1 {
		t.Fatalf("a bad key reached the wire (%d requests)", n)
	}
}
