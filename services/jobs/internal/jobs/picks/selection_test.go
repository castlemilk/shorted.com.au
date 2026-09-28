package picks

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestSelectCodesOrderAndSkips(t *testing.T) {
	now := time.Date(2026, 9, 28, 15, 0, 0, 0, time.UTC)
	day := 24 * time.Hour
	ago := func(d time.Duration) time.Time { return now.Add(-d) }
	ptr := func(t time.Time) *time.Time { return &t }
	loaded := func(at time.Time) syncState {
		return syncState{LastAttempt: at, LastSuccess: ptr(at), LastOutcome: outcomeLoaded}
	}

	universe := []string{"FIL", "FOL", "DON", "NEW1", "NEW2", "NEW3", "FAIL", "OLD", "FRESH", "EMP1", "EMP2", "EMP3", "bhp", "BHP", "BAD.CODE"}
	states := map[string]syncState{
		// Filed 5 days ago; last success before the filing: due.
		"FIL": loaded(ago(9 * day)),
		// Filed 10 days ago, pulled the day after: its 7-day follow-up is due.
		"FOL": loaded(ago(9 * day)),
		// Filed 10 days ago, pulled at day 1 and again at day 8: done.
		"DON":   loaded(ago(2 * day)),
		"FAIL":  {LastAttempt: ago(1 * time.Hour), LastSuccess: ptr(ago(30 * day)), LastOutcome: outcomeFailed},
		"OLD":   loaded(ago(20 * day)),
		"FRESH": loaded(ago(13 * day)),
		// A single empty is treated like a success (14 days)...
		"EMP1": {LastAttempt: ago(15 * day), LastOutcome: outcomeEmpty, ConsecutiveEmpty: 1},
		// ...two in a row wait 45 days.
		"EMP2": {LastAttempt: ago(30 * day), LastOutcome: outcomeEmpty, ConsecutiveEmpty: 2},
		"EMP3": {LastAttempt: ago(46 * day), LastOutcome: outcomeEmpty, ConsecutiveEmpty: 3},
		"BHP":  loaded(ago(3 * day)),
	}
	filings := map[string][]time.Time{
		"FIL": {ago(5 * day)},
		"FOL": {ago(10 * day)},
		"DON": {ago(10 * day)},
	}
	ranks := map[string]rankInput{
		"NEW1": {MarketCap: 5e9, DollarVolume20d: 1},
		"NEW2": {MarketCap: 9e9},
		"NEW3": {MarketCap: 5e9, DollarVolume20d: 7},
	}

	sel := selectCodes(universe, states, filings, ranks, now, 0)
	assert.Equal(t, []string{
		// 1. due filers (oldest attempt first)
		"FIL", "FOL",
		// 2. never attempted: market cap, then dollar volume
		"NEW2", "NEW3", "NEW1",
		// 3. the last outcome failed: never skipped, however recent
		"FAIL",
		// 4. stale successes and single empties, and repeated empties past
		//    45 days, oldest first
		"EMP3", "OLD", "EMP1",
	}, sel.codes)
	assert.Equal(t, [groupCount]int{2, 3, 1, 3}, sel.byGroup)
	assert.Equal(t, 4, sel.skipped, "DON, FRESH, EMP2, BHP")
	assert.Contains(t, sel.summary(), "due_filers=2 never_attempted=3 failed=1 stale=3 skipped=4")
}

func TestSelectCodesCap(t *testing.T) {
	now := time.Date(2026, 9, 28, 15, 0, 0, 0, time.UTC)
	universe := []string{"A1", "A2", "A3", "A4", "A5"}
	assert.Len(t, selectCodes(universe, nil, nil, nil, now, 0).codes, 5, "no cap by default: the budget decides")
	assert.Equal(t, []string{"A1", "A2", "A3"}, selectCodes(universe, nil, nil, nil, now, 3).codes, "an explicit cap applies")
	got := selectCodes(universe, nil, map[string][]time.Time{"A4": {now.Add(-24 * time.Hour)}}, nil, now, 3).codes
	assert.Equal(t, []string{"A4", "A1", "A2"}, got, "a due filer counts toward the cap but goes first")
}

func TestDueFiler(t *testing.T) {
	now := time.Date(2026, 9, 28, 15, 0, 0, 0, time.UTC)
	filed := now.Add(-10 * 24 * time.Hour)
	at := func(d time.Duration) *time.Time { t := filed.Add(d); return &t }
	assert.True(t, dueFiler([]time.Time{filed}, nil, now), "never succeeded")
	assert.True(t, dueFiler([]time.Time{filed}, at(-time.Hour), now), "last success before the filing")
	assert.True(t, dueFiler([]time.Time{filed}, at(24*time.Hour), now), "the follow-up, 7+ days after")
	assert.False(t, dueFiler([]time.Time{filed}, at(8*24*time.Hour), now), "follow-up done")
	fresh := now.Add(-3 * 24 * time.Hour)
	after := fresh.Add(time.Hour)
	assert.False(t, dueFiler([]time.Time{fresh}, &after, now), "pulled after the filing; the follow-up is not due yet")
	assert.False(t, dueFiler(nil, nil, now))
}

func TestDeriveOutcome(t *testing.T) {
	at := time.Date(2026, 9, 1, 15, 0, 0, 0, time.UTC)
	earlier := at.Add(-time.Hour)
	o, n := deriveOutcome(at, &at, "")
	assert.Equal(t, outcomeLoaded, o)
	assert.Zero(t, n)
	o, n = deriveOutcome(at, &earlier, "no fundamentals published: yahoo: none; markit: none")
	assert.Equal(t, outcomeEmpty, o, "the empty-answer prefix the job has always written")
	assert.Equal(t, 1, n)
	o, _ = deriveOutcome(at, &earlier, "yahoo BHP: unexpected status: 429")
	assert.Equal(t, outcomeFailed, o)
	o, _ = deriveOutcome(at, nil, "")
	assert.Equal(t, outcomeFailed, o)
}
