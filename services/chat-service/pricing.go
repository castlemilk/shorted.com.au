package main

import (
	"math"
	"time"
)

// Pricing is what one model costs, in USD per 1M tokens at its standard rate.
// Those numbers are also micro-USD per token, so a count times a price gives
// micro-USD directly.
type Pricing struct {
	Input       float64 // uncached prompt tokens
	CachedInput float64 // prompt tokens served from the provider's cache
	Output      float64 // output and reasoning tokens
	// OffPeakFactor multiplies the whole cost when IsOffPeak holds. 0 and nil
	// mean the rate never changes.
	OffPeakFactor float64
	IsOffPeak     func(time.Time) bool
	AsOf          string // the date the prices were read
	SourceURL     string
}

// deepSeekOffPeak reports whether DeepSeek's off-peak rate applies at t. Peak is
// 01:00-04:00 and 06:00-10:00 UTC on weekdays; every other hour, and all of the
// weekend, is off-peak. Chinese public holidays are not modelled, so a holiday
// weekday reads as peak.
func deepSeekOffPeak(t time.Time) bool {
	u := t.UTC()
	if wd := u.Weekday(); wd == time.Saturday || wd == time.Sunday {
		return true
	}
	h := u.Hour()
	peak := (h >= 1 && h < 4) || (h >= 6 && h < 10)
	return !peak
}

// EstimateCostMicroUSD prices one model call, or the sum of several, in
// micro-USD. A cost the provider reported (OpenRouter usage.cost) wins over the
// catalog price. Reasoning tokens are billed at the output rate, as Gemini bills
// thinking tokens, so they are added to the output count here.
func EstimateCostMicroUSD(p Pricing, u TokenUsage, at time.Time) int64 {
	if u.ReportedCostUSD != nil {
		return int64(math.Round(*u.ReportedCostUSD * 1e6))
	}
	uncached := u.PromptTokens - u.CachedPromptTokens
	if uncached < 0 {
		uncached = 0
	}
	micro := float64(uncached)*p.Input +
		float64(u.CachedPromptTokens)*p.CachedInput +
		float64(u.CandidateTokens+u.ReasoningTokens)*p.Output
	if p.IsOffPeak != nil && p.OffPeakFactor > 0 && p.IsOffPeak(at) {
		micro *= p.OffPeakFactor
	}
	return int64(math.Round(micro))
}
