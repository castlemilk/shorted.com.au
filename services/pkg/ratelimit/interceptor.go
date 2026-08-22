package ratelimit

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// UserClaims defines the interface for user claims used by the rate limiter
type UserClaims interface {
	GetUserID() string
	GetTier() string
	GetIsBrowserAuth() bool
}

// UserClaimsContextKey is the context key for user claims
// This should match the key used by the auth interceptor
type UserClaimsContextKey string

const DefaultUserClaimsKey UserClaimsContextKey = "user"

// NewRateLimitInterceptor creates a Connect interceptor for rate limiting
func NewRateLimitInterceptor(limiter RateLimiter, cfg Config, userClaimsKey any) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			// If rate limiting is disabled, skip
			if !cfg.Enabled {
				return next(ctx, req)
			}

			// Build identifier based on user or IP
			identifier, tier, isBrowser := extractIdentifierAndTier(ctx, req, userClaimsKey)

			// Validate origin for browser-tier requests. If the request claims to be
			// from a browser (Firebase auth) but doesn't have a valid Origin/Referer
			// header, downgrade it to API-tier rate limits. This prevents scrapers
			// from using stolen Firebase tokens to get relaxed browser limits.
			// Exception: if the User-Agent looks like a real browser (contains "Mozilla/"),
			// allow browser-tier even without Origin/Referer — privacy extensions strip these.
			if isBrowser {
				origin := req.Header().Get("Origin")
				if origin == "" {
					origin = req.Header().Get("Referer")
				}
				if !isValidBrowserOrigin(origin, cfg.AllowedOrigins) {
					ua := strings.ToLower(req.Header().Get("User-Agent"))
					if !strings.Contains(ua, "mozilla/") {
						log.Debugf("Downgrading browser-tier to API-tier for %s: invalid origin %q, non-browser UA", identifier, origin)
						isBrowser = false
					}
				}
			}

			// Check rate limit
			result, err := limiter.Check(ctx, identifier, tier, isBrowser)
			if err != nil {
				log.Warnf("Rate limit check failed: %v", err)
				// Fail open if configured
				if cfg.FailOpen {
					return next(ctx, req)
				}
				return nil, connect.NewError(connect.CodeUnavailable,
					fmt.Errorf("rate limit check failed"))
			}

			// Rate limit exceeded
			if !result.Allowed {
				// Record rate limit blocked metric
				if shortedotel.RateLimitBlocked != nil {
					// Only use bounded attributes for metrics. "identifier" (IP/user ID)
					// is unbounded and would create a time series per unique client.
					shortedotel.RateLimitBlocked.Add(ctx, 1,
						otelmetric.WithAttributes(
							attribute.String("tier", tier),
							attribute.String("kind", string(result.ExceededKind)),
						),
					)
				}

				// The rejection carries a machine-readable payload — which
				// limit fired, its ceiling, the caller's tier, when it resets,
				// and where to go to raise it. A bare "rate limit exceeded"
				// forces the frontend to guess all five. Contract:
				// RateLimitDetail in quota_error.go, documented in CLAUDE.md.
				err := newRateLimitError(result, cfg.UpgradeURL)

				log.Infof("Rate limit exceeded for %s (tier=%s, kind=%s, minute=%d, monthly=%d/%d)",
					identifier, tier, result.ExceededKind, result.Limit, result.MonthlyUsed, result.MonthlyLimit)

				return nil, err
			}

			// Call the actual handler
			resp, err := next(ctx, req)

			// Add rate limit headers to a successful response.
			//
			// A limit of 0 means "unlimited for this tier" and its headers are
			// omitted: emitting "X-RateLimit-Limit: 0" reads as "you may make
			// zero requests", which is the opposite of the truth.
			if err == nil && resp != nil {
				if result.Limit > 0 {
					resp.Header().Set(headerLimit, strconv.Itoa(result.Limit))
					resp.Header().Set(headerRemaining, strconv.Itoa(maxInt(result.Remaining, 0)))
					resp.Header().Set(headerReset, strconv.FormatInt(unixOrZero(result.ResetAt), 10))
				}
				if result.MonthlyLimit > 0 {
					resp.Header().Set(headerMonthlyLimit, strconv.Itoa(result.MonthlyLimit))
					resp.Header().Set(headerMonthlyUsed, strconv.Itoa(result.MonthlyUsed))
					resp.Header().Set(headerMonthlyRemain, strconv.Itoa(maxInt(result.MonthlyLimit-result.MonthlyUsed, 0)))
					resp.Header().Set(headerMonthlyReset, strconv.FormatInt(unixOrZero(result.MonthlyResetAt), 10))
				}
			}

			return resp, err
		}
	}
}

