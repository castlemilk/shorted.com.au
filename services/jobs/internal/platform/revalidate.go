package platform

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// RevalidateRequest describes one cache-bust ping to the web tier's
// /api/revalidate endpoint.
type RevalidateRequest struct {
	// Reason is a short tag identifying the call site (e.g. "agent",
	// "listings", "refresh") so a scan of the run log shows which path pinged.
	Reason string
	// Paths are the Next.js routes to revalidate (joined comma-separated, the
	// shape /api/revalidate expects).
	Paths []string
	// Flush names the cache families to drop (e.g. "housing", "shorts,housing").
	Flush string
	// Tag is a Next.js cache tag to revalidate (e.g. "report-2026-W06"). Jobs
	// that bust by tag rather than by path (weekly-report) set this instead of
	// Paths; the endpoint accepts either.
	Tag string
}

// PingRevalidate tells the web tier to bust its long-TTL caches the instant a
// job changes the underlying data, so ISR pages re-render with fresh data
// instead of waiting out their TTL ceiling. Ported verbatim in behaviour from
// services/house-price-collector/revalidate.go:
//
//   - best-effort by design: a revalidation failure must NEVER fail or abort a
//     run (callers ignore the outcome), and
//   - it NO-OPS silently when REVALIDATION_URL / REVALIDATION_SECRET are unset —
//     pages just self-heal on the ISR TTL.
//
// The ping runs on a DETACHED context (context.Background + a short deadline),
// not the job context: a run's ctx can expire right after the work + MV refresh
// finish, and the cache bust for ALREADY-persisted data must not be killed by
// that deadline firing between the write and the ping.
func PingRevalidate(req RevalidateRequest) {
	endpoint := os.Getenv("REVALIDATION_URL")
	secret := os.Getenv("REVALIDATION_SECRET")
	if endpoint == "" || secret == "" {
		log.Printf("[revalidate:%s] REVALIDATION_URL/REVALIDATION_SECRET not set; skipping cache bust", req.Reason)
		return
	}

	q := url.Values{}
	if len(req.Paths) > 0 {
		q.Set("path", strings.Join(req.Paths, ","))
	}
	if req.Flush != "" {
		q.Set("flush", req.Flush)
	}
	if req.Tag != "" {
		q.Set("tag", req.Tag)
	}
	reqURL := endpoint + "?" + q.Encode()

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, nil)
	if err != nil {
		log.Printf("[revalidate:%s] WARNING: build request failed: %v", req.Reason, redactURLError(err))
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Revalidate-Secret", secret)

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		log.Printf("[revalidate:%s] WARNING: revalidation ping failed: %v", req.Reason, redactURLError(err))
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		log.Printf("[revalidate:%s] WARNING: revalidation ping non-2xx (status %d): %s",
			req.Reason, resp.StatusCode, strings.TrimSpace(string(snippet)))
		return
	}
	log.Printf("[revalidate:%s] cache bust ok (status %d)", req.Reason, resp.StatusCode)
}

// redactURLError keeps endpoint details out of transport-error logs. The secret
// now rides in a header, but retaining URL redaction avoids leaking other query
// inputs or deployment host details.
func redactURLError(err error) error {
	var uerr *url.Error
	if errors.As(err, &uerr) {
		return fmt.Errorf("%s [url redacted]: %w", uerr.Op, uerr.Err)
	}
	return err
}
