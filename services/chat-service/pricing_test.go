package main

import (
	"testing"
	"time"
)

// utc builds a UTC instant. 2026-10-26 is a Monday; 2026-10-24 is a Saturday.
func utc(day string, hour, minute int) time.Time {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		panic(err)
	}
	return t.Add(time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute).UTC()
}

func TestDeepSeekOffPeakBoundaries(t *testing.T) {
	cases := []struct {
		name    string
		at      time.Time
		offPeak bool
	}{
		{"weekday 00:59 is off-peak", utc("2026-10-26", 0, 59), true},
		{"weekday 01:00 opens peak", utc("2026-10-26", 1, 0), false},
		{"weekday 03:59 is still peak", utc("2026-10-26", 3, 59), false},
		{"weekday 04:00 closes the first window", utc("2026-10-26", 4, 0), true},
		{"weekday 05:59 is off-peak", utc("2026-10-26", 5, 59), true},
		{"weekday 06:00 opens the second window", utc("2026-10-26", 6, 0), false},
		{"weekday 09:59 is still peak", utc("2026-10-26", 9, 59), false},
		{"weekday 10:00 is off-peak", utc("2026-10-26", 10, 0), true},
		{"weekday 23:59 is off-peak", utc("2026-10-30", 23, 59), true},
		{"saturday 02:00 is off-peak", utc("2026-10-31", 2, 0), true},
		{"saturday 07:00 is off-peak", utc("2026-10-24", 7, 0), true},
		{"sunday 08:00 is off-peak", utc("2026-10-25", 8, 0), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := deepSeekOffPeak(c.at); got != c.offPeak {
				t.Fatalf("deepSeekOffPeak(%s) = %v, want %v", c.at.Format(time.RFC1123), got, c.offPeak)
			}
		})
	}
}

func TestDeepSeekOffPeakReadsUTCNotLocalTime(t *testing.T) {
	// 02:00 UTC is peak on a weekday, whatever zone the instant was built in.
	aest := time.FixedZone("AEST", 10*3600)
	at := time.Date(2026, 10, 26, 12, 0, 0, 0, aest) // 02:00 UTC on Monday
	if deepSeekOffPeak(at) {
		t.Fatal("02:00 UTC on a weekday read as off-peak")
	}
}

func TestEstimateCostMicroUSDPricesEachBucket(t *testing.T) {
	p := Pricing{Input: 0.30, CachedInput: 0.03, Output: 2.50, OffPeakFactor: 1}
	usage := TokenUsage{PromptTokens: 1000, CachedPromptTokens: 400, CandidateTokens: 100}
	// 600 uncached at 0.30 + 400 cached at 0.03 + 100 output at 2.50, in micro-USD.
	want := int64(600*0.30 + 400*0.03 + 100*2.50)
	if got := EstimateCostMicroUSD(p, usage, time.Time{}); got != want {
		t.Fatalf("EstimateCostMicroUSD() = %d, want %d", got, want)
	}
}

func TestEstimateCostMicroUSDBillsReasoningAsOutput(t *testing.T) {
	p := Pricing{Input: 0, Output: 2.50}
	usage := TokenUsage{CandidateTokens: 100, ReasoningTokens: 300}
	if got := EstimateCostMicroUSD(p, usage, time.Time{}); got != 1000 {
		t.Fatalf("EstimateCostMicroUSD() = %d, want 1000 (400 output tokens at 2.50)", got)
	}
}

func TestEstimateCostMicroUSDAppliesOffPeakOnlyWhenOffPeak(t *testing.T) {
	p := deepSeekPricing(0.30, 0.006, 1.20, "")
	usage := TokenUsage{PromptTokens: 1_000_000, CandidateTokens: 1_000_000}
	peak := EstimateCostMicroUSD(p, usage, utc("2026-10-26", 2, 0))
	off := EstimateCostMicroUSD(p, usage, utc("2026-10-26", 12, 0))
	if peak != 1_500_000 {
		t.Fatalf("peak cost = %d micro-USD, want 1500000 ($0.30 in + $1.20 out)", peak)
	}
	if off != 750_000 {
		t.Fatalf("off-peak cost = %d micro-USD, want 750000 (half of peak)", off)
	}
}

func TestEstimateCostMicroUSDPrefersProviderReportedCost(t *testing.T) {
	p := Pricing{Input: 100, Output: 100}
	reported := 0.000123
	usage := TokenUsage{PromptTokens: 1000, CandidateTokens: 1000, ReportedCostUSD: &reported}
	if got := EstimateCostMicroUSD(p, usage, time.Time{}); got != 123 {
		t.Fatalf("EstimateCostMicroUSD() = %d, want the reported 123 micro-USD", got)
	}
}

func TestEstimateCostMicroUSDClampsUncachedAndZeroForNoUsage(t *testing.T) {
	p := Pricing{Input: 0.30, CachedInput: 0.03, Output: 2.50}
	// More cached than prompt tokens is a provider inconsistency: no uncached
	// tokens are billed, and the 50 cached tokens cost 1.5 micro-USD, rounded to 2.
	usage := TokenUsage{PromptTokens: 10, CachedPromptTokens: 50}
	if got := EstimateCostMicroUSD(p, usage, time.Time{}); got != 2 {
		t.Fatalf("EstimateCostMicroUSD() = %d, want 2", got)
	}
	if got := EstimateCostMicroUSD(p, TokenUsage{}, time.Time{}); got != 0 {
		t.Fatalf("EstimateCostMicroUSD(no usage) = %d, want 0", got)
	}
}
