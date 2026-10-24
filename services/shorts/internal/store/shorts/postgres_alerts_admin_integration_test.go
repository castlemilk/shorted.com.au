//go:build integration

package shorts

import (
	"context"
	"testing"
	"time"

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

// fullWindowDays seeds a full 20-date window (the production shape), newest first from
// 2026-10-22. ABC is 5.6 on the newest date, 5.5 the day before and 4.0 the day before
// that; every other day is 1.0. XYZ is on every day, so day-to-day counts match.
func fullWindowDays(t *testing.T, s *postgresStore) []string {
	t.Helper()
	start := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)
	days := make([]string, AlertWindowDates)
	for i := range days {
		day := start.AddDate(0, 0, -i).Format("2006-01-02")
		days[i] = day
		abc := 1.0
		switch i {
		case 0:
			abc = 5.6
		case 1:
			abc = 5.5
		case 2:
			abc = 4.0
		}
		seedShortsDay(t, s, day, map[string]float64{"ABC": abc, "XYZ": 1.0})
	}
	return days
}

// The window is the evaluator's: newest first, it includes the newest date, and a
// crossing found through it is the one the evaluator's rule gives.
func TestReportWindowFindsTheCrossingTheEvaluatorWouldFire(t *testing.T) {
	s := alertsTestStore(t)
	ctx := context.Background()
	_, err := s.db.Exec(ctx, `INSERT INTO "company-metadata" (stock_code, company_name) VALUES ('ABC', 'ABC Holdings')`)
	require.NoError(t, err)
	days := fullWindowDays(t, s)

	w, err := s.ReportWindow(ctx)
	require.NoError(t, err)
	require.Len(t, w.Dates, AlertWindowDates)
	assert.Equal(t, days, w.Dates, "the window includes the newest date, newest first")
	assert.Equal(t, 5.6, w.Readings[days[0]]["ABC"], "the newest date's readings are read")
	assert.Equal(t, "ABC Holdings", w.Names["ABC"])

	got, ok := w.FindShortInterestCrossing("ABC", 5)
	require.True(t, ok)
	assert.Equal(t, days[1], got.ReportDate)
	assert.Equal(t, days[2], got.ComparedTo)
	assert.Equal(t, 4.0, got.Previous)
	assert.Equal(t, 5.5, got.Latest)

	// The newest date is 5.5 -> 5.6: already above, so not a crossing, and the reason
	// is the rule's, not a missing report.
	_, err = w.CrossingOn("ABC", days[0], 5)
	require.Error(t, err)
	assert.EqualError(t, err, "ABC did not cross 5 on "+days[0])
}

// A NULL percent is not a reading: it is absent from the window, and it does not fail
// the read. Dropping the IS NOT NULL filter makes the scan fail, which this catches.
func TestReportWindowSkipsNullReadings(t *testing.T) {
	s := alertsTestStore(t)
	ctx := context.Background()
	days := fullWindowDays(t, s)
	_, err := s.db.Exec(ctx,
		`INSERT INTO shorts ("DATE", "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
		 VALUES ($1::timestamp, 'NUL', NULL)`, days[0])
	require.NoError(t, err)

	w, err := s.ReportWindow(ctx)
	require.NoError(t, err)
	_, present := w.Readings[days[0]]["NUL"]
	assert.False(t, present, "a NULL percent is not a reading")
	assert.Equal(t, 5.6, w.Readings[days[0]]["ABC"])
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
