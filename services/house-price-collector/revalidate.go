package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// pingRevalidate tells the web tier to bust its long-TTL caches the instant a
// crawl-driven MV refresh changes the housing data, so /price-drops and /housing
// re-render with fresh data instead of waiting out their ISR ceiling. It is
// best-effort by design: a revalidation failure must NEVER fail or abort a run
// (callers ignore it), and it no-ops silently when REVALIDATION_URL /
// REVALIDATION_SECRET are unset — pages just self-heal on the ISR TTL.
//
// reason is a short tag identifying the call site (e.g. "agent", "listings",
// "refresh") so a scan of the run log shows which path pinged.
//
// The ping runs on a DETACHED context (context.Background + a short deadline),
// not the crawl context: a run's ctx can expire (CRAWL_TIMEOUT_MIN) right after
// the work + MV refresh finish, and the cache bust for ALREADY-persisted data
// must not be killed by that deadline firing between the write and the ping.
// Same rationale as the post-run queue submit in crawl_agent.go.
func pingRevalidate(reason string) {
	endpoint := os.Getenv("REVALIDATION_URL")
	secret := os.Getenv("REVALIDATION_SECRET")
	if endpoint == "" || secret == "" {
		log.Printf("[revalidate:%s] REVALIDATION_URL/REVALIDATION_SECRET not set; skipping cache bust", reason)
		return
	}

	q := url.Values{}
	q.Set("secret", secret)
	q.Set("path", "/price-drops,/housing")
	q.Set("flush", "housing")
	// tag is intentionally unset — the flush=housing branch busts the housing
	// surfaces by path, no per-tag revalidation needed here.
	reqURL := endpoint + "?" + q.Encode()

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, nil)
	if err != nil {
		log.Printf("[revalidate:%s] WARNING: build request failed: %v", reason, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[revalidate:%s] WARNING: revalidation ping failed: %v", reason, err)
		return
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		log.Printf("[revalidate:%s] WARNING: revalidation ping non-2xx (status %d): %s",
			reason, resp.StatusCode, strings.TrimSpace(string(snippet)))
		return
	}
	log.Printf("[revalidate:%s] housing cache bust ok (status %d)", reason, resp.StatusCode)
}
