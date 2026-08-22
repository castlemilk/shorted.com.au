package ratelimit

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"connectrpc.com/connect"
)

// RateLimitDetail is the machine-readable payload attached to every app-layer
// rate-limit rejection.
//
// CONTRACT — the web app parses this; changing a field name is a breaking
// change. It is delivered two ways, both of which survive a Connect error:
//
//   - as compact JSON in the `X-RateLimit-Detail` response/error metadata
//     header (the primary, and the only form available to non-Connect HTTP
//     clients);
//   - mirrored across the individual X-RateLimit-* headers below, so a plain
//     curl or a generic HTTP client can read the same facts without parsing.
//
// A 429 that says only "rate limit exceeded" forces the frontend to guess
// which limit fired and where to send the user. Every field here exists so it
// does not have to.
type RateLimitDetail struct {
	// Kind is "per_minute" or "monthly".
	Kind LimitKind `json:"kind"`
	// Limit is the ceiling for that kind.
	Limit int `json:"limit"`
	// Used is the caller's consumption against that ceiling.
	Used int `json:"used"`
	// Remaining is max(limit-used, 0).
	Remaining int `json:"remaining"`
	// ResetAt is unix SECONDS at which the exceeded window resets.
	ResetAt int64 `json:"reset_at"`
	// RetryAfterSeconds is the suggested wait, matching the Retry-After header.
	RetryAfterSeconds int `json:"retry_after_seconds"`
	// Tier is the caller's resolved tier: anonymous | free | premium | pro | enterprise.
	Tier string `json:"tier"`
	// Access is "browser" or "api" — the tier table has separate columns.
	Access string `json:"access"`
	// UpgradeURL is an absolute URL to the page that lifts this limit.
	UpgradeURL string `json:"upgrade_url"`
	// Message is the human-readable sentence; it already names the remedy.
	Message string `json:"message"`
}

// Header names for the detail payload. Connect canonicalises these.
const (
	headerDetail        = "X-RateLimit-Detail"
	headerKind          = "X-RateLimit-Kind"
	headerTier          = "X-RateLimit-Tier"
	headerUpgradeURL    = "X-RateLimit-Upgrade-Url"
	headerLimit         = "X-RateLimit-Limit"
	headerRemaining     = "X-RateLimit-Remaining"
	headerReset         = "X-RateLimit-Reset"
	headerMonthlyLimit  = "X-RateLimit-Monthly-Limit"
	headerMonthlyUsed   = "X-RateLimit-Monthly-Used"
	headerMonthlyReset  = "X-RateLimit-Monthly-Reset"
	headerRetryAfter    = "Retry-After"
	headerMonthlyRemain = "X-RateLimit-Monthly-Remaining"
)

// buildDetail turns a rejected Result into the wire payload.
func buildDetail(result *Result, upgradeURL string) RateLimitDetail {
	if upgradeURL == "" {
		upgradeURL = defaultUpgradeURL
	}

	access := "api"
	if result.IsBrowser {
		access = "browser"
	}

	detail := RateLimitDetail{
		Kind:              result.ExceededKind,
		Tier:              result.Tier,
		Access:            access,
		UpgradeURL:        upgradeURL,
		RetryAfterSeconds: retryAfterSeconds(result.RetryAfter),
	}

	switch result.ExceededKind {
	case LimitKindMonthly:
		detail.Limit = result.MonthlyLimit
		detail.Used = result.MonthlyUsed
		detail.ResetAt = unixOrZero(result.MonthlyResetAt)
	default:
		detail.Kind = LimitKindPerMinute
		detail.Limit = result.Limit
		// A per-minute rejection means the window is full by definition.
		detail.Used = result.Limit
		detail.ResetAt = unixOrZero(result.ResetAt)
	}

	if r := detail.Limit - detail.Used; r > 0 {
		detail.Remaining = r
	}
	detail.Message = limitMessage(detail)

	return detail
}

// limitMessage writes the sentence a human sees. The remedy is tier-specific
// on purpose: telling an anonymous caller to "upgrade" is useless when signing
// in is what actually raises their limit, and telling a paid caller to
// subscribe is insulting.
func limitMessage(d RateLimitDetail) string {
	var window string
	if d.Kind == LimitKindMonthly {
		window = fmt.Sprintf("monthly quota exceeded: %d of %d requests used this month", d.Used, d.Limit)
	} else {
		window = fmt.Sprintf("rate limit exceeded: %d requests per minute", d.Limit)
	}

	switch d.Tier {
	case "anonymous":
		return fmt.Sprintf(
			"%s. Sign in to raise this limit, or see %s for higher API quotas.",
			window, d.UpgradeURL,
		)
	case "free":
		return fmt.Sprintf(
			"%s. Upgrade at %s to raise this limit.",
			window, d.UpgradeURL,
		)
	default:
		// Paid tiers only reach here on the monthly API cap, which is a real
		// entitlement boundary rather than an upsell moment.
		return fmt.Sprintf(
			"%s on the %s plan. See %s for higher quotas.",
			window, d.Tier, d.UpgradeURL,
		)
	}
}

// newRateLimitError builds the Connect ResourceExhausted error, with the full
// detail payload in its metadata.
func newRateLimitError(result *Result, upgradeURL string) *connect.Error {
	detail := buildDetail(result, upgradeURL)

	err := connect.NewError(connect.CodeResourceExhausted, fmt.Errorf("%s", detail.Message))
	applyDetailHeaders(err.Meta().Set, result, detail)
	return err
}

// applyDetailHeaders writes the header contract through a generic setter so
// the success path (response headers) and the failure path (error metadata)
// cannot drift apart.
func applyDetailHeaders(set func(key, value string), result *Result, detail RateLimitDetail) {
	if encoded, err := json.Marshal(detail); err == nil {
		set(headerDetail, string(encoded))
	}
	set(headerKind, string(detail.Kind))
	set(headerTier, detail.Tier)
	set(headerUpgradeURL, detail.UpgradeURL)
	set(headerRetryAfter, strconv.Itoa(detail.RetryAfterSeconds))

	// Per-minute headers are emitted only when the app layer actually owns a
	// minute window for this tier. A paid caller has none (0 = unlimited), and
	// advertising "0" would read as "you may make zero requests".
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

func retryAfterSeconds(d time.Duration) int {
	if d <= 0 {
		return 0
	}
	s := int(d.Seconds())
	if s < 1 {
		return 1
	}
	return s
}

func unixOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
