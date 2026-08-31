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

// ClientIP extracts the address a request is metered against, with the SAME
// precedence the Connect interceptor uses.
//
// # The rightmost rule, and the one exception to it
//
// By default this takes the RIGHTMOST X-Forwarded-For entry, not the leftmost.
// A proxy APPENDS the address it saw, so the last entry is the only one a
// client could not have written itself; taking the leftmost would let any
// caller pick their own rate-limit bucket by prepending a header, which is not
// a limiter at all.
//
// The exception is our own edge. Our topology is:
//
//	client -> Cloudflare -> Google front end -> Cloud Run
//
// Cloudflare REPLACES the leftmost XFF entry with the true client and sets
// CF-Connecting-IP; Google then appends the address it saw, which is
// Cloudflare's. So under the plain rightmost rule every request through the
// edge is metered as the EDGE, and callers sharing a Cloudflare colo share a
// bucket — at the anonymous tier, 30 requests a minute for an entire colo. That
// was live in production on 2026-08-30: every identifier written to
// api_usage_monthly in the first hour was a Cloudflare address.
//
// So: when the rightmost hop is Cloudflare, the request demonstrably arrived
// through our edge, and the headers Cloudflare writes can be believed —
// a client cannot forge them THROUGH Cloudflare. Everywhere else the rightmost
// rule stands, which is what keeps a direct-to-origin caller (Cloud Run is
// publicly reachable) from choosing their own identity.
//
// X-Real-IP is deliberately no longer consulted before the peer address: it is
// client-settable and nothing in this topology sets it.
func ClientIP(r *http.Request) string {
	return resolveClientIP(
		r.Header.Get("X-Forwarded-For"),
		r.Header.Get("CF-Connecting-IP"),
		r.RemoteAddr,
	)
}

// resolveClientIP is the single implementation behind both ClientIP (plain
// HTTP) and extractIP (Connect). Taking strings rather than a request type is
// what lets one rule serve both without either package importing the other's
// request shape.
func resolveClientIP(forwardedHeader, cfConnectingIP, peer string) string {
	forwarded := splitForwarded(forwardedHeader)

	if len(forwarded) > 0 && isCloudflareEdge(forwarded[len(forwarded)-1]) {
		// Behind our own edge: prefer what Cloudflare says the client is.
		if cfIP := strings.TrimSpace(cfConnectingIP); cfIP != "" {
			return cfIP
		}
		// Cloudflare rewrites the leftmost entry too, so it is the same claim
		// from the same source. Losing CF-Connecting-IP must not silently
		// re-pool every caller onto the edge address.
		if first := forwarded[0]; !isCloudflareEdge(first) {
			return first
		}
	}

	if len(forwarded) > 0 {
		return forwarded[len(forwarded)-1]
	}
	if host, _, err := net.SplitHostPort(peer); err == nil {
		return host
	}
	if peer != "" {
		return peer
	}
	return "unknown"
}

// splitForwarded returns the non-empty, trimmed entries of an X-Forwarded-For
// header in order. Empty entries are dropped rather than treated as hops, so a
// trailing comma cannot shift which hop is considered rightmost.
func splitForwarded(header string) []string {
	if header == "" {
		return nil
	}
	parts := strings.Split(header, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}
