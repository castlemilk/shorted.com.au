//go:build integration

package shorts

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// seedShortsDay writes one report day: each code at its percent.
func seedShortsDay(t *testing.T, s *postgresStore, day string, pct map[string]float64) {
	t.Helper()
	for code, v := range pct {
		_, err := s.db.Exec(context.Background(),
			`INSERT INTO shorts ("DATE", "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
			 VALUES ($1::timestamp, $2, $3)`, day, code, v)
		require.NoError(t, err)
	}
}

// The window is the evaluator's: newest first, and a crossing found through it is
// the one the evaluator's rule gives.
func TestReportWindowFindsTheCrossingTheEvaluatorWouldFire(t *testing.T) {
	s := alertsTestStore(t)
	ctx := context.Background()
	_, err := s.db.Exec(ctx, `INSERT INTO "company-metadata" (stock_code, company_name) VALUES ('ABC', 'ABC Holdings')`)
	require.NoError(t, err)
	seedShortsDay(t, s, "2026-10-20", map[string]float64{"ABC": 4.0, "XYZ": 1.0})
	seedShortsDay(t, s, "2026-10-21", map[string]float64{"ABC": 5.5, "XYZ": 1.0})
	seedShortsDay(t, s, "2026-10-22", map[string]float64{"ABC": 5.6, "XYZ": 1.0})

	w, err := s.ReportWindow(ctx)
	require.NoError(t, err)
	assert.Equal(t, []string{"2026-10-22", "2026-10-21", "2026-10-20"}, w.Dates)
	assert.Equal(t, "ABC Holdings", w.Names["ABC"])

	got, ok := w.FindShortInterestCrossing("ABC", 5)
	require.True(t, ok)
	assert.Equal(t, "2026-10-21", got.ReportDate)
	assert.Equal(t, "2026-10-20", got.ComparedTo)
	assert.Equal(t, 4.0, got.Previous)
	assert.Equal(t, 5.5, got.Latest)

	// A second date above the threshold is not a crossing: 5.5 -> 5.6.
	_, err = w.CrossingOn("ABC", "2026-10-22", 5)
	require.Error(t, err)
}

// Monitor ownership is decided in the store: another owner's monitor reads as
// not owned, with no events, so an id that is not the caller's is never empty.
func TestAdminAlertEventsOnDateReadOnlyTheOwnersMonitors(t *testing.T) {
	s := alertsTestStore(t)
	ctx := context.Background()
	mine := alertsTestMonitor(t, s, "uid-admin", "ABC")
	theirs := alertsTestMonitor(t, s, "uid-other", "XYZ")
	insertAlertEvent(t, s, mine.ID, "2026-10-21", "2026-10-20", "sent")
	insertAlertEvent(t, s, theirs.ID, "2026-10-21", "2026-10-20", "sent")

	owned, events, err := s.AdminAlertEventsOnDate(ctx, "uid-admin", mine.ID, "2026-10-21")
	require.NoError(t, err)
	assert.True(t, owned)
	require.Len(t, events, 1)
	assert.Equal(t, "sent", events[0].EmailStatus)

	owned, events, err = s.AdminAlertEventsOnDate(ctx, "uid-admin", theirs.ID, "2026-10-21")
	require.NoError(t, err)
	assert.False(t, owned)
	assert.Empty(t, events)
}

func TestAdminAlertMonitorCountsAreAggregatesOnly(t *testing.T) {
	s := alertsTestStore(t)
	ctx := context.Background()
	alertsTestMonitor(t, s, "uid-a", "ABC")
	alertsTestMonitor(t, s, "uid-b", "XYZ")
	counts, err := s.AdminAlertMonitorCounts(ctx)
	require.NoError(t, err)
	require.Len(t, counts, 1)
	assert.Equal(t, AlertMonitorCount{Status: "active", Cadence: "daily", Count: 2}, counts[0])
}
