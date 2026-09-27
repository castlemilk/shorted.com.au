package picks

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestSelectCodesOrdering(t *testing.T) {
	now := time.Date(2026, 9, 27, 15, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) time.Time { return now.Add(-d) }
	day := 24 * time.Hour

	universe := []string{"AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "bhp", "BHP", "BAD.CODE"}
	last := map[string]time.Time{
		"AAA": ago(30 * day), // stale
		"BBB": ago(10 * day), // stale, fresher than AAA
		"CCC": ago(2 * day),  // attempted 2 days ago: skipped...
		"DDD": ago(3 * day),  // ...but DDD filed a 4E: pulled regardless
		"EEE": ago(1 * time.Hour),
		"FFF": ago(7 * day),
		"HHH": ago(30 * day),
		// GGG and BHP never attempted
	}
	filed := map[string]bool{"DDD": true, "EEE": true, "HHH": true}

	got := selectCodes(universe, last, filed, now, 0)
	assert.Equal(t, []string{
		// 1. recent filers, stalest first; EEE was attempted an hour ago (a
		//    same-day re-run) and is not pulled twice
		"HHH", "DDD",
		// 2. never attempted, by code
		"BHP", "GGG",
		// 3. oldest attempt first; CCC (2 days) is inside the 6-day skip
		"AAA", "BBB", "FFF",
	}, got)
}

func TestSelectCodesCapAndSkipBoundary(t *testing.T) {
	now := time.Date(2026, 9, 27, 15, 0, 0, 0, time.UTC)
	last := map[string]time.Time{
		"OLD": now.Add(-skipAttemptedWithin - time.Minute),
		"NEW": now.Add(-skipAttemptedWithin + time.Minute),
	}
	assert.Equal(t, []string{"OLD"}, selectCodes([]string{"OLD", "NEW"}, last, nil, now, 0))

	var universe []string
	universe = append(universe, []string{"A1", "A2", "A3", "A4", "A5"}...)
	assert.Equal(t, []string{"A1", "A2", "A3"}, selectCodes(universe, nil, map[string]bool{}, now, 3), "the cap applies")
	assert.Equal(t, []string{"A4", "A1", "A2"}, selectCodes(universe, nil, map[string]bool{"A4": true}, now, 3),
		"a filer counts toward the cap but goes first")
}
