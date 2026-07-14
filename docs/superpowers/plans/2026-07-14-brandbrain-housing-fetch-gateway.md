# Housing Crawl via brandbrain Residential Fetch Gateway — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the shorted housing crawl fetch REA/Domain from the residential Mac by POSTing each URL to a new authenticated fetch endpoint on brandbrain's macOS agent, which drives a warm host Chrome over CDP and returns raw HTML; shorted does all extraction + storage.

**Architecture:** Three repos, one wire contract. `~/projects/stealth` supplies the fetch engine (CDP-attach lever at `engine.Options.DebuggerURL`). `~/projects/brandbrain` `backend/cmd/agent` gains `POST /gateway/v1/fetch {url}→{html}` (mirrors the existing `diag.go` local server + bearer auth). `~/projects/shorted` `services/house-price-collector` gains a `gatewayFetcher` implementing the existing `htmlFetcher` interface — a drop-in third branch of `newCrawlFetcher`. Everything downstream in shorted (extraction, poison gate, delist safety, Supabase writes, MV refresh) is unchanged.

**Tech Stack:** Go (all three repos), `net/http`, `github.com/skunkworq/stealth/brws/engine` (+ `/stealth`), chromedp (CDP), pgx. Spec: `docs/superpowers/specs/2026-07-14-brandbrain-housing-fetch-gateway-design.md`.

**Repo roots (absolute):**
- shorted: `/Users/benebsworth/projects/shorted`
- brandbrain: `/Users/benebsworth/projects/brandbrain` (Go under `backend/`)
- stealth: `/Users/benebsworth/projects/stealth`

**Cross-repo discipline:** brandbrain auto-deploys its *API* on merge to main, and its agent ships via Sparkle app builds — so all brandbrain/stealth work happens in a **git worktree off `origin/main`** and lands as a **draft PR**. Nothing merges until P0 passes and the operator has reviewed. The shorted side is inert until `CRAWL_GATEWAY_URL` is set, so it can merge independently.

---

## Phase 0 — Spike (GO/NO-GO gate; do first)

Purpose: prove (a) a warm host Chrome reached over CDP actually returns real (non-poison) REA/Domain search HTML from the residential IP, and (b) which stealth API to use for CDP-attach. Everything else is gated on this. Throwaway code — not committed to main.

### Task 0: Warm-Chrome CDP fetch spike

**Files:**
- Create (throwaway, in the stealth worktree): `/Users/benebsworth/projects/stealth/cmd/spike-cdp-fetch/main.go`

- [ ] **Step 1: Operator warms a dedicated Chrome profile**

Run (in a normal terminal, not the agent):
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.shorted-crawl-chrome" &
```
Then manually browse to `https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1` and `https://www.domain.com.au/sale/bondi-nsw-2026/` in that window, solve any challenge, and leave it open. This is the "operator-cleared warm profile".

- [ ] **Step 2: Write the spike program**

