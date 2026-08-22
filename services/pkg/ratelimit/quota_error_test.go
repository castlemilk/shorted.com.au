package ratelimit

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A 429 that says only "rate limit exceeded" makes the frontend guess which
// limit fired, what the ceiling was, when it clears, and where to send the
// user. These tests pin the payload that answers all four.
func TestRateLimitDetailPayload(t *testing.T) {
	reset := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	minuteReset := time.Date(2026, 8, 15, 10, 1, 0, 0, time.UTC)

	tests := []struct {
		name     string
		result   *Result
		wantKind LimitKind
		wantLim  int
		wantUsed int
		wantRst  int64
		wantMsg  []string
	}{
		{
			name: "anonymous per-minute — tells them signing in helps",
			result: &Result{
				ExceededKind: LimitKindPerMinute, Tier: "anonymous",
				Limit: 30, Remaining: 0, ResetAt: minuteReset, RetryAfter: 42 * time.Second,
			},
			wantKind: LimitKindPerMinute, wantLim: 30, wantUsed: 30, wantRst: minuteReset.Unix(),
			wantMsg: []string{"30 requests per minute", "Sign in", "https://shorted.com.au/pricing"},
		},
		{
			name: "free per-minute — tells them upgrading helps",
			result: &Result{
				ExceededKind: LimitKindPerMinute, Tier: "free",
				Limit: 60, Remaining: 0, ResetAt: minuteReset, RetryAfter: 12 * time.Second,
			},
			wantKind: LimitKindPerMinute, wantLim: 60, wantUsed: 60, wantRst: minuteReset.Unix(),
			wantMsg: []string{"60 requests per minute", "Upgrade at", "https://shorted.com.au/pricing"},
		},
		{
			name: "premium per-minute — no upsell, they already pay",
			result: &Result{
				ExceededKind: LimitKindPerMinute, Tier: "premium",
				Limit: 120, Remaining: 0, ResetAt: minuteReset, RetryAfter: 5 * time.Second,
			},
			wantKind: LimitKindPerMinute, wantLim: 120, wantUsed: 120, wantRst: minuteReset.Unix(),
			wantMsg: []string{"120 requests per minute", "premium plan"},
		},
		{
			name: "anonymous monthly",
			result: &Result{
				ExceededKind: LimitKindMonthly, Tier: "anonymous",
				MonthlyLimit: 500, MonthlyUsed: 501, MonthlyResetAt: reset, RetryAfter: 36 * time.Hour,
			},
			wantKind: LimitKindMonthly, wantLim: 500, wantUsed: 501, wantRst: reset.Unix(),
			wantMsg: []string{"501 of 500 requests used this month", "Sign in"},
		},
		{
			name: "free monthly",
			result: &Result{
				ExceededKind: LimitKindMonthly, Tier: "free",
				MonthlyLimit: 1000, MonthlyUsed: 1001, MonthlyResetAt: reset, RetryAfter: 36 * time.Hour,
			},
			wantKind: LimitKindMonthly, wantLim: 1000, wantUsed: 1001, wantRst: reset.Unix(),
			wantMsg: []string{"1001 of 1000 requests used this month", "Upgrade at"},
		},
		{
			name: "premium monthly — a real entitlement boundary",
			result: &Result{
				ExceededKind: LimitKindMonthly, Tier: "premium",
				MonthlyLimit: 10000, MonthlyUsed: 10001, MonthlyResetAt: reset, RetryAfter: time.Hour,
			},
			wantKind: LimitKindMonthly, wantLim: 10000, wantUsed: 10001, wantRst: reset.Unix(),
			wantMsg: []string{"10001 of 10000 requests used this month", "premium plan", "higher quotas"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := buildDetail(tc.result, "")

			assert.Equal(t, tc.wantKind, d.Kind)
			assert.Equal(t, tc.wantLim, d.Limit)
			assert.Equal(t, tc.wantUsed, d.Used)
			assert.Equal(t, 0, d.Remaining, "a rejection means nothing is remaining")
			assert.Equal(t, tc.wantRst, d.ResetAt)
			assert.Equal(t, tc.result.Tier, d.Tier)
			assert.Equal(t, "api", d.Access)
			assert.Equal(t, "https://shorted.com.au/pricing", d.UpgradeURL)
			assert.Equal(t, int(tc.result.RetryAfter.Seconds()), d.RetryAfterSeconds)

			for _, want := range tc.wantMsg {
				assert.Contains(t, d.Message, want)
			}

			// An anonymous caller must never be told to "upgrade" — signing in
			// is what actually raises their limit.
			if tc.result.Tier == "anonymous" {
				assert.NotContains(t, d.Message, "Upgrade at")
			}
			// A paying caller must never be told to subscribe.
			if tc.result.Tier == "premium" {
				assert.NotContains(t, d.Message, "Sign in")
				assert.NotContains(t, d.Message, "Upgrade at")
			}
		})
	}
}

