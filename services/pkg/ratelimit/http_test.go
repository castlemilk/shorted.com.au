package ratelimit

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// countingLimiter allows the first `allow` checks and rejects the rest, so a
// test can assert exactly how many UNITS a request consumed rather than merely
// whether it was allowed.
type countingLimiter struct {
	checks atomic.Int32
	allow  int32
	err    error
	seenID atomic.Value // string
	tier   atomic.Value // string
}

func (l *countingLimiter) Check(_ context.Context, identifier, tier string, isBrowser bool) (*Result, error) {
	if l.err != nil {
		return nil, l.err
	}
	l.seenID.Store(identifier)
	l.tier.Store(tier)
	n := l.checks.Add(1)
	if n > l.allow {
		return &Result{
			Allowed:      false,
			ExceededKind: LimitKindPerMinute,
			Tier:         tier,
			IsBrowser:    isBrowser,
			Limit:        int(l.allow),
			ResetAt:      time.Now().Add(30 * time.Second),
			RetryAfter:   30 * time.Second,
		}, nil
	}
	return &Result{
		Allowed:   true,
		Tier:      tier,
		IsBrowser: isBrowser,
		Limit:     int(l.allow),
		Remaining: int(l.allow - n),
		ResetAt:   time.Now().Add(30 * time.Second),
	}, nil
}

func (l *countingLimiter) Close() error { return nil }

func enabledConfig() Config {
	return Config{Enabled: true, UpgradeURL: "https://shorted.com.au/pricing"}
}

func byIP(r *http.Request) Caller {
	return Caller{Identifier: "test:" + ClientIP(r), Tier: "anonymous"}
}

func okHandler(served *atomic.Int32) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		served.Add(1)
		w.WriteHeader(http.StatusOK)
	})
}

func do(h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

func request() *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader("{}"))
	r.RemoteAddr = "203.0.113.9:41234"
	return r
}

func TestHTTPMiddlewareAllowsThenRejects(t *testing.T) {
	var served atomic.Int32
	limiter := &countingLimiter{allow: 2}
	h := NewHTTPMiddleware(limiter, enabledConfig(), byIP)(okHandler(&served))

	for i := 0; i < 2; i++ {
		if rec := do(h, request()); rec.Code != http.StatusOK {
			t.Fatalf("request %d: status = %d", i, rec.Code)
		}
	}
	rec := do(h, request())
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if served.Load() != 2 {
		t.Errorf("handler served %d requests, want 2", served.Load())
	}
}

// The single most important property in this file. A degraded quota store must
// never 429 or 500 a caller — that rule is why the August 2026 Upstash incident
// was survivable, and it is not conditional.
func TestHTTPMiddlewareFailsOpenWhenTheLimiterErrors(t *testing.T) {
	var served atomic.Int32
	limiter := &countingLimiter{allow: 0, err: errors.New("connection refused")}
	h := NewHTTPMiddleware(limiter, enabledConfig(), byIP)(okHandler(&served))

	rec := do(h, request())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — a sick limiter must not reject", rec.Code)
	}
	if served.Load() != 1 {
		t.Error("the handler did not run")
	}
}

func TestHTTPMiddlewareIsAPassThroughWhenDisabledOrUnwired(t *testing.T) {
	cases := map[string]func(http.Handler) http.Handler{
		"disabled":    NewHTTPMiddleware(&countingLimiter{allow: 0}, Config{Enabled: false}, byIP),
		"nil limiter": NewHTTPMiddleware(nil, enabledConfig(), byIP),
		"no identity": NewHTTPMiddleware(&countingLimiter{allow: 0}, enabledConfig(), nil),
	}
	for name, mw := range cases {
		t.Run(name, func(t *testing.T) {
			var served atomic.Int32
			if rec := do(mw(okHandler(&served)), request()); rec.Code != http.StatusOK {
				t.Fatalf("status = %d", rec.Code)
			}
			if served.Load() != 1 {
				t.Error("the handler did not run")
			}
		})
	}
}