Confirm the CDP-attach seam first (read, don't guess):
```bash
sed -n '180,200p' /Users/benebsworth/projects/stealth/brws/engine/engine.go   # Options{ProfileDir,UserDataDir,DebuggerURL}
sed -n '30,70p'   /Users/benebsworth/projects/stealth/brws/engine/chromium/chromium.go  # DebuggerURL -> NewRemoteAllocator
```

`/Users/benebsworth/projects/stealth/cmd/spike-cdp-fetch/main.go`:
```go
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/skunkworq/stealth/brws/engine"
	_ "github.com/skunkworq/stealth/brws/engine/chromium" // register "chromium"
)

// Throwaway: attach to a warm host Chrome over CDP and fetch REA/Domain.
func main() {
	cdp := os.Getenv("CDP_URL") // http://127.0.0.1:9222
	if cdp == "" {
		cdp = "http://127.0.0.1:9222"
	}
	eng, err := engine.New("chromium", engine.Options{
		DebuggerURL: cdp,
		Headless:    false, // attaching to a headed host Chrome
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "engine.New:", err)
		os.Exit(1)
	}
	for _, u := range os.Args[1:] {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		resp, err := eng.Do(ctx, &engine.Request{URL: u})
		cancel()
		if err != nil {
			fmt.Printf("FETCH ERR %s: %v\n", u, err)
			continue
		}
		body := resp.Body
		fmt.Printf("OK %s -> status=%d finalURL=%s bytes=%d\n", u, resp.Status, resp.FinalURL, len(body))
		// Poison/block signal check: dump first 400 chars + look for the listing JSON blob.
		head := string(body)
		if len(head) > 400 {
			head = head[:400]
		}
		fmt.Println("HEAD:", head)
		fmt.Println("has_ArgonautExchange:", containsAny(body, "ArgonautExchange"), "has_NEXT_DATA:", containsAny(body, "__NEXT_DATA__"), "kasada_wall:", containsAny(body, "Please enable JavaScript and cookies"))
	}
}

func containsAny(b []byte, s string) bool { return len(b) > 0 && bytesContains(b, s) }
func bytesContains(b []byte, s string) bool {
	return len(s) == 0 || (len(b) >= len(s) && indexOf(b, s) >= 0)
}
func indexOf(b []byte, s string) int {
	for i := 0; i+len(s) <= len(b); i++ {
		if string(b[i:i+len(s)]) == s {
			return i
		}
	}
	return -1
}
```
> NOTE: if `engine.Request`/`engine.Options` field names differ from the read in Step 2, adjust to the real struct — do not invent fields. If `engine.New`/`Do` proves too low-level (no challenge-settle), fall back to the high-level `stealth.NewWithConfig` and add a `DebuggerURL` field to `stealth.Config`+`SessionConfig` that maps into the engine Options — record which path worked; **later tasks depend on the answer.**

- [ ] **Step 3: Run the spike against both portals**

Run:
```bash
cd /Users/benebsworth/projects/stealth
go run ./cmd/spike-cdp-fetch \
  "https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1" \
  "https://www.domain.com.au/sale/bondi-nsw-2026/"
```
Expected (GO): `has_ArgonautExchange: true` for REA and/or `has_NEXT_DATA: true` for Domain, `kasada_wall: false`, `status=200`, bytes > 200 KB.
Expected (NO-GO): `kasada_wall: true` or tiny body / status 403 → **stop**; the warm-Chrome approach doesn't beat the wall from this IP. Report to the user before building the gateway.

- [ ] **Step 4: Record the outcome + the confirmed API**

Write a 5-line note in the PR/worktree: GO or NO-GO, the exact stealth API used (`engine.New`+`Do` vs `stealth.Config.DebuggerURL`), and any field-name corrections. Delete `cmd/spike-cdp-fetch` (throwaway) once recorded. Later tasks reference "the P0-confirmed fetch seam".

---

## Phase 1 — shorted: gateway fetcher (mergeable independently, inert until configured)

### Task 1: Add gateway config + fetcher-mode selection

**Files:**
- Modify: `/Users/benebsworth/projects/shorted/services/house-price-collector/crawl.go` (`fetcherMode` enum ~47-55, `selectFetcherMode` ~60-65, `crawlConfig` ~84-105, `loadCrawlConfig` ~107-127, `newCrawlFetcher` ~77-82)
- Test: `/Users/benebsworth/projects/shorted/services/house-price-collector/crawl_gateway_test.go`

- [ ] **Step 1: Write the failing test for selection precedence**

`crawl_gateway_test.go`:
```go
package main

import "testing"

func TestSelectFetcherMode_GatewayPrecedence(t *testing.T) {
	cases := []struct {
		name string
		cfg  crawlConfig
		want fetcherMode
	}{
		{"gateway url set wins over cdp", crawlConfig{gatewayURL: "http://mac:7799", cdpURL: "http://host:9222"}, fetcherModeGateway},
		{"cdp when only cdp", crawlConfig{cdpURL: "http://host:9222"}, fetcherModeCDP},
		{"playwright when neither", crawlConfig{}, fetcherModePlaywright},
		{"explicit override to cdp", crawlConfig{fetchModeOverride: "cdp", gatewayURL: "http://mac:7799"}, fetcherModeCDP},
	}
	for _, c := range cases {
		if got := selectFetcherMode(c.cfg); got != c.want {
			t.Errorf("%s: selectFetcherMode = %v, want %v", c.name, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/benebsworth/projects/shorted/services/house-price-collector && go test -run TestSelectFetcherMode_GatewayPrecedence`
Expected: FAIL — `fetcherModeGateway` undefined, `crawlConfig` has no `gatewayURL`/`fetchModeOverride`.

- [ ] **Step 3: Add the enum value, config fields, loader, and precedence**

In `crawl.go`, add to the `fetcherMode` const block (after `fetcherModeCDP`):
```go
	// fetcherModeGateway POSTs each URL to a brandbrain macOS-agent residential
	// fetch gateway (CRAWL_GATEWAY_URL), which drives a warm host Chrome and
	// returns HTML. No browser in this process; residential egress is the agent's.
	fetcherModeGateway
```
Add to `crawlConfig`:
```go
	gatewayURL        string // CRAWL_GATEWAY_URL  e.g. http://<mac-lan-ip>:7799
	gatewayToken      string // CRAWL_GATEWAY_TOKEN
	gatewayWaitMS     int    // CRAWL_GATEWAY_WAIT_MS (challenge-settle budget)
	fetchModeOverride string // CRAWL_FETCH_MODE = gateway|cdp|playwright (optional)
```
Add to `loadCrawlConfig`:
```go
		gatewayURL:        os.Getenv("CRAWL_GATEWAY_URL"),
		gatewayToken:      os.Getenv("CRAWL_GATEWAY_TOKEN"),
		gatewayWaitMS:     envInt("CRAWL_GATEWAY_WAIT_MS", 8000),
		fetchModeOverride: os.Getenv("CRAWL_FETCH_MODE"),
```
Replace `selectFetcherMode`:
```go
func selectFetcherMode(cfg crawlConfig) fetcherMode {
	switch cfg.fetchModeOverride {
	case "gateway":
		return fetcherModeGateway
	case "cdp":
		return fetcherModeCDP
	case "playwright":
		return fetcherModePlaywright
	}
	if cfg.gatewayURL != "" {
		return fetcherModeGateway
	}
	if cfg.cdpURL != "" {
		return fetcherModeCDP
	}
	return fetcherModePlaywright
}
```
Extend `crawlFetcherMode` to name the gateway (`"gateway-residential"`), and `newCrawlFetcher`:
```go
func newCrawlFetcher(cfg crawlConfig) (crawlFetcher, error) {
	switch selectFetcherMode(cfg) {
	case fetcherModeGateway:
		return newGatewayFetcher(cfg)
	case fetcherModeCDP:
		return newCDPFetcher(cfg)
	default:
		return newPlaywrightFetcher(cfg)
	}
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `go test -run TestSelectFetcherMode_GatewayPrecedence` — Expected: PASS (will not compile until Task 2 adds `newGatewayFetcher`; if so, do Task 2 first then re-run — they commit together).

- [ ] **Step 5: Commit** (after Task 2 compiles)
```bash
git add services/house-price-collector/crawl.go services/house-price-collector/crawl_gateway.go services/house-price-collector/crawl_gateway_test.go
git commit -m "feat(house-crawl): gateway fetcher mode + selection precedence"
```

### Task 2: Implement the gatewayFetcher (htmlFetcher over HTTP)

**Files:**
- Create: `/Users/benebsworth/projects/shorted/services/house-price-collector/crawl_gateway.go`
- Test: `/Users/benebsworth/projects/shorted/services/house-price-collector/crawl_gateway_test.go` (append)

- [ ] **Step 1: Write the failing test against an httptest fake gateway**

Append to `crawl_gateway_test.go`:
```go
import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGatewayFetcher_Fetch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sekret" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"kind":"unauthorized","message":"bad token"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"html":"<html>bondi</html>","final_url":"https://x/final","http_status":200,"blocked":false}`))
	}))
	defer srv.Close()

	f, err := newGatewayFetcher(crawlConfig{gatewayURL: srv.URL, gatewayToken: "sekret", fetchTimeout: 5 * 1e9})
	if err != nil {
		t.Fatalf("newGatewayFetcher: %v", err)
	}
	defer f.Close()
	html, finalURL, err := f.fetch(t.Context(), "https://www.realestate.com.au/buy/in-bondi/list-1")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if string(html) != "<html>bondi</html>" || finalURL != "https://x/final" {
		t.Errorf("got html=%q finalURL=%q", html, finalURL)
	}
}

