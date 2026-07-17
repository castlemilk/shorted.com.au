package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrandbrainAgentClient_Claim(t *testing.T) {
	var gotAuth, gotAgent, gotPath, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAgent = r.Header.Get("X-Agent-ID")
		gotPath = r.URL.Path
		gotMethod = r.Method
		_, _ = w.Write([]byte(`{"job":{"id":"job-1","kind":"housing","suburb":"Chatswood","state":"NSW","postcode":"2067","source":"both","tier":"listings"}}`))
	}))
	defer srv.Close()

	c := newBrandbrainAgentClient(agentConfig{brandbrainURL: srv.URL, token: "tok-123", agentID: "housing-mac0"})
	job, err := c.claim(context.Background())
	if err != nil {
		t.Fatalf("claim error: %v", err)
	}
	if job == nil || job.ID != "job-1" || job.Suburb != "Chatswood" || job.Tier != "listings" {
		t.Fatalf("claim job = %+v", job)
	}
	if gotAuth != "Bearer tok-123" || gotAgent != "housing-mac0" {
		t.Fatalf("auth headers = %q / %q", gotAuth, gotAgent)
	}
	if gotMethod != http.MethodPost || gotPath != "/api/v1/agent/crawl-jobs/claim" {
		t.Fatalf("request = %s %s", gotMethod, gotPath)
	}
}

func TestBrandbrainAgentClient_ClaimEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"job":null}`))
	}))
	defer srv.Close()

	c := newBrandbrainAgentClient(agentConfig{brandbrainURL: srv.URL, token: "t", agentID: "a"})
	job, err := c.claim(context.Background())
	if err != nil || job != nil {
		t.Fatalf("empty claim = %+v,%v want nil,nil", job, err)
	}
}

func TestBrandbrainAgentClient_Submit(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = w.Write([]byte(`{"job":{"id":"job-1","status":"succeeded"}}`))
	}))
	defer srv.Close()

	c := newBrandbrainAgentClient(agentConfig{brandbrainURL: srv.URL, token: "t", agentID: "a"})
	summary := &crawlJobSummary{Suburbs: 1, Listings: 158, Events: 158, BlockedSweeps: 0}
	if err := c.submit(context.Background(), "job-1", "succeeded", summary, ""); err != nil {
		t.Fatalf("submit error: %v", err)
	}
	if body["job_id"] != "job-1" || body["status"] != "succeeded" {
		t.Fatalf("submit body = %v", body)
	}
	rs, ok := body["result_summary"].(map[string]any)
	if !ok || rs["listings"].(float64) != 158 {
		t.Fatalf("submit result_summary = %v", body["result_summary"])
	}
}

func TestBrandbrainAgentClient_SubmitHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := newBrandbrainAgentClient(agentConfig{brandbrainURL: srv.URL, token: "bad", agentID: "a"})
	if err := c.submit(context.Background(), "job-1", "succeeded", &crawlJobSummary{}, ""); err == nil {
		t.Fatal("expected an error on 401")
	}
}

func TestBrandbrainAgentClient_Enqueue(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agent/crawl-jobs" || r.Method != http.MethodPost {
			t.Errorf("enqueue hit %s %s", r.Method, r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		_, _ = w.Write([]byte(`{"enqueued":2}`))
	}))
	defer srv.Close()

	c := newBrandbrainAgentClient(agentConfig{brandbrainURL: srv.URL, token: "t", agentID: "a"})
	n, err := c.enqueue(context.Background(), []crawlEnqueueInput{
		{Kind: "housing", Suburb: "Chatswood", State: "NSW", Postcode: "2067", Source: "both", Tier: "listings"},
		{Kind: "housing", Suburb: "Mosman", State: "NSW", Postcode: "2088", Source: "both", Tier: "listings"},
	})
	if err != nil || n != 2 {
		t.Fatalf("enqueue = %d,%v want 2,nil", n, err)
	}
	jobs, ok := body["jobs"].([]any)
	if !ok || len(jobs) != 2 {
		t.Fatalf("enqueue body jobs = %v", body["jobs"])
	}
}

func TestResolveCrawlTarget_FoundInCatalog(t *testing.T) {
	// Chatswood is in the curated crawlTargets → the authoritative entry (with Capital).
	job := &agentCrawlJob{Suburb: "Chatswood", State: "NSW", Postcode: "2067", Source: "both", Tier: "listings"}
	tgt, found := resolveCrawlTarget(job)
	if !found {
		t.Fatalf("Chatswood should resolve from the catalog")
	}
	if tgt.Suburb != "chatswood" || tgt.Display != "Chatswood" || tgt.Capital != "1GSYD" {
		t.Fatalf("resolved target = %+v", tgt)
	}
}

func TestResolveCrawlTarget_ConstructedFallback(t *testing.T) {
	// A suburb not in the catalog is constructed best-effort (no Capital).
	job := &agentCrawlJob{Suburb: "Coogee Beach", State: "nsw", Postcode: "2034", Tier: "listings"}
	tgt, found := resolveCrawlTarget(job)
	if found {
		t.Fatalf("Coogee Beach should NOT be in the catalog")
	}
	if tgt.Suburb != "coogee-beach" || tgt.Display != "Coogee Beach" || tgt.State != "NSW" || tgt.Capital != "" {
		t.Fatalf("constructed target = %+v", tgt)
	}
}

func TestBrandbrainAgentClient_RefreshesOn401(t *testing.T) {
	// The local agent control API hands out a fresh token.
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/control/v1/auth/session/export" || r.Header.Get("X-Agent-Control-Secret") != "ctl-secret" {
			http.Error(w, "nope", http.StatusForbidden)
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"fresh-token"}`))
	}))
	defer control.Close()

	var calls int
	var seenTokens []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		seenTokens = append(seenTokens, r.Header.Get("Authorization"))
		if r.Header.Get("Authorization") != "Bearer fresh-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized) // stale token → 401
			return
		}
		_, _ = w.Write([]byte(`{"job":{"id":"job-1","suburb":"Bondi","tier":"listings"}}`))
	}))
	defer srv.Close()

	c := newBrandbrainAgentClient(agentConfig{
		brandbrainURL: srv.URL, token: "stale-token", agentID: "a",
		controlURL: control.URL, controlSecret: "ctl-secret",
	})
	job, err := c.claim(context.Background())
	if err != nil {
		t.Fatalf("claim after refresh: %v", err)
	}
	if job == nil || job.ID != "job-1" {
		t.Fatalf("claim job = %+v", job)
	}
	if calls != 2 {
		t.Fatalf("expected 2 calls (401 then retry with fresh token), got %d", calls)
	}
	if c.token != "fresh-token" {
		t.Fatalf("client token not updated after refresh: %q", c.token)
	}
	if len(seenTokens) != 2 || seenTokens[0] != "Bearer stale-token" || seenTokens[1] != "Bearer fresh-token" {
		t.Fatalf("tokens seen = %v", seenTokens)
	}
}