// A caller we cannot name cannot be metered. Refusing them instead would make
// an identification bug an outage.
func TestAnUnidentifiableCallerIsAllowedRatherThanRejected(t *testing.T) {
	var served atomic.Int32
	limiter := &countingLimiter{allow: 0}
	h := NewHTTPMiddleware(limiter, enabledConfig(), func(*http.Request) Caller {
		return Caller{}
	})(okHandler(&served))

	if rec := do(h, request()); rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if limiter.checks.Load() != 0 {
		t.Error("an unidentified caller consumed quota")
	}
}

// ------------------------------------------------------------------ cost

func TestCostZeroSkipsTheCheckEntirely(t *testing.T) {
	var served atomic.Int32
	limiter := &countingLimiter{allow: 0}
	h := NewHTTPMiddleware(limiter, enabledConfig(), byIP,
		WithCost(func(*http.Request) int { return 0 }),
	)(okHandler(&served))

	if rec := do(h, request()); rec.Code != http.StatusOK {
		t.Fatalf("status = %d — a zero-cost request must not be limited", rec.Code)
	}
	if limiter.checks.Load() != 0 {
		t.Errorf("checks = %d, want 0", limiter.checks.Load())
	}
}

// A batch of N charges N. Otherwise batching is the way around the limit.
func TestCostGreaterThanOneChargesEachUnit(t *testing.T) {
	var served atomic.Int32
	limiter := &countingLimiter{allow: 10}
	h := NewHTTPMiddleware(limiter, enabledConfig(), byIP,
		WithCost(func(*http.Request) int { return 5 }),
	)(okHandler(&served))

	if rec := do(h, request()); rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if limiter.checks.Load() != 5 {
		t.Errorf("checks = %d, want 5", limiter.checks.Load())
	}
}

// The check stops at the first rejection rather than charging the rest of a
// batch that will never be served.
func TestARejectedBatchStopsChargingAtTheRejection(t *testing.T) {
	var served atomic.Int32
	limiter := &countingLimiter{allow: 2}
	h := NewHTTPMiddleware(limiter, enabledConfig(), byIP,
		WithCost(func(*http.Request) int { return 5 }),
	)(okHandler(&served))

	if rec := do(h, request()); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if limiter.checks.Load() != 3 {
		t.Errorf("checks = %d, want 3 (two allowed, one rejected)", limiter.checks.Load())
	}
	if served.Load() != 0 {
		t.Error("a rejected batch reached the handler")
	}
}

// -------------------------------------------------------------- the contract

func TestTheRejectionCarriesTheDocumentedPayload(t *testing.T) {
	limiter := &countingLimiter{allow: 0}
	var served atomic.Int32
	h := NewHTTPMiddleware(limiter, enabledConfig(), byIP)(okHandler(&served))
	rec := do(h, request())

	// The compact JSON header is the primary form, and the only one a
	// non-Connect HTTP client gets.
	raw := rec.Header().Get(headerDetail)
	if raw == "" {
		t.Fatal("no X-RateLimit-Detail header")
	}
	var detail RateLimitDetail
	if err := json.Unmarshal([]byte(raw), &detail); err != nil {
		t.Fatalf("detail is not JSON: %v", err)
	}
	if detail.Kind != LimitKindPerMinute {
		t.Errorf("kind = %q", detail.Kind)
	}
	// "api", not "browser": paid BROWSER access is unlimited and paid API
	// access is not, so this field decides whether the upgrade copy the
	// frontend renders is a promise we can keep.
	if detail.Access != "api" {
		t.Errorf("access = %q, want api", detail.Access)
	}
	if detail.UpgradeURL == "" || detail.Message == "" {
		t.Errorf("detail is not actionable: %+v", detail)
	}
	// Mirrored individually so a plain curl needs no parser.
	if rec.Header().Get(headerRetryAfter) == "" {
		t.Error("no Retry-After")
	}
	if rec.Header().Get(headerTier) != "anonymous" {
		t.Errorf("X-RateLimit-Tier = %q", rec.Header().Get(headerTier))
	}
	if got := rec.Header().Get(headerAccess); got != "api" {
		t.Errorf("X-RateLimit-Access = %q", got)
	}
}

