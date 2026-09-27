package sync

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// sessionsExcept answers with one session per weekday in the window, except
// on the given dates (the market's holidays, as a calendar provider sees them).
func sessionsExcept(closed ...string) func(string, time.Time, time.Time) ([]providers.PriceRecord, error) {
	skip := map[string]bool{}
	for _, c := range closed {
		skip[c] = true
	}
	return func(symbol string, from, to time.Time) ([]providers.PriceRecord, error) {
		recs, err := weekdaySessions(symbol, from, to)
		var out []providers.PriceRecord
		for _, r := range recs {
			if !skip[r.Date.Format("2006-01-02")] {
				out = append(out, r)
			}
		}
		return out, err
	}
}

func TestWeekdayHolidays(t *testing.T) {
	t.Parallel()
	recs, err := sessionsExcept("2025-12-25", "2025-12-26", "2026-01-01")("BHP", mustDate("2025-12-22"), mustDate("2026-01-09"))
	require.NoError(t, err)
	var sessions []time.Time
	for _, r := range recs {
		sessions = append(sessions, r.Date)
	}
	var got []string
	for _, h := range weekdayHolidays(sessions) {
		got = append(got, h.Format("2006-01-02"))
	}
	assert.Equal(t, []string{"2025-12-25", "2025-12-26", "2026-01-01"}, got, "weekends are not holidays; they are never sessions")
	assert.Empty(t, weekdayHolidays(nil))
}

func TestCheckHolidaysRefusesAnIncompleteCalendar(t *testing.T) {
	t.Parallel()
	var year []time.Time
	for d := mustDate("2025-11-03"); len(year) < maxHolidaysPerYear; d = d.AddDate(0, 0, 1) {
		if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday {
			year = append(year, d)
		}
	}
	require.NoError(t, checkHolidays(year), "a year with the most holidays a real one has")
	err := checkHolidays(append(year, mustDate("2025-12-31")))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "nothing deleted")
}

func TestTradingCalendarAsksOnlyThePrimary(t *testing.T) {
	t.Parallel()
	from, to := mustDate("2025-12-22"), mustDate("2026-01-09")

	yahoo := &fakeProvider{name: "yahoo", fn: sessionsExcept("2025-12-25", "2025-12-26", "2026-01-01")}
	av := &fakeProvider{name: "av", fn: weekdaySessions} // the NYSE trades on 26 December
	sessions, err := manager(yahoo, av).tradingCalendar(context.Background(), from, to)
	require.NoError(t, err)
	assert.Len(t, yahoo.calls, len(pruneReferences))
	assert.Empty(t, av.calls, "a fallback's calendar is another market's")
	assert.Len(t, weekdayHolidays(sessions), 3)

	// A reference that does not answer stops the prune.
	refused := &fakeProvider{name: "yahoo", fn: refused}
	_, err = manager(refused, av).tradingCalendar(context.Background(), from, to)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "nothing deleted")
	assert.Empty(t, av.calls)
}

func TestPruneReportIsTheWorkflowsShape(t *testing.T) {
	t.Parallel()
	b, err := json.Marshal(PruneReport{Mode: "prune", From: "2025-12-01", To: "2026-01-09", Holidays: []string{"2025-12-25"},
		WeekendRowsByYear: map[string]int{"2025": 1}, HolidayRowsByDate: map[string]int{"2025-12-25": 1}})
	require.NoError(t, err)
	var keys map[string]any
	require.NoError(t, json.Unmarshal(b, &keys))
	for _, k := range []string{"mode", "dry_run", "attempt", "duration", "references", "from", "to", "trading_days",
		"holidays", "weekend_rows", "weekend_rows_by_year", "holiday_rows", "holiday_rows_by_date", "deleted"} {
		assert.Contains(t, keys, k)
	}
}
