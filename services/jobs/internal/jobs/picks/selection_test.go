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

// A sync row written before 000132 (last_outcome NULL) belongs to a code whose
// stored rows are the 000129 seven-column shape: no full statements, so no
// quality ratios. Its derived outcome must not earn the 14-day (or 45-day)
// skip, or most of the universe keeps the legacy shape for two weeks after
// the deploy. It selects like a never-attempted code, largest first; a row
// with a real last_outcome keeps its own semantics.
func TestSelectCodesLegacyRowsSelectLikeNeverAttempted(t *testing.T) {
	now := time.Date(2026, 9, 28, 15, 0, 0, 0, time.UTC)
	day := 24 * time.Hour
	ago := func(d time.Duration) time.Time { return now.Add(-d) }
	ptr := func(t time.Time) *time.Time { return &t }

	universe := []string{"BHP", "CSL", "TNY", "ETF", "LFL", "CUR", "CFL", "NEW", "DUE"}
	states := map[string]syncState{
		// Legacy success yesterday (derived 'loaded'): was skipped for 14 days.
		"BHP": {LastAttempt: ago(day), LastSuccess: ptr(ago(day)), LastOutcome: outcomeLoaded, Legacy: true},
		"CSL": {LastAttempt: ago(2 * day), LastSuccess: ptr(ago(2 * day)), LastOutcome: outcomeLoaded, Legacy: true},
		"TNY": {LastAttempt: ago(3 * day), LastSuccess: ptr(ago(3 * day)), LastOutcome: outcomeLoaded, Legacy: true},
		// Legacy empty (derived): was skipped for 14 days.
		"ETF": {LastAttempt: ago(day), LastOutcome: outcomeEmpty, ConsecutiveEmpty: 1, Legacy: true},
		// Legacy failure (derived): was ordered by attempt age among failures.
		"LFL": {LastAttempt: ago(time.Hour), LastOutcome: outcomeFailed, Legacy: true},
		// Rows written by the new image keep their semantics.
		"CUR": {LastAttempt: ago(day), LastSuccess: ptr(ago(day)), LastOutcome: outcomeLoaded},
		"CFL": {LastAttempt: ago(time.Hour), LastOutcome: outcomeFailed},
		// A legacy row that is also a due filer stays a due filer.
		"DUE": {LastAttempt: ago(9 * day), LastSuccess: ptr(ago(9 * day)), LastOutcome: outcomeLoaded, Legacy: true},
	}
	ranks := map[string]rankInput{
		"BHP": {MarketCap: 200e9}, "CSL": {MarketCap: 150e9}, "TNY": {MarketCap: 1e7},
		"ETF": {MarketCap: 0}, "LFL": {MarketCap: 5e8}, "NEW": {MarketCap: 3e9}, "CUR": {MarketCap: 900e9},
	}
	filings := map[string][]time.Time{"DUE": {ago(5 * day)}}

	sel := selectCodes(universe, states, filings, ranks, now, 0)
	assert.Equal(t, []string{
		"DUE",
		// never attempted and pre-000132 rows together, by market cap
		"BHP", "CSL", "NEW", "LFL", "TNY", "ETF",
		"CFL",
	}, sel.codes)
	assert.Equal(t, [groupCount]int{1, 6, 1, 0}, sel.byGroup)
	assert.Equal(t, 1, sel.skipped, "only CUR, a success recorded with a real last_outcome")
	assert.Equal(t, 5, sel.legacy, "BHP, CSL, TNY, ETF, LFL (DUE is counted as a due filer)")
	assert.Contains(t, sel.summary(), "pre_000132=5")
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