func TestBrandbrainAgentClient_No401RefreshWithoutControl(t *testing.T) {
	// Without a control API configured, a 401 stays a hard error (back-compat).
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := newBrandbrainAgentClient(agentConfig{brandbrainURL: srv.URL, token: "t", agentID: "a"})
	if _, err := c.claim(context.Background()); err == nil {
		t.Fatal("expected a 401 error when no control API is available to refresh from")
	}
	if calls != 1 {
		t.Fatalf("expected exactly 1 call (no retry without refresh), got %d", calls)
	}
}

func TestDigitsOnly(t *testing.T) {
	cases := map[string]string{"9222\n": "9222", " 51763 ": "51763", "port=8080": "8080", "abc": "", "": ""}
	for in, want := range cases {
		if got := digitsOnly(in); got != want {
			t.Errorf("digitsOnly(%q) = %q want %q", in, got, want)
		}
	}
}

func TestAgentJobOutcome(t *testing.T) {
	cases := []struct {
		name          string
		events        int
		blockedSweeps int
		want          string
	}{
		// A clean full sweep (events written) → succeeded.
		{"clean sweep", 242, 0, "succeeded"},
		// The live regression: a blocked/poisoned sweep collected page-1 listings
		// (seen>0) but wrote 0 events → must fail so the queue re-serves it, NOT
		// bank a silent no-data success (New Farm/Toowong were wrongly "succeeded").
		{"blocked no events", 0, 2, "failed"},
		// A single source blocked but the other wrote events → still succeeded.
		{"partial block with events", 110, 1, "succeeded"},
		// A legitimate no-change run (nothing blocked, no price events) → succeeded.
		{"legit no-change", 0, 0, "succeeded"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := agentJobOutcome(tc.events, tc.blockedSweeps); got != tc.want {
				t.Fatalf("agentJobOutcome(%d, %d) = %q want %q", tc.events, tc.blockedSweeps, got, tc.want)
			}
		})
	}
}

func TestAgentJobTerminal(t *testing.T) {
	boom := errors.New("boom")
	cases := []struct {
		name          string
		events        int
		blockedSweeps int
		skippedRows   int
		diffErr       error
		want          string
	}{
		{"clean sweep", 242, 0, 0, nil, "succeeded"},
		{"blocked no events", 0, 2, 0, nil, "failed"},
		{"partial block with events", 110, 1, 0, nil, "succeeded"},
		{"legit no-change", 0, 0, 0, nil, "succeeded"},
		// A transient diff (persist) failure must FAIL the job even though the
		// sweep wasn't blocked (blockedSweeps==0) — reporting "succeeded" would
		// bank a silent no-data run (0 events looks identical to a clean
		// no-change sweep), so the suburb wouldn't be re-crawled until the next
		// full enqueue. Holds even if a sibling source already committed events.
		{"diff error, no events written", 0, 0, 0, boom, "failed"},
		{"diff error despite sibling events", 5, 0, 0, boom, "failed"},
		// A PARTIAL per-row skip (some events still written) is the graceful case
		// the SAVEPOINT change exists for → succeed, keep the good rows.
		{"partial skip with events", 40, 0, 3, nil, "succeeded"},
		// But ALL rows skipped (0 events, skippedRows>0) = we saw listings and
		// persisted nothing → a systematic extractor problem → fail (surface it),
		// not a silent no-data success.
		{"all rows skipped", 0, 0, 12, nil, "failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, _, _ := agentJobTerminal(tc.events, tc.blockedSweeps, tc.skippedRows, tc.diffErr)
			if got != tc.want {
				t.Fatalf("agentJobTerminal(%d, %d, %d, %v) status = %q want %q", tc.events, tc.blockedSweeps, tc.skippedRows, tc.diffErr, got, tc.want)
			}
		})
	}
	// The DB failure must surface in detail + errMsg so a warm-session DB blip is
	// distinguishable from a Kasada block in the queue/ops logs.
	_, detail, errMsg := agentJobTerminal(0, 0, 0, errors.New("TLS handshake timeout"))
	if !strings.Contains(detail, "diff persist error") || !strings.Contains(errMsg, "TLS handshake timeout") {
		t.Fatalf("diff error should surface: detail=%q errMsg=%q", detail, errMsg)
	}
	// An all-skipped failure must surface distinctly (mentions skipped rows).
	if _, d2, _ := agentJobTerminal(0, 0, 5, nil); !strings.Contains(d2, "skipped") {
		t.Fatalf("all-skipped failure should mention skipped rows, got %q", d2)
	}
}