func TestGatewayFetcher_NeedsRewarmError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":{"kind":"needs_rewarm","message":"clearance expired"}}`))
	}))
	defer srv.Close()
	f, _ := newGatewayFetcher(crawlConfig{gatewayURL: srv.URL, fetchTimeout: 5 * 1e9})
	_, _, err := f.fetch(t.Context(), "https://x")
	if !errors.Is(err, errGatewayNeedsRewarm) {
		t.Errorf("want errGatewayNeedsRewarm, got %v", err)
	}
}
```
> If the toolchain predates `t.Context()`, use `context.Background()`.

- [ ] **Step 2: Run to verify it fails** — Run: `go test -run TestGatewayFetcher` — Expected: FAIL — `newGatewayFetcher`/`errGatewayNeedsRewarm` undefined.

- [ ] **Step 3: Write `crawl_gateway.go`**
```go
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// errGatewayNeedsRewarm signals the agent's warm Chrome lost its anti-bot
// clearance; callers map it to the existing exit-code-3 rewarm alert.
var errGatewayNeedsRewarm = errors.New("gateway: warm chrome needs rewarm")

// gatewayFetcher implements htmlFetcher by POSTing each URL to a brandbrain
// macOS-agent residential fetch gateway. It owns no browser.
type gatewayFetcher struct {
	baseURL string
	token   string
	waitMS  int
	client  *http.Client
}