func TestAnAllowedResponseStatesTheRemainingQuota(t *testing.T) {
	var served atomic.Int32
	limiter := &countingLimiter{allow: 10}
	h := NewHTTPMiddleware(limiter, enabledConfig(), byIP)(okHandler(&served))
	rec := do(h, request())

	if rec.Header().Get(headerLimit) != "10" {
		t.Errorf("X-RateLimit-Limit = %q", rec.Header().Get(headerLimit))
	}
	// An allowed response must not carry rejection fields; an empty
	// X-RateLimit-Kind on a 200 is noise a client would have to special-case.
	if rec.Header().Get(headerKind) != "" {
		t.Errorf("X-RateLimit-Kind is set on an allowed response: %q", rec.Header().Get(headerKind))
	}
	if rec.Header().Get(headerUpgradeURL) != "" {
		t.Error("an allowed response advertises an upgrade URL")
	}
}

func TestWithRejectionReplacesTheResponseBody(t *testing.T) {
	var served atomic.Int32
	limiter := &countingLimiter{allow: 0}
	called := false
	h := NewHTTPMiddleware(limiter, enabledConfig(), byIP,
		WithRejection(func(w http.ResponseWriter, _ *http.Request, _ *Result, d RateLimitDetail) {
			called = true
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0"}`))
			if d.Message == "" {
				t.Error("the custom rejection was handed an empty detail")
			}
		}),
	)(okHandler(&served))

	rec := do(h, request())
	if !called {
		t.Fatal("the custom rejection was not used")
	}
	if !strings.Contains(rec.Body.String(), "jsonrpc") {
		t.Errorf("body = %s", rec.Body.String())
	}
}

// ---------------------------------------------------------------- client IP

// Rightmost, not leftmost: a proxy APPENDS what it saw, so the last entry is
// the only one the client could not have written. Taking the leftmost lets any
// caller choose their own bucket by prepending a header.
func TestClientIPTakesTheRightmostForwardedAddress(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 203.0.113.9")
	if got := ClientIP(r); got != "203.0.113.9" {
		t.Errorf("ClientIP = %q, want the proxy-appended address", got)
	}
}

// Client-settable headers are no longer a fallback, and that is the point.
//
// X-Real-IP and a bare CF-Connecting-IP used to be consulted ahead of the peer
// address. Nothing in this topology sets X-Real-IP, and Cloud Run is publicly
// reachable, so both amounted to "tell us which bucket to meter you in" — a
// caller could get a fresh allowance per request by varying a header. They are
// believed ONLY when the rightmost hop proves the request came through our own
// Cloudflare edge (see client_ip_test.go), where a client cannot write them.
func TestClientSettableHeadersDoNotChooseTheBucket(t *testing.T) {
	cases := []struct {
		name   string
		set    func(*http.Request)
		remote string
		want   string
	}{
		{"X-Real-IP is ignored", func(r *http.Request) { r.Header.Set("X-Real-IP", "198.51.100.7") }, "192.0.2.5:9999", "192.0.2.5"},
		{"a bare CF-Connecting-IP is ignored", func(r *http.Request) { r.Header.Set("CF-Connecting-IP", "198.51.100.8") }, "192.0.2.5:9999", "192.0.2.5"},
		{"RemoteAddr", func(*http.Request) {}, "192.0.2.5:9999", "192.0.2.5"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/mcp", nil)
			if tc.remote != "" {
				r.RemoteAddr = tc.remote
			}
			tc.set(r)
			if got := ClientIP(r); got != tc.want {
				t.Errorf("ClientIP = %q, want %q", got, tc.want)
			}
		})
	}
}
