package picks

import (
	"sort"
	"time"
)

const (
	// defaultMaxCodes caps one run (PICKS_FUNDAMENTALS_MAX_CODES). 400 codes x
	// 4s is ~27 minutes of pacing; the full ~2,300-code universe is covered
	// in about six daily runs, then each code is refreshed about weekly.
	defaultMaxCodes = 400
	// skipAttemptedWithin: a code attempted this recently is not asked again
	// (plan §2.6: six days).
	skipAttemptedWithin = 6 * 24 * time.Hour
	// filingLookbackDays: a code with a results filing this recent is fetched
	// first regardless of its last attempt (plan §2.7: fourteen days).
	filingLookbackDays = 14
	// filedRepullAfter keeps "regardless" to once per daily run: a filed code
	// attempted in the last 20 hours (a manual re-run the same afternoon) is
	// not fetched twice. The daily schedule is 24h apart, so the scheduled
	// re-pull is never suppressed.
	filedRepullAfter = 20 * time.Hour
)

// selectCodes orders one run's work and applies the cap.
//
//  1. Codes with a results filing in the lookback window (filed), stalest
//     first, whatever their last attempt except a same-day one.
//  2. Every other universe code not attempted within skipAttemptedWithin,
//     stalest first: never attempted, then the oldest attempt.
//
// Ties break on the code so the order is deterministic. lastAttempt holds
// stock_fundamentals_sync.last_attempt_at (absent = never attempted).
func selectCodes(universe []string, lastAttempt map[string]time.Time, filed map[string]bool, now time.Time, maxCodes int) []string {
	type item struct {
		code    string
		at      time.Time
		never   bool
		isFiled bool
	}
	seen := make(map[string]bool, len(universe))
	var items []item
	for _, raw := range universe {
		code := normalizeCode(raw)
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		at, attempted := lastAttempt[code]
		it := item{code: code, at: at, never: !attempted, isFiled: filed[code]}
		switch {
		case it.isFiled:
			if attempted && now.Sub(at) < filedRepullAfter {
				continue
			}
		case attempted && now.Sub(at) < skipAttemptedWithin:
			continue
		}
		items = append(items, it)
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.isFiled != b.isFiled {
			return a.isFiled
		}
		if a.never != b.never {
			return a.never
		}
		if !a.at.Equal(b.at) {
			return a.at.Before(b.at)
		}
		return a.code < b.code
	})
	if maxCodes > 0 && len(items) > maxCodes {
		items = items[:maxCodes]
	}
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.code
	}
	return out
}
