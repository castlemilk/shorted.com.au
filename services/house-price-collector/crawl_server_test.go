package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

// These tests need no database. The DB-backed tests of the same functions are in
// crawl_server_integration_test.go.

func testIDTokens() oauth2.TokenSource {
	return oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "test-id-token-value"})
}

// TestBrandbrainIDTokenClient_SendsBearerAndNoAgentID: the server's job authenticates
// with its Google ID token, and must not send the rig's X-Agent-ID header.
func TestBrandbrainIDTokenClient_SendsBearerAndNoAgentID(t *testing.T) {
	var gotAuth, gotAgent string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotAgent = r.Header.Get("X-Agent-ID")
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write([]byte(`{"enqueued":0,"job_ids":[],"targets":[]}`))
	}))
	defer srv.Close()

	c := newBrandbrainIDTokenClient(srv.URL+"/", testIDTokens())
	if _, err := c.enqueueTargets(context.Background(), nil); err != nil {
		t.Fatalf("enqueueTargets: %v", err)
	}
	if gotAuth != "Bearer test-id-token-value" {
		t.Fatalf("Authorization = %q, want the ID token bearer", gotAuth)
	}
	if gotAgent != "" {
		t.Fatalf("X-Agent-ID = %q, want none on the Google-token path", gotAgent)
	}
}

// TestBrandbrainIDTokenClient_401IsTerminalAndNamesTheCause: a refused token is not
// retried, and the error says what to check rather than blaming a static token.
func TestBrandbrainIDTokenClient_401IsTerminalAndNamesTheCause(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := newBrandbrainIDTokenClient(srv.URL, testIDTokens())
	_, err := c.enqueueTargets(context.Background(), []crawlEnqueueInput{{Kind: "housing", Suburb: "Richmond", State: "VIC", Postcode: "3121", Source: "rea", Tier: "listings"}})
	if err == nil {
		t.Fatal("expected an error for a 401")
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("calls = %d, want 1 (a 401 is terminal)", got)
	}
	if !strings.Contains(err.Error(), "Google ID token was refused") || strings.Contains(err.Error(), "BRANDBRAIN_AGENT_TOKEN") {
		t.Fatalf("error %q should name the ID token refusal, not the static agent token", err)
	}
}

// TestBrandbrainIDTokenClient_5xxRetriesThenFails: a BrandBrain outage is retried by the
// client's bounded backoff, and then surfaces as an error.
func TestBrandbrainIDTokenClient_5xxRetriesThenFails(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "boom", http.StatusBadGateway)
	}))
	defer srv.Close()

	c := newBrandbrainIDTokenClient(srv.URL, testIDTokens())
	if _, err := c.enqueueTargets(context.Background(), nil); err == nil {
		t.Fatal("expected an error for a 502")
	}
	if got := calls.Load(); got != 4 {
		t.Fatalf("calls = %d, want 4 (the client's bounded attempts)", got)
	}
}

// failingTokenSource stands in for idtoken when no credentials are available.
type failingTokenSource struct{}

func (failingTokenSource) Token() (*oauth2.Token, error) {
	return nil, errors.New("no credentials for the test")
}

// TestBrandbrainIDTokenClient_TokenFailureNeverReachesBrandBrain: no token, no request.
func TestBrandbrainIDTokenClient_TokenFailureNeverReachesBrandBrain(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
	}))
	defer srv.Close()

	c := newBrandbrainIDTokenClient(srv.URL, failingTokenSource{})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := c.enqueueTargets(ctx, nil); err == nil {
		t.Fatal("expected an error when no token is available")
	}
	if calls.Load() != 0 {
		t.Fatalf("BrandBrain was called %d time(s) without a token", calls.Load())
	}
}

