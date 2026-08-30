package ratelimit

import (
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// HTTPMiddleware brings plain HTTP handlers under the SAME limiter the Connect
// interceptor uses.
//
// WHY THIS EXISTS. Two surfaces bypass the Connect interceptor chain entirely
// and were therefore unmetered:
//
//   - /mcp. Tools call the server's methods IN PROCESS, so no interceptor ever
//     runs. That is also why the tools are restricted to public methods.
//   - /oauth/authorize/grant, /oauth/register. Plain mux handlers, and each one
//     drives expensive work (a Firebase verification, a client registration
//     write) on behalf of an unauthenticated caller.
//
// Their only ceiling today is the tier-blind, per-colo Cloudflare bucket, which
// does not exist in local or preview at all.
//
// It is one policy, not a second one. Same RateLimiter, same tier table, same
// Postgres-backed monthly counters, same RateLimitDetail on rejection — a
// second limiter would be a second set of numbers to keep in step with the
// published entitlement table, and (given the August 2026 incident) a second
// dependency to take an outage on.
type HTTPMiddleware struct {
	limiter RateLimiter
	cfg     Config
	// identify derives who is calling. Required.
	identify func(*http.Request) Caller
	// cost says how many units this request consumes. Nil means one per
	// request; /mcp supplies one that counts TOOL CALLS in the JSON-RPC body.
	cost func(*http.Request) int
	// reject writes the refusal. Nil means the plain HTTP 429 below; /mcp
	// supplies one that writes a JSON-RPC error instead.
	reject func(http.ResponseWriter, *http.Request, *Result, RateLimitDetail)
}

// Caller is the identity a request is metered against.
//
// Access is always "api" on these surfaces, and IsBrowser is therefore always
// false: the browser column of the tier table is unlimited for paid users, and
// applying it to a programmatic surface would promise something the API column
// does not deliver. The upgrade copy the frontend renders switches on exactly
// this, so getting it wrong shows a paying API caller a promise of "unlimited"
// that is false for them.
type Caller struct {
	// Identifier is the rate-limit key, already prefixed by class:
	// "oauth:<user>", "token:<hash>", "mcp-anon:<ip>", "oauth-anon:<ip>".
	Identifier string
	// Tier is the resolved tier, or "anonymous".
	Tier string
}

// HTTPOption configures the middleware.
type HTTPOption func(*HTTPMiddleware)

// WithCost sets the per-request cost function. A cost of 0 skips the check
// entirely — that is how MCP session preamble (initialize, tools/list) is made
// free.
func WithCost(cost func(*http.Request) int) HTTPOption {
	return func(m *HTTPMiddleware) { m.cost = cost }
}

// WithRejection replaces the plain 429 writer. The detail payload is passed
// through so a protocol-specific rejection carries the same contract.
func WithRejection(reject func(http.ResponseWriter, *http.Request, *Result, RateLimitDetail)) HTTPOption {
	return func(m *HTTPMiddleware) { m.reject = reject }
}

// NewHTTPMiddleware builds the middleware. A nil limiter or a disabled config
// yields a pass-through, so callers can wire it unconditionally.
func NewHTTPMiddleware(limiter RateLimiter, cfg Config, identify func(*http.Request) Caller, opts ...HTTPOption) func(http.Handler) http.Handler {
	m := &HTTPMiddleware{limiter: limiter, cfg: cfg, identify: identify}
	for _, opt := range opts {
		opt(m)
	}
	return m.wrap
}

func (m *HTTPMiddleware) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if m.limiter == nil || !m.cfg.Enabled || m.identify == nil {
			next.ServeHTTP(w, r)
			return
		}

		units := 1
		if m.cost != nil {
			units = m.cost(r)
		}
		if units <= 0 {
			next.ServeHTTP(w, r)
			return
		}

		caller := m.identify(r)
		if caller.Identifier == "" {
			// Unidentifiable means unmeterable. Failing open here matches the
			// limiter's own posture: this layer exists to shape load, and it is
			// never the thing that decides a request is invalid.
			next.ServeHTTP(w, r)
			return
		}

		var last *Result
		for i := 0; i < units; i++ {
			result, err := m.limiter.Check(r.Context(), caller.Identifier, caller.Tier, false)
			if err != nil {
				// FAIL OPEN, unconditionally. A sick quota database must never
				// 429 or 500 a caller — that rule predates this middleware and
				// is the reason the August 2026 incident was survivable.
				log.Warnf("Rate limit check failed: %v", err)
				next.ServeHTTP(w, r)
				return
			}
			recordCheck(r.Context(), result)
			last = result
			if !result.Allowed {
				break
			}
		}
		if last == nil { // unreachable: units >= 1
			next.ServeHTTP(w, r)
			return
		}

		if !last.Allowed {
			if shortedotel.RateLimitBlocked != nil {
				shortedotel.RateLimitBlocked.Add(r.Context(), 1,
					otelmetric.WithAttributes(
						attribute.String("tier", last.Tier),
						attribute.String("kind", string(last.ExceededKind)),
					),
				)
			}
			detail := buildDetail(last, m.cfg.UpgradeURL)
			log.Infof("Rate limit exceeded for %s (tier=%s, access=api, kind=%s, path=%s)",
				redactIdentifier(caller.Identifier), last.Tier, last.ExceededKind, r.URL.Path)

			if m.reject != nil {
				m.reject(w, r, last, detail)
				return
			}
			writeHTTPRateLimitError(w, last, detail)
			return
		}

		// Success headers only — the same subset the Connect interceptor
		// emits, and NOT applyDetailHeaders, which would stamp an empty
		// X-RateLimit-Kind and Upgrade-Url onto a request that was allowed.
		writeQuotaHeaders(w.Header().Set, last)
		next.ServeHTTP(w, r)
	})
}