func TestBrowserAccessIsLabelled(t *testing.T) {
	d := buildDetail(&Result{
		ExceededKind: LimitKindPerMinute, Tier: "free", IsBrowser: true,
		Limit: 120, ResetAt: time.Now(),
	}, "")
	assert.Equal(t, "browser", d.Access)
}

func TestRateLimitErrorCarriesTheContract(t *testing.T) {
	reset := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	minuteReset := time.Date(2026, 8, 15, 10, 1, 0, 0, time.UTC)

	result := &Result{
		ExceededKind: LimitKindMonthly,
		Tier:         "free",
		Limit:        60, Remaining: 0, ResetAt: minuteReset,
		MonthlyLimit: 1000, MonthlyUsed: 1001, MonthlyResetAt: reset,
		RetryAfter: 90 * time.Second,
	}

	err := newRateLimitError(result, "")

	require.Equal(t, connect.CodeResourceExhausted, err.Code())
	meta := err.Meta()

	// The JSON payload is the primary contract.
	var decoded RateLimitDetail
	require.NoError(t, json.Unmarshal([]byte(meta.Get("X-RateLimit-Detail")), &decoded))
	assert.Equal(t, LimitKindMonthly, decoded.Kind)
	assert.Equal(t, 1000, decoded.Limit)
	assert.Equal(t, 1001, decoded.Used)
	assert.Equal(t, reset.Unix(), decoded.ResetAt)
	assert.Equal(t, "free", decoded.Tier)
	assert.Equal(t, "https://shorted.com.au/pricing", decoded.UpgradeURL)
	assert.NotEmpty(t, decoded.Message)

	// Mirrored as individual headers so a plain HTTP client needs no parser.
	assert.Equal(t, "monthly", meta.Get("X-RateLimit-Kind"))
	assert.Equal(t, "free", meta.Get("X-RateLimit-Tier"))
	assert.Equal(t, "https://shorted.com.au/pricing", meta.Get("X-RateLimit-Upgrade-Url"))
	assert.Equal(t, "90", meta.Get("Retry-After"))
	assert.Equal(t, "1000", meta.Get("X-RateLimit-Monthly-Limit"))
	assert.Equal(t, "1001", meta.Get("X-RateLimit-Monthly-Used"))
	assert.Equal(t, "0", meta.Get("X-RateLimit-Monthly-Remaining"))
	assert.Equal(t, strconv.FormatInt(reset.Unix(), 10), meta.Get("X-RateLimit-Monthly-Reset"))

	// The per-minute window is still reported: a caller blocked monthly should
	// still be able to see their minute budget.
	assert.Equal(t, "60", meta.Get("X-RateLimit-Limit"))
	assert.Equal(t, strconv.FormatInt(minuteReset.Unix(), 10), meta.Get("X-RateLimit-Reset"))

	// The human message repeats the machine facts, so a raw curl is usable.
	assert.Contains(t, err.Error(), "1001 of 1000")
}

// "X-RateLimit-Limit: 0" reads as "you may make zero requests", which is the
// opposite of what an unlimited tier means.
func TestUnlimitedTierOmitsZeroedHeaders(t *testing.T) {
	err := newRateLimitError(&Result{
		ExceededKind: LimitKindMonthly, Tier: "premium",
		Limit: 0, MonthlyLimit: 10000, MonthlyUsed: 10001,
		MonthlyResetAt: time.Now().Add(time.Hour), RetryAfter: time.Hour,
	}, "")

	assert.Empty(t, err.Meta().Get("X-RateLimit-Limit"))
	assert.Empty(t, err.Meta().Get("X-RateLimit-Reset"))
	assert.NotEmpty(t, err.Meta().Get("X-RateLimit-Monthly-Limit"))
}

func TestDetailHeaderIsSingleLineJSON(t *testing.T) {
	err := newRateLimitError(&Result{
		ExceededKind: LimitKindPerMinute, Tier: "anonymous",
		Limit: 30, ResetAt: time.Now(), RetryAfter: time.Second,
	}, "")

	raw := err.Meta().Get("X-RateLimit-Detail")
	require.NotEmpty(t, raw)
	assert.False(t, strings.ContainsAny(raw, "\r\n"), "a header value must not contain newlines")
}

func TestUpgradeURLIsOverridable(t *testing.T) {
	d := buildDetail(&Result{
		ExceededKind: LimitKindPerMinute, Tier: "free", Limit: 60, ResetAt: time.Now(),
	}, "https://example.test/plans")
	assert.Equal(t, "https://example.test/plans", d.UpgradeURL)
	assert.Contains(t, d.Message, "https://example.test/plans")
}