func newGatewayFetcher(cfg crawlConfig) (*gatewayFetcher, error) {
	if cfg.gatewayURL == "" {
		return nil, fmt.Errorf("gateway fetcher requires CRAWL_GATEWAY_URL")
	}
	to := cfg.fetchTimeout
	if to <= 0 {
		to = 60 * time.Second
	}
	return &gatewayFetcher{
		baseURL: strings.TrimRight(cfg.gatewayURL, "/"),
		token:   cfg.gatewayToken,
		waitMS:  cfg.gatewayWaitMS,
		client:  &http.Client{Timeout: to + 20*time.Second},
	}, nil
}

type gatewayFetchReq struct {
	URL    string `json:"url"`
	WaitMS int    `json:"wait_ms,omitempty"`
}

type gatewayFetchResp struct {
	HTML       string `json:"html"`
	FinalURL   string `json:"final_url"`
	HTTPStatus int    `json:"http_status"`
	Blocked    bool   `json:"blocked"`
	Error      *struct {
		Kind    string `json:"kind"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (g *gatewayFetcher) fetch(ctx context.Context, url string) ([]byte, string, error) {
	body, _ := json.Marshal(gatewayFetchReq{URL: url, WaitMS: g.waitMS})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.baseURL+"/gateway/v1/fetch", bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if g.token != "" {
		req.Header.Set("Authorization", "Bearer "+g.token)
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("gateway fetch %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	var gr gatewayFetchResp
	if err := json.Unmarshal(raw, &gr); err != nil {
		return nil, "", fmt.Errorf("gateway decode (http %d): %w", resp.StatusCode, err)
	}
	if gr.Error != nil {
		if gr.Error.Kind == "needs_rewarm" {
			return nil, "", errGatewayNeedsRewarm
		}
		// Blocked: hand back whatever HTML we got (may be empty) so the caller's
		// looksBlocked + circuit breaker classify it exactly like the CDP path.
		return []byte(gr.HTML), gr.FinalURL, fmt.Errorf("gateway error [%s]: %s", gr.Error.Kind, gr.Error.Message)
	}
	return []byte(gr.HTML), gr.FinalURL, nil
}

func (g *gatewayFetcher) Close() {}
```

- [ ] **Step 4: Run to verify it passes** — Run: `go test -run TestGatewayFetcher -v` — Expected: PASS both.

- [ ] **Step 5: Commit** — commit with Task 1 (see Task 1 Step 5).

### Task 3: Thread needs-rewarm through the listings/crawl loops

**Files:**
- Read first: `crawl_listings.go:360-380` (`fetchAndClassify`), `crawl.go:216-250` (`runCrawl` breaker → rewarm), `crawl_listings.go` rewarm return.
- Modify: whichever of `fetchAndClassify` / the crawl loop maps a fetch error to an outcome, so `errGatewayNeedsRewarm` trips the rewarm path (exit 3) rather than a generic error.
- Test: `crawl_gateway_test.go` (append)

- [ ] **Step 1: Write a failing test that a needs-rewarm fetch yields a rewarm outcome**
```go
func TestFetchAndClassify_NeedsRewarmTripsRewarm(t *testing.T) {
	f := &stubFetcher{err: errGatewayNeedsRewarm}
	_, _, outcome := fetchAndClassify(t.Context(), f, "https://x")
	if outcome != outcomeBlocked { // blocked feeds the circuit breaker -> rewarm
		t.Errorf("outcome = %v, want outcomeBlocked", outcome)
	}
}

type stubFetcher struct{ err error; html []byte }
func (s *stubFetcher) fetch(ctx context.Context, url string) ([]byte, string, error) { return s.html, url, s.err }
```

- [ ] **Step 2: Run to verify it fails** — `go test -run TestFetchAndClassify_NeedsRewarm` — Expected: FAIL (a raw error currently maps to `outcomeError`, not `outcomeBlocked`).

- [ ] **Step 3: In `fetchAndClassify`, treat `errGatewayNeedsRewarm` as a block**

At the top of `fetchAndClassify` after `f.fetch`, before the generic error branch:
```go
	if errors.Is(err, errGatewayNeedsRewarm) {
		return html, finalURL, outcomeBlocked
	}
```
Confirm the breaker in `runCrawl`/`runListings` already escalates consecutive `outcomeBlocked` to the rewarm return (`reaBlocks/domBlocks >= maxConsecBlocks`). If listings needs a direct signal, also OR `errGatewayNeedsRewarm` into its rewarm bool.

- [ ] **Step 4: Run to verify it passes** — `go test ./...` in the collector dir — Expected: PASS, no regressions in the existing 171 listings tests.

- [ ] **Step 5: Commit**
```bash
git add services/house-price-collector/crawl_listings.go services/house-price-collector/crawl_gateway_test.go
git commit -m "feat(house-crawl): map gateway needs-rewarm to the block/rewarm path"
```

---

## Phase 2 — brandbrain agent: residential fetch gateway (draft PR from worktree)

> All Phase-2 work in a worktree: `cd /Users/benebsworth/projects/brandbrain && git worktree add ../brandbrain-housing-gateway origin/main && cd ../brandbrain-housing-gateway`. Build/test with `cd backend`.

### Task 4: Gateway HTTP server + bearer auth (no fetch yet)

**Files:**
- Create: `backend/cmd/agent/gateway.go`
- Test: `backend/cmd/agent/gateway_test.go`

- [ ] **Step 1: Write the failing test (auth + method + health)**

`backend/cmd/agent/gateway_test.go`:
```go
package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGateway_AuthRequired(t *testing.T) {
	gw := &GatewayServer{token: "sekret", fetcher: stubFetch("<html/>", 200, "", nil)}
	// missing token -> 401
	rec := httptest.NewRecorder()
	gw.handleFetch(rec, httptest.NewRequest(http.MethodPost, "/gateway/v1/fetch", strings.NewReader(`{"url":"https://x"}`)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no-token: code=%d want 401", rec.Code)
	}
	// good token -> 200
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/gateway/v1/fetch", strings.NewReader(`{"url":"https://x"}`))
	req.Header.Set("Authorization", "Bearer sekret")
	gw.handleFetch(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"html":"<html/>"`) {
		t.Fatalf("good-token: code=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGateway_RefusesLANBindWithoutToken(t *testing.T) {
	_, err := StartGatewayServer(GatewayConfig{Enabled: true, Bind: "0.0.0.0:7799", Token: ""}, nil)
	if err == nil {
		t.Fatal("expected refusal to bind LAN without a token")
	}
}

// stubFetch returns a gatewayFetch func for tests.
func stubFetch(html string, status int, finalURL string, err error) gatewayFetchFunc {
	return func(ctx contextT, url string, waitMS int) (string, string, int, error) {
		return html, finalURL, status, err
	}
}
```
> `contextT` = `context.Context`; import it. Adjust the stub signature to the real `gatewayFetchFunc` you define in Step 3.

- [ ] **Step 2: Run to verify it fails** — `cd backend && go test ./cmd/agent/ -run TestGateway` — Expected: FAIL — undefined `GatewayServer`/`StartGatewayServer`/`GatewayConfig`.

- [ ] **Step 3: Write `backend/cmd/agent/gateway.go` (server + auth, fetch injected)**

Mirror the `diag.go` pattern (`net.Listen` + `srv.Serve` in a goroutine; `authorize` like `authorizeControl` at `diag.go:259-280`). The fetch is an injected func so it's testable without a browser.
```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
)

// gatewayFetchFunc fetches a URL from the warm residential browser and returns
// (html, finalURL, httpStatus, err). Injected so the server is unit-testable.
type gatewayFetchFunc func(ctx context.Context, url string, waitMS int) (string, string, int, error)

type GatewayConfig struct {
	Enabled bool
	Bind    string // e.g. "0.0.0.0:7799" (LAN) or "127.0.0.1:7799"
	Token   string
	CDPURL  string // warm host Chrome, e.g. http://127.0.0.1:9222
}

type GatewayServer struct {
	token   string
	fetcher gatewayFetchFunc
}

// StartGatewayServer binds + serves the gateway when enabled. It REFUSES to bind
// a non-loopback address without a token (no open LAN fetch proxy).
func StartGatewayServer(cfg GatewayConfig, fetcher gatewayFetchFunc) (*GatewayServer, error) {
	if !cfg.Enabled {
		return nil, nil
	}
	host := cfg.Bind
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	isLoopback := host == "127.0.0.1" || host == "localhost" || host == ""
	if !isLoopback && strings.TrimSpace(cfg.Token) == "" {
		return nil, fmt.Errorf("gateway: refusing to bind LAN address %q without GATEWAY_TOKEN", cfg.Bind)
	}
	gw := &GatewayServer{token: strings.TrimSpace(cfg.Token), fetcher: fetcher}
	mux := http.NewServeMux()
	mux.HandleFunc("/gateway/v1/fetch", gw.handleFetch)
	mux.HandleFunc("/gateway/v1/health", gw.handleHealth)
	ln, err := net.Listen("tcp", cfg.Bind)
	if err != nil {
		return nil, fmt.Errorf("gateway bind %s: %w", cfg.Bind, err)
	}
	go func() {
		log.Printf("  Residential fetch gateway: http://%s/gateway/v1/fetch", cfg.Bind)
		if err := (&http.Server{Handler: mux, ReadTimeout: 30 * time.Second, WriteTimeout: 120 * time.Second}).Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("gateway server error: %v", err)
		}
	}()
	return gw, nil
}