// writeQuotaHeaders states where the caller stands, on a response that was
// allowed. A limit of 0 means unlimited for this tier and is omitted:
// "X-RateLimit-Limit: 0" reads as "you may make zero requests".
func writeQuotaHeaders(set func(key, value string), result *Result) {
	if result.Limit > 0 {
		set(headerLimit, strconv.Itoa(result.Limit))
		set(headerRemaining, strconv.Itoa(maxInt(result.Remaining, 0)))
		set(headerReset, strconv.FormatInt(unixOrZero(result.ResetAt), 10))
	}
	if result.MonthlyLimit > 0 {
		set(headerMonthlyLimit, strconv.Itoa(result.MonthlyLimit))
		set(headerMonthlyUsed, strconv.Itoa(result.MonthlyUsed))
		set(headerMonthlyRemain, strconv.Itoa(maxInt(result.MonthlyLimit-result.MonthlyUsed, 0)))
		set(headerMonthlyReset, strconv.FormatInt(unixOrZero(result.MonthlyResetAt), 10))
	}
}

// writeHTTPRateLimitError is the plain-HTTP 429, carrying the same contract the
// Connect error carries: the compact JSON in X-RateLimit-Detail, the mirrored
// individual headers, and Retry-After.
func writeHTTPRateLimitError(w http.ResponseWriter, result *Result, detail RateLimitDetail) {
	applyDetailHeaders(w.Header().Set, result, detail)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error":   "resource_exhausted",
		"message": detail.Message,
		"detail":  detail,
	})
}

// ApplyDetailHeaders writes the full rejection header contract through a
// setter. Exported so a protocol-specific rejection (the MCP JSON-RPC error)
// carries exactly the headers the Connect and plain-HTTP rejections carry,
// rather than an approximation of them.
func ApplyDetailHeaders(set func(key, value string), result *Result, detail RateLimitDetail) {
	applyDetailHeaders(set, result, detail)
}

// ClientIP extracts the client IP from an http.Request with the SAME
// precedence the Connect interceptor uses, including the rightmost-XFF rule.
//
// Rightmost, not leftmost: a proxy APPENDS the address it saw, so the last
// entry is the only one a client could not have written itself. Taking the
// leftmost lets any caller pick their own rate-limit bucket by prepending a
// header, which is not a limiter at all.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ips := strings.Split(xff, ",")
		for i := len(ips) - 1; i >= 0; i-- {
			if ip := strings.TrimSpace(ips[i]); ip != "" {
				return ip
			}
		}
	}
	if realIP := r.Header.Get("X-Real-IP"); realIP != "" {
		return realIP
	}
	if cfIP := r.Header.Get("CF-Connecting-IP"); cfIP != "" {
		return cfIP
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return "unknown"
}