// extractIdentifierAndTier extracts the rate limit identifier, tier, and browser flag from context/request
func extractIdentifierAndTier(ctx context.Context, req connect.AnyRequest, userClaimsKey any) (string, string, bool) {
	// Try to get user claims from context
	if claims := ctx.Value(userClaimsKey); claims != nil {
		if uc, ok := claims.(UserClaims); ok {
			userID := uc.GetUserID()
			if userID != "" {
				tier := uc.GetTier()
				if tier == "" {
					tier = "free"
				}
				isBrowser := uc.GetIsBrowserAuth()
				return "user:" + userID, tier, isBrowser
			}
		}
		// Also try with a struct that has UserID and Tier fields directly
		if c, ok := claims.(interface{ UserID() string }); ok {
			if userID := c.UserID(); userID != "" {
				tier := "free"
				if t, ok := claims.(interface{ Tier() string }); ok {
					if t.Tier() != "" {
						tier = t.Tier()
					}
				}
				// Check for browser auth
				isBrowser := false
				if b, ok := claims.(interface{ GetIsBrowserAuth() bool }); ok {
					isBrowser = b.GetIsBrowserAuth()
				}
				return "user:" + userID, tier, isBrowser
			}
		}
	}

	// Fall back to IP address for anonymous users (not browser - could be API scraping)
	ip := extractIP(req)
	return "ip:" + ip, "anonymous", false
}

// extractIP extracts the real client IP from request headers, resilient to
// X-Forwarded-For spoofing. Cloud Run (and most reverse proxies) append the
// actual client IP as the rightmost entry in X-Forwarded-For. Attackers can
// prepend arbitrary IPs to the left side, so we must use the rightmost IP
// (added by the trusted proxy) rather than the leftmost (client-controlled).
func extractIP(req connect.AnyRequest) string {
	// Try X-Forwarded-For first (for proxied requests)
	if xff := req.Header().Get("X-Forwarded-For"); xff != "" {
		ips := strings.Split(xff, ",")
		// Use the rightmost IP (added by the proxy, not the client)
		for i := len(ips) - 1; i >= 0; i-- {
			ip := strings.TrimSpace(ips[i])
			if ip != "" {
				return ip
			}
		}
	}

	// Try X-Real-IP
	if realIP := req.Header().Get("X-Real-IP"); realIP != "" {
		return realIP
	}

	// Try CF-Connecting-IP (Cloudflare)
	if cfIP := req.Header().Get("CF-Connecting-IP"); cfIP != "" {
		return cfIP
	}

	// Fallback to peer address
	if peer := req.Peer().Addr; peer != "" {
		host, _, err := net.SplitHostPort(peer)
		if err != nil {
			return peer
		}
		return host
	}

	return "unknown"
}

// isValidBrowserOrigin checks whether the given origin or referer value matches
// an allowed hostname for browser-tier rate limits. It accepts:
//   - Full URLs like "https://shorted.com.au" or "https://www.shorted.com.au/reports/weekly"
//   - Bare hostnames like "shorted.com.au"
//   - Any *.vercel.app subdomain (for preview deployments)
//   - Hostnames with ports like "localhost:3020"
//
// Returns false if the origin is empty or doesn't match any allowed origin.
func isValidBrowserOrigin(origin string, allowedOrigins []string) bool {
	if origin == "" {
		return false
	}

	host := extractHostname(origin)
	if host == "" {
		return false
	}

	// Check against configured allowed origins
	for _, allowed := range allowedOrigins {
		if strings.EqualFold(host, allowed) {
			return true
		}
	}

	// Always allow *.vercel.app subdomains (preview deployments)
	if strings.HasSuffix(strings.ToLower(host), ".vercel.app") {
		return true
	}

	return false
}

// extractHostname extracts the hostname (without port) from a URL string or bare hostname.
// Handles formats like:
//   - "https://shorted.com.au"
//   - "https://www.shorted.com.au/reports/weekly"
//   - "shorted.com.au"
//   - "localhost:3020"
func extractHostname(rawOrigin string) string {
	rawOrigin = strings.TrimSpace(rawOrigin)
	if rawOrigin == "" {
		return ""
	}

	// Try parsing as a full URL first
	if strings.Contains(rawOrigin, "://") {
		parsed, err := url.Parse(rawOrigin)
		if err != nil {
			return ""
		}
		host := parsed.Hostname() // strips port
		return host
	}

	// Handle bare hostname or hostname:port (e.g., "localhost:3020")
	// Strip any path component
	if idx := strings.Index(rawOrigin, "/"); idx != -1 {
		rawOrigin = rawOrigin[:idx]
	}
	// Strip port
	if idx := strings.LastIndex(rawOrigin, ":"); idx != -1 {
		return rawOrigin[:idx]
	}
	return rawOrigin
}