func (gw *GatewayServer) authorize(w http.ResponseWriter, r *http.Request) bool {
	if gw.token == "" {
		return true // loopback-only, tokenless (dev)
	}
	got := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(got), "bearer ") {
		got = strings.TrimSpace(got[7:])
	}
	if got == gw.token {
		return true
	}
	writeGatewayErr(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token")
	return false
}

func (gw *GatewayServer) handleFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeGatewayErr(w, http.StatusMethodNotAllowed, "bad_request", "POST only")
		return
	}
	if !gw.authorize(w, r) {
		return
	}
	var req struct {
		URL    string `json:"url"`
		WaitMS int    `json:"wait_ms"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.URL) == "" {
		writeGatewayErr(w, http.StatusBadRequest, "bad_request", "url required")
		return
	}
	html, finalURL, status, err := gw.fetcher(r.Context(), req.URL, req.WaitMS)
	if err != nil {
		kind := "timeout"
		if strings.Contains(err.Error(), "rewarm") {
			kind = "needs_rewarm"
		} else if strings.Contains(err.Error(), "connect") || strings.Contains(err.Error(), "debugger") {
			kind = "chrome_unreachable"
		}
		code := http.StatusBadGateway
		if kind == "needs_rewarm" {
			code = http.StatusServiceUnavailable
		}
		writeGatewayErr(w, code, kind, err.Error())
		return
	}
	// NEVER log the html body (PII/licence). Response is the only place it lives.
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"html": html, "final_url": finalURL, "http_status": status, "blocked": false,
	})
}

func (gw *GatewayServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
}

func writeGatewayErr(w http.ResponseWriter, code int, kind, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"kind": kind, "message": msg}})
}
```

- [ ] **Step 4: Run to verify it passes** — `go test ./cmd/agent/ -run TestGateway -v` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add backend/cmd/agent/gateway.go backend/cmd/agent/gateway_test.go && git commit -m "feat(agent): residential fetch gateway server + bearer auth (no fetch wiring yet)"`

### Task 5: Wire the CDP-attach fetch (uses the P0-confirmed seam)

**Files:**
- Create: `backend/cmd/agent/gateway_fetch.go`
- Test: `backend/cmd/agent/gateway_fetch_test.go` (build-tagged / skippable — needs a live Chrome)

- [ ] **Step 1: Implement the fetcher using exactly the API P0 confirmed**

If P0 used the low-level engine:
```go
package main

import (
	"context"

	"github.com/skunkworq/stealth/brws/engine"
	_ "github.com/skunkworq/stealth/brws/engine/chromium"
)

// newCDPGatewayFetcher returns a gatewayFetchFunc that fetches via a warm host
// Chrome reached over CDP. cdpURL is the warm Chrome's debugger URL.
func newCDPGatewayFetcher(cdpURL string) (gatewayFetchFunc, error) {
	eng, err := engine.New("chromium", engine.Options{DebuggerURL: cdpURL, Headless: false})
	if err != nil {
		return nil, err
	}
	return func(ctx context.Context, url string, waitMS int) (string, string, int, error) {
		resp, err := eng.Do(ctx, &engine.Request{URL: url})
		if err != nil {
			return "", "", 0, err
		}
		return string(resp.Body), resp.FinalURL, resp.Status, nil
	}, nil
}
```
> If P0 instead required a `stealth.Config.DebuggerURL` change, implement `newCDPGatewayFetcher` around `stealth.NewWithConfig`+`client.Navigate` and land the stealth-side plumbing (add `DebuggerURL` to `stealth.SessionConfig`, map it into `engine.Options` where `NewWithConfig` builds the engine — `brws/stealth/client.go:160-183`) as its own commit in the stealth worktree, re-vendor into brandbrain (`go mod vendor`). Use whichever P0 proved.

- [ ] **Step 2: Guarded live test (skipped by default)**

`gateway_fetch_test.go`:
```go
package main

import (
	"context"
	"os"
	"testing"
)

func TestCDPGatewayFetch_Live(t *testing.T) {
	cdp := os.Getenv("GATEWAY_TEST_CDP_URL")
	if cdp == "" {
		t.Skip("set GATEWAY_TEST_CDP_URL to a warm Chrome to run")
	}
	f, err := newCDPGatewayFetcher(cdp)
	if err != nil {
		t.Fatal(err)
	}
	html, _, status, err := f(context.Background(), "https://example.com", 2000)
	if err != nil || status == 0 || len(html) == 0 {
		t.Fatalf("live fetch: status=%d len=%d err=%v", status, len(html), err)
	}
}
```

- [ ] **Step 3: Run** — `go test ./cmd/agent/ -run TestCDPGatewayFetch_Live` (skips without the env) — Expected: SKIP (or PASS with a warm Chrome).

- [ ] **Step 4: Commit** — `git add backend/cmd/agent/gateway_fetch*.go && git commit -m "feat(agent): gateway CDP-attach fetch via stealth warm-chrome"`

### Task 6: Start the gateway from agent main, gated on config

**Files:**
- Read: `backend/cmd/agent/main.go` (where `StartDiagServer` is called) + `config.go` (`Config` struct, env loading).
- Modify: `backend/cmd/agent/main.go` (start the gateway when enabled), `backend/cmd/agent/config.go` (add gateway fields from env).

- [ ] **Step 1: Load gateway config from env**

In `config.go` env loading, add (defaults keep it OFF):
```go
	GatewayEnabled: os.Getenv("GATEWAY_ENABLED") == "true",
	GatewayBind:    envOr("GATEWAY_BIND", "127.0.0.1:7799"),
	GatewayToken:   os.Getenv("GATEWAY_TOKEN"),
	GatewayCDPURL:  envOr("GATEWAY_CDP_URL", "http://127.0.0.1:9222"),
```
(Add matching fields to the `Config` struct; reuse the existing `envOr`/`getenv` helper name in that file.)

- [ ] **Step 2: Start it next to the diag server in `main.go`**
```go
	if cfg.GatewayEnabled {
		fetch, ferr := newCDPGatewayFetcher(cfg.GatewayCDPURL)
		if ferr != nil {
			log.Printf("gateway: fetch init failed (%v) — gateway disabled", ferr)
		} else if _, gerr := StartGatewayServer(GatewayConfig{
			Enabled: true, Bind: cfg.GatewayBind, Token: cfg.GatewayToken, CDPURL: cfg.GatewayCDPURL,
		}, fetch); gerr != nil {
			log.Printf("gateway: start failed: %v", gerr)
		}
	}
```

- [ ] **Step 3: Build the agent** — `cd backend && go build ./cmd/agent` — Expected: builds clean.

- [ ] **Step 4: Commit + open the draft PR** — `git add backend/cmd/agent/main.go backend/cmd/agent/config.go && git commit -m "feat(agent): start residential fetch gateway when GATEWAY_ENABLED" && gh pr create --draft --title "Residential fetch gateway for housing crawl" --body "See shorted spec 2026-07-14-brandbrain-housing-fetch-gateway-design.md. Ships dark (GATEWAY_ENABLED off). Agent-app change only — not api.brandbrain.dev."`

---

## Phase 3 — End-to-end verify (listings)

### Task 7: One live suburb through the whole chain

**Files:** none (operational). Prereqs: P0 GO; brandbrain agent built from the worktree; a warm Chrome on :9222.

- [ ] **Step 1: Start the agent gateway on the Mac**
```bash
GATEWAY_ENABLED=true GATEWAY_BIND=0.0.0.0:7799 GATEWAY_TOKEN=$(openssl rand -hex 24) \
GATEWAY_CDP_URL=http://127.0.0.1:9222 ./brandbrain-agent-runtime --headless   # token: note it
curl -s -XPOST localhost:7799/gateway/v1/health   # -> {"status":"ok"}
```

- [ ] **Step 2: Dry-run the collector through the gateway (no writes)**
```bash
cd /Users/benebsworth/projects/shorted/services/house-price-collector
CRAWL_GATEWAY_URL=http://127.0.0.1:7799 CRAWL_GATEWAY_TOKEN=<token> \
CRAWL_MAX_SUBURBS=1 CRAWL_DRY_RUN=true DATABASE_URL=<local-or-staging> \
go run . -mode listings
```
Expected: logs show `gateway-residential` fetcher, a sweep classified `complete/partial`, N listings extracted, `dry-run: … NOT written`. No block/poison.

- [ ] **Step 3: Live write for one seed suburb**

Set `CRAWL_DRY_RUN=false` and a DB you own (staging or prod-with-approval). Run again. Verify (read-only):
```sql
SELECT count(*) FROM property_listings WHERE last_seen_at > now() - interval '1 hour';
SELECT event_type, count(*) FROM property_price_events GROUP BY 1;
SELECT * FROM mv_suburb_price_drops LIMIT 5;   -- after the run's MV refresh
```
Expected: `property_listings` rows for the suburb; `first_seen` events; drops MV lights up once ≥3 drops exist across runs.

- [ ] **Step 4: Confirm the UI** — load `/housing` (drops panel) locally or on staging; the `SuburbPriceDropsPanel` renders once `mv_suburb_price_drops` has rows.

- [ ] **Step 5: Record results** in the PR + update memory `property-listings-price-tracking` / `housing-residential-crawl` with "gateway path live-verified".

---

## Phase 4 — Follow-ons (lighter; after MVP is proven)

- **Suburb-median tier:** the same gateway already serves `-mode crawl` (it also builds via `newCrawlFetcher`). Verify medians land in `house_prices` (licence-gated) with one crawl run. No new code beyond confirming `-mode crawl` picks `fetcherModeGateway`.
- **Agent tray/visibility:** extend the agent `/status` (`diag.go:handleStatus`) + tray to show gateway request count / last fetch / blocked count. Nice-to-have.
- **Multi-Mac:** each Mac runs its own gateway; shorted's existing `selectTargets` sharding (`CRAWL_SHARD_INDEX/COUNT`) fans suburbs across gateways — no gateway change.
- **Cloud fallback (Option B):** if orchestration must leave the home LAN, layer the poll-based `crawl_jobs` queue (`2026-07-13-brandbrain-native-crawl-queue-design.md`) — the fetch/extract seams built here are unchanged.

---

## Self-Review

- **Spec coverage:** LAN gateway endpoint (Task 4), bearer auth + refuse-LAN-without-token (Task 4), CDP-attach warm-Chrome fetch (Task 5, P0), shorted drop-in fetcher (Tasks 1–2), needs-rewarm→exit-3 (Task 3), housing logic/PII stays in shorted (fetcher returns HTML only; gateway never logs body — Task 4/5), ships dark/gated (Task 6 defaults OFF), draft PR + agent-app deploy vector (Task 6), e2e listings (Task 7), medians + tray + cloud fallback (Phase 4). P0 spike gates anti-bot (Task 0). ✅ all spec sections mapped.
- **Placeholder scan:** the two "if P0 used X vs Y" notes in Tasks 0/5 are deliberate — the exact stealth API is genuinely unknown until P0 and both branches give concrete code + file refs. No TODO/TBD/"handle errors" left.
- **Type consistency:** `gatewayFetchFunc(ctx, url, waitMS) → (html, finalURL, httpStatus, err)` is used identically in Tasks 4/5/6; shorted `gatewayFetcher.fetch(ctx,url)→([]byte,string,error)` matches `htmlFetcher`; `errGatewayNeedsRewarm` defined in Task 2, consumed in Task 3; config fields (`gatewayURL/gatewayToken/gatewayWaitMS/fetchModeOverride`) defined in Task 1, used in Task 2. ✅
