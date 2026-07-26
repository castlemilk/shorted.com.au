package houseprices

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

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

	f, err := newGatewayFetcher(crawlConfig{gatewayURL: srv.URL, gatewayToken: "sekret", fetchTimeout: 5 * time.Second})
	if err != nil {
		t.Fatalf("newGatewayFetcher: %v", err)
	}
	defer f.Close()
	html, finalURL, err := f.fetch(context.Background(), "https://www.realestate.com.au/buy/in-bondi/list-1")
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
	f, _ := newGatewayFetcher(crawlConfig{gatewayURL: srv.URL, fetchTimeout: 5 * time.Second})
	_, _, err := f.fetch(context.Background(), "https://x")
	if !errors.Is(err, errGatewayNeedsRewarm) {
		t.Errorf("want errGatewayNeedsRewarm, got %v", err)
	}
}

// TestGatewayFetcher_BadTokenError exercises the 401 branch: a wrong token
// yields an "unauthorized" gateway error, which is a GENERIC error (neither a
// rewarm nor a block signal), and no HTML.
func TestGatewayFetcher_BadTokenError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sekret" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"kind":"unauthorized","message":"bad token"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"html":"<html>ok</html>","final_url":"https://x"}`))
	}))
	defer srv.Close()
	f, _ := newGatewayFetcher(crawlConfig{gatewayURL: srv.URL, gatewayToken: "wrong", fetchTimeout: 5 * time.Second})
	html, _, err := f.fetch(context.Background(), "https://x")
	if err == nil {
		t.Fatalf("want a non-nil error for bad token")
	}
	if errors.Is(err, errGatewayNeedsRewarm) {
		t.Errorf("bad token must NOT map to errGatewayNeedsRewarm, got %v", err)
	}
	if errors.Is(err, errGatewayBlocked) {
		t.Errorf("bad token must NOT map to errGatewayBlocked, got %v", err)
	}
	if len(html) != 0 {
		t.Errorf("want empty html on unauthorized, got %q", html)
	}
}

// TestGatewayFetcher_BlockedSignal covers both ways the gateway can report an
// anti-bot block: the top-level "blocked":true flag and an error.kind=="blocked".
// Both map to errGatewayBlocked but STILL return the block-page HTML+finalURL so
// a caller could inspect it.
func TestGatewayFetcher_BlockedSignal(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{"blocked flag", `{"blocked":true,"html":"<blockpage>","final_url":"https://x"}`},
		{"error kind blocked", `{"error":{"kind":"blocked","message":"poison"},"html":"<blockpage>","final_url":"https://x"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(c.body))
			}))
			defer srv.Close()
			f, _ := newGatewayFetcher(crawlConfig{gatewayURL: srv.URL, fetchTimeout: 5 * time.Second})
			html, finalURL, err := f.fetch(context.Background(), "https://x")
			if !errors.Is(err, errGatewayBlocked) {
				t.Errorf("want errGatewayBlocked, got %v", err)
			}
			if string(html) != "<blockpage>" || finalURL != "https://x" {
				t.Errorf("want block-page html+finalURL preserved, got html=%q finalURL=%q", html, finalURL)
			}
		})
	}
}

// TestGatewayFetcher_GenericErrorReturnsPartialHTML confirms a non-block,
// non-rewarm gateway error still surfaces the partial HTML+finalURL alongside a
// generic error.
func TestGatewayFetcher_GenericErrorReturnsPartialHTML(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"html":"<poison>","final_url":"https://y","error":{"kind":"timeout","message":"slow"}}`))
	}))
	defer srv.Close()
	f, _ := newGatewayFetcher(crawlConfig{gatewayURL: srv.URL, fetchTimeout: 5 * time.Second})
	html, finalURL, err := f.fetch(context.Background(), "https://y")
	if err == nil {
		t.Fatalf("want a non-nil generic error")
	}
	if string(html) != "<poison>" || finalURL != "https://y" {
		t.Errorf("want partial html+finalURL preserved, got html=%q finalURL=%q", html, finalURL)
	}
}

// TestGatewayFetcher_SendsWaitMS confirms the configured gatewayWaitMS is sent
// in the POST body's wait_ms field.
func TestGatewayFetcher_SendsWaitMS(t *testing.T) {
	var gotWaitMS int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			URL    string `json:"url"`
			WaitMS int    `json:"wait_ms"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotWaitMS = req.WaitMS
		_, _ = w.Write([]byte(`{"html":"<ok>","final_url":"https://x"}`))
	}))
	defer srv.Close()
	f, _ := newGatewayFetcher(crawlConfig{gatewayURL: srv.URL, gatewayWaitMS: 1234, fetchTimeout: 5 * time.Second})
	if _, _, err := f.fetch(context.Background(), "https://x"); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if gotWaitMS != 1234 {
		t.Errorf("server saw wait_ms=%d, want 1234", gotWaitMS)
	}
}

// errOnlyFetcher is a minimal htmlFetcher stub that always returns a fixed
// error and no HTML — used to exercise fetchAndClassify's error-classification
// branch (crawl_listings.go) in isolation, without a real gateway/browser.
type errOnlyFetcher struct{ err error }

func (e *errOnlyFetcher) fetch(_ context.Context, _ string) ([]byte, string, error) {
	return nil, "", e.err
}

func (e *errOnlyFetcher) Close() {}

// TestIsBlockError_GatewaySentinels confirms isBlockError (crawl_playwright.go)
// treats BOTH gateway sentinel errors as blocks — this is what trips the
// per-site circuit breaker (reaBlocks/domBlocks -> needsRewarm -> exit-3) for
// gateway-reported anti-bot signals, on top of the existing string-matched
// browser-navigation heuristics.
func TestIsBlockError_GatewaySentinels(t *testing.T) {
	if !isBlockError(errGatewayBlocked) {
		t.Errorf("isBlockError(errGatewayBlocked) = false, want true")
	}
	if !isBlockError(errGatewayNeedsRewarm) {
		t.Errorf("isBlockError(errGatewayNeedsRewarm) = false, want true")
	}
	if isBlockError(errors.New("some transient timeout")) {
		t.Errorf("isBlockError(transient) = true, want false")
	}
	if isBlockError(nil) {
		t.Errorf("isBlockError(nil) = true, want false")
	}
	if !isBlockError(fmt.Errorf("wrapped: %w", errGatewayBlocked)) {
		t.Errorf("isBlockError(wrapped errGatewayBlocked) = false, want true (errors.Is must unwrap)")
	}
}

// TestFetchAndClassify_GatewaySentinelsBlock confirms the listings crawl path
// (crawl_listings.go fetchAndClassify) maps both gateway sentinels to
// outcomeBlocked via isBlockError — same classification the medians path
// (crawl.go fetchPage) shares, since both call the one isBlockError function.
func TestFetchAndClassify_GatewaySentinelsBlock(t *testing.T) {
	for _, sentinel := range []error{errGatewayNeedsRewarm, errGatewayBlocked} {
		_, _, outcome := fetchAndClassify(context.Background(), &errOnlyFetcher{err: sentinel}, "https://x")
		if outcome != outcomeBlocked {
			t.Errorf("fetchAndClassify(err=%v) outcome = %v, want outcomeBlocked", sentinel, outcome)
		}
	}
}