// TestCheckTargetsEcho_RejectsAnyMismatch: the ledger takes its target from the request,
// so an answer that does not match what was asked must never reach it.
func TestCheckTargetsEcho_RejectsAnyMismatch(t *testing.T) {
	sent := []crawlEnqueueInput{
		{Kind: "housing", Suburb: "St Kilda", State: "VIC", Postcode: "3182", Source: "rea", Tier: "listings"},
		{Kind: "housing", Suburb: "Richmond", State: "VIC", Postcode: "3121", Source: "domain", Tier: "listings"},
	}
	ok := []enqueueTargetItem{
		{Suburb: "St Kilda", State: "VIC", Postcode: "3182", Source: "rea", JobID: "a", Created: true},
		{Suburb: "richmond", State: "vic", Postcode: "3121", Source: "DOMAIN", JobID: "b", Created: false},
	}
	if err := checkTargetsEcho(sent, ok); err != nil {
		t.Fatalf("matching echo (case-insensitive) rejected: %v", err)
	}

	cases := map[string][]enqueueTargetItem{
		"short answer": ok[:1],
		"wrong suburb": {ok[0], {Suburb: "Brunswick", State: "VIC", Postcode: "3121", Source: "domain", JobID: "b"}},
		"wrong state":  {ok[0], {Suburb: "Richmond", State: "NSW", Postcode: "3121", Source: "domain", JobID: "b"}},
		"wrong source": {ok[0], {Suburb: "Richmond", State: "VIC", Postcode: "3121", Source: "rea", JobID: "b"}},
		"no job id":    {ok[0], {Suburb: "Richmond", State: "VIC", Postcode: "3121", Source: "domain", JobID: ""}},
	}
	for name, got := range cases {
		if err := checkTargetsEcho(sent, got); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestLoadServerEnqueueConfig(t *testing.T) {
	t.Setenv("BRANDBRAIN_AGENT_URL", "https://api.brandbrain.dev/")
	t.Setenv("BRANDBRAIN_IDTOKEN_AUDIENCE", "")
	t.Setenv("HOUSING_INGEST_DISPATCH_TTL", "")
	t.Setenv("CRAWL_ENQUEUE_SOURCE", "")

	cfg, err := loadServerEnqueueConfig()
	if err != nil {
		t.Fatalf("defaults: %v", err)
	}
	if cfg.brandbrainURL != "https://api.brandbrain.dev" {
		t.Errorf("url = %q: trailing slash must be trimmed", cfg.brandbrainURL)
	}
	if cfg.audience != "https://api.brandbrain.dev" {
		t.Errorf("audience = %q, want the BrandBrain default", cfg.audience)
	}
	if cfg.dispatchTTL != 72*time.Hour {
		t.Errorf("ttl = %s, want 72h", cfg.dispatchTTL)
	}
	if strings.Join(cfg.sources, ",") != "rea,domain" {
		t.Errorf("sources = %v, want split rea,domain", cfg.sources)
	}

	t.Setenv("HOUSING_INGEST_DISPATCH_TTL", "6h")
	if cfg, _ = loadServerEnqueueConfig(); cfg.dispatchTTL != 6*time.Hour {
		t.Errorf("ttl override = %s, want 6h", cfg.dispatchTTL)
	}

	// A combined "both" job is refused by the ledger's source CHECK, so refuse it here.
	t.Setenv("CRAWL_ENQUEUE_SOURCE", "both")
	if _, err := loadServerEnqueueConfig(); err == nil {
		t.Error(`CRAWL_ENQUEUE_SOURCE=both must be refused for server-enqueue`)
	}
	t.Setenv("CRAWL_ENQUEUE_SOURCE", "rea")
	t.Setenv("HOUSING_INGEST_DISPATCH_TTL", "-1h")
	if _, err := loadServerEnqueueConfig(); err == nil {
		t.Error("a non-positive dispatch TTL must be refused")
	}
	t.Setenv("HOUSING_INGEST_DISPATCH_TTL", "")
	t.Setenv("BRANDBRAIN_AGENT_URL", "")
	if _, err := loadServerEnqueueConfig(); err == nil {
		t.Error("BRANDBRAIN_AGENT_URL must be required")
	}
}

func TestServerRunID_IsUTCAndSelectionScoped(t *testing.T) {
	now := time.Date(2026, 10, 27, 0, 5, 9, 0, time.FixedZone("AEDT", 11*3600))
	if got := serverRunID("delta", now); got != "delta-20261026T130509Z" {
		t.Fatalf("run id = %q, want the UTC timestamp under the selection", got)
	}
	if serverRunID("full", now) == serverRunID("delta", now) {
		t.Fatal("full and delta runs must not share a run id")
	}
}

// TestEnqueueJSONContract pins the request body to BrandBrain's {"jobs":[...]} shape,
// with the state and source fields the enqueue dedupes on.
func TestEnqueueJSONContract(t *testing.T) {
	var body struct {
		Jobs []map[string]any `json:"jobs"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"enqueued":0,"job_ids":[],"targets":[]}`))
	}))
	defer srv.Close()

	c := newBrandbrainIDTokenClient(srv.URL, testIDTokens())
	_, _ = c.enqueueTargets(context.Background(), []crawlEnqueueInput{{Kind: "housing", Suburb: "St Kilda", State: "VIC", Postcode: "3182", Source: "rea", Tier: "listings"}})
	if len(body.Jobs) != 1 {
		t.Fatalf("jobs = %v, want one", body.Jobs)
	}
	job := body.Jobs[0]
	for key, want := range map[string]string{"kind": "housing", "suburb": "St Kilda", "state": "VIC", "postcode": "3182", "source": "rea", "tier": "listings"} {
		if job[key] != want {
			t.Errorf("job[%q] = %v, want %q", key, job[key], want)
		}
	}
}
