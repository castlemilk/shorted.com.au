//go:build integration

package shorts

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// alertsTestBaseSchema is what the alert migrations read before they run: the
// trigger on alert_monitors calls update_updated_at_column, and the evaluator
// reads company-metadata and shorts. Only the columns the queries touch exist.
const alertsTestBaseSchema = `
CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW.updated_at = CURRENT_TIMESTAMP;
	RETURN NEW;
END;
$$;

CREATE TABLE "company-metadata" (
	stock_code   VARCHAR(50) PRIMARY KEY,
	company_name TEXT,
	industry     TEXT
);

CREATE TABLE shorts (
	"DATE"         TIMESTAMP NOT NULL,
	"PRODUCT_CODE" TEXT NOT NULL,
	"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DOUBLE PRECISION
);
`

// alertsTestStore returns a store on a fresh database holding the real alert
// tables. Migration 000147 is applied twice, which is the replay the deploy runs
// on every release, so the test also proves the second run is a no-op.
// SHORTS_TEST_POSTGRES_URL names a disposable server, as for the other real-Postgres
// tests. Without it, ALERTS_E2E_TESTCONTAINERS=1 starts one in a container (CI), and
// the test skips when neither is set.
func alertsTestStore(t *testing.T) *postgresStore {
	t.Helper()
	adminURL, err := testpostgres.Admin("SHORTS_TEST_POSTGRES_URL", "ALERTS_E2E_TESTCONTAINERS")
	require.NoError(t, err, "start the alerts PostgreSQL container")
	if adminURL == "" {
		t.Skip("neither SHORTS_TEST_POSTGRES_URL nor ALERTS_E2E_TESTCONTAINERS=1 is set; skipping the real-Postgres alert store tests")
	}
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}

	pool, cleanup := isolatedTestDatabase(t, adminURL, "alerts_store")
	t.Cleanup(cleanup)

	ctx := context.Background()
	_, err = pool.Exec(ctx, alertsTestBaseSchema)
	require.NoError(t, err)
	for _, file := range []string{
		"000074_add_alert_monitors.up.sql",
		"000147_add_alert_events.up.sql",
		"000147_add_alert_events.up.sql",
		"000148_add_email_suppression.up.sql",
		"000148_add_email_suppression.up.sql",
	} {
		sql, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", file))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, string(sql))
		require.NoError(t, err, file)
	}
	return &postgresStore{db: pool}
}

func alertsTestMonitor(t *testing.T, s *postgresStore, userID, target string) *AlertMonitor {
	t.Helper()
	threshold := 5.0
	monitor, err := s.CreateAlertMonitor(CreateAlertMonitorInput{
		UserID:    userID,
		UserEmail: userID + "@example.com",
		Scope:     "stock",
		Target:    target,
		Condition: "short_interest_above",
		Threshold: &threshold,
		Cadence:   "daily",
	})
	require.NoError(t, err)
	return monitor
}

// insertAlertEvent writes an event for a monitor, copying the monitor's settings
// the way the evaluator does.
func insertAlertEvent(t *testing.T, s *postgresStore, monitorID, reportDate, comparedTo, status string) {
	t.Helper()
	tag, err := s.db.Exec(context.Background(), `
		INSERT INTO alert_events (
			monitor_id, user_id, scope, target, condition, threshold, cadence,
			report_date, compared_to_date, payload, email_status
		)
		SELECT id, user_id, scope, target, condition, threshold, cadence,
		       $2::date, $3::date, '{"companies":[],"companies_total":0}'::jsonb, $4
		FROM alert_monitors
		WHERE id = $1
	`, monitorID, reportDate, comparedTo, status)
	require.NoError(t, err)
	require.EqualValues(t, 1, tag.RowsAffected())
}

func TestAlertMonitorsAreOwnedByTheirUser(t *testing.T) {
	s := alertsTestStore(t)
	owner := alertsTestMonitor(t, s, "user-a", "BHP")

	_, err := s.UpdateAlertMonitorStatus("user-b", owner.ID, "paused", "")
	assert.ErrorIs(t, err, ErrAlertMonitorNotFound, "another user cannot pause the monitor")
	assert.ErrorIs(t, s.DeleteAlertMonitor("user-b", owner.ID), ErrAlertMonitorNotFound, "another user cannot delete it")

	monitors, total, err := s.ListAlertMonitors("user-b", 20, 0)
	require.NoError(t, err)
	assert.Empty(t, monitors)
	assert.EqualValues(t, 0, total)

	events, eventTotal, err := s.ListAlertEvents("user-b", "", 20, 0)
	require.NoError(t, err)
	assert.Empty(t, events)
	assert.EqualValues(t, 0, eventTotal)

	// The refused calls changed nothing: the owner can still pause it.
	paused, err := s.UpdateAlertMonitorStatus("user-a", owner.ID, "paused", "")
	require.NoError(t, err)
	assert.Equal(t, "paused", paused.Status)
}

func TestDeleteAlertMonitorCascadesItsEvents(t *testing.T) {
	s := alertsTestStore(t)
	monitor := alertsTestMonitor(t, s, "user-a", "BHP")
	insertAlertEvent(t, s, monitor.ID, "2026-10-15", "2026-10-14", "sent")
	insertAlertEvent(t, s, monitor.ID, "2026-10-16", "2026-10-15", "skipped_unentitled")

	require.NoError(t, s.DeleteAlertMonitor("user-a", monitor.ID))

	var remaining int
	require.NoError(t, s.db.QueryRow(context.Background(),
		`SELECT count(*) FROM alert_events WHERE monitor_id = $1`, monitor.ID).Scan(&remaining))
	assert.Equal(t, 0, remaining, "deleting a monitor removes its event history")

	assert.ErrorIs(t, s.DeleteAlertMonitor("user-a", monitor.ID), ErrAlertMonitorNotFound, "a second delete finds nothing")
}

func TestResumingADuplicateMapsToExists(t *testing.T) {
	s := alertsTestStore(t)
	first := alertsTestMonitor(t, s, "user-a", "BHP")
	_, err := s.UpdateAlertMonitorStatus("user-a", first.ID, "paused", "")
	require.NoError(t, err)

	// While the first is paused, an identical monitor may be active.
	_ = alertsTestMonitor(t, s, "user-a", "BHP")

	_, err = s.UpdateAlertMonitorStatus("user-a", first.ID, "active", "")
	assert.ErrorIs(t, err, ErrAlertMonitorExists, "resuming would duplicate the active monitor")

	monitors, _, err := s.ListAlertMonitors("user-a", 20, 0)
	require.NoError(t, err)
	for _, m := range monitors {
		if m.ID == first.ID {
			assert.Equal(t, "paused", m.Status, "a refused resume leaves the monitor paused")
		}
	}
}

func TestUpdateAlertMonitorStatusRefreshesTheEmailOnlyWhenGiven(t *testing.T) {
	s := alertsTestStore(t)
	monitor := alertsTestMonitor(t, s, "user-a", "BHP")

	updated, err := s.UpdateAlertMonitorStatus("user-a", monitor.ID, "paused", "new@example.com")
	require.NoError(t, err)
	assert.Equal(t, "new@example.com", updated.UserEmail)

	kept, err := s.UpdateAlertMonitorStatus("user-a", monitor.ID, "active", "")
	require.NoError(t, err)
	assert.Equal(t, "new@example.com", kept.UserEmail, "an empty email leaves the stored address alone")
}

func TestListAlertMonitorsCarriesTheNewestEvent(t *testing.T) {
	s := alertsTestStore(t)
	fired := alertsTestMonitor(t, s, "user-a", "BHP")
	quiet := alertsTestMonitor(t, s, "user-a", "CBA")
	insertAlertEvent(t, s, fired.ID, "2026-10-14", "2026-10-13", "sent")
	insertAlertEvent(t, s, fired.ID, "2026-10-16", "2026-10-15", "skipped_unentitled")
	insertAlertEvent(t, s, fired.ID, "2026-10-15", "2026-10-14", "sent")

	monitors, total, err := s.ListAlertMonitors("user-a", 20, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 2, total)

	byID := map[string]*AlertMonitor{}
	for _, m := range monitors {
		byID[m.ID] = m
	}
	require.NotNil(t, byID[fired.ID].LastEventReportDate)
	assert.Equal(t, "2026-10-16", *byID[fired.ID].LastEventReportDate, "the newest report, not the newest insert")
	require.NotNil(t, byID[fired.ID].LastEventEmailStatus)
	assert.Equal(t, "skipped_unentitled", *byID[fired.ID].LastEventEmailStatus)
	require.NotNil(t, byID[fired.ID].LastEventAt)

	assert.Nil(t, byID[quiet.ID].LastEventReportDate, "a monitor that never fired has no last event")
	assert.Nil(t, byID[quiet.ID].LastEventEmailStatus)
}

func TestPauseAlertMonitorByIDReportsAlreadyPaused(t *testing.T) {
	s := alertsTestStore(t)
	monitor := alertsTestMonitor(t, s, "user-a", "BHP")

	paused, alreadyPaused, err := s.PauseAlertMonitorByID(monitor.ID)
	require.NoError(t, err)
	assert.False(t, alreadyPaused)
	assert.Equal(t, "paused", paused.Status)

	again, alreadyPaused, err := s.PauseAlertMonitorByID(monitor.ID)
	require.NoError(t, err)
	assert.True(t, alreadyPaused, "a second pause changes nothing and says so")
	assert.Equal(t, "paused", again.Status)

	_, _, err = s.PauseAlertMonitorByID("11111111-1111-1111-1111-111111111111")
	assert.ErrorIs(t, err, ErrAlertMonitorNotFound)
}

func TestListAlertEventsFiltersByMonitorAndPages(t *testing.T) {
	s := alertsTestStore(t)
	first := alertsTestMonitor(t, s, "user-a", "BHP")
	second := alertsTestMonitor(t, s, "user-a", "CBA")
	insertAlertEvent(t, s, first.ID, "2026-10-14", "2026-10-13", "sent")
	insertAlertEvent(t, s, first.ID, "2026-10-15", "2026-10-14", "sent")
	insertAlertEvent(t, s, second.ID, "2026-10-16", "2026-10-15", "failed")

	all, total, err := s.ListAlertEvents("user-a", "", 20, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 3, total)
	require.Len(t, all, 3)
	assert.Equal(t, "2026-10-16", all[0].ReportDate, "newest report first")

	mine, total, err := s.ListAlertEvents("user-a", first.ID, 20, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 2, total)
	assert.Len(t, mine, 2)
	for _, e := range mine {
		assert.Equal(t, first.ID, e.MonitorID)
	}

	page, total, err := s.ListAlertEvents("user-a", "", 1, 1)
	require.NoError(t, err)
	assert.EqualValues(t, 3, total, "the total ignores the page")
	require.Len(t, page, 1)
	assert.Equal(t, "2026-10-15", page[0].ReportDate)
}

func TestCanonicalIndustryPicksTheMostCommonSpellingAndSkipsPlaceholders(t *testing.T) {
	s := alertsTestStore(t)
	ctx := context.Background()
	_, err := s.db.Exec(ctx, `
		INSERT INTO "company-metadata" (stock_code, company_name, industry) VALUES
		('BHP', 'BHP', 'Materials'),
		('RIO', 'RIO', 'Materials'),
		('LTR', 'LTR', 'MATERIALS'),
		('H1', 'H1', 'health care equipment services'),
		('H2', 'H2', 'health care equipment services'),
		('H3', 'H3', 'health care equipment services'),
		('H4', 'H4', 'Health Care Equipment & Services'),
		('X1', 'X1', 'Not Applic'),
		('X2', 'X2', 'Not Applic'),
		('O1', 'O1', '  Other  '),
		('CBA', 'CBA', 'Banks')
	`)
	require.NoError(t, err)

	got, found, err := s.CanonicalIndustry("materials")
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, "Materials", got, "two companies carry Materials and one MATERIALS")

	got, found, err = s.CanonicalIndustry("Health Care Equipment & Services")
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, "health care equipment services", got, "three companies carry the lower-case spelling")

	_, found, err = s.CanonicalIndustry("Not Applic")
	require.NoError(t, err)
	assert.False(t, found, "a placeholder is never a target")

	_, found, err = s.CanonicalIndustry("Other")
	require.NoError(t, err)
	assert.False(t, found, "other is a placeholder, however it is spelled")

	_, found, err = s.CanonicalIndustry("Nonexistent Industry")
	require.NoError(t, err)
	assert.False(t, found)
}

func TestStockCodeKnownAcceptsMetadataOrRecentReports(t *testing.T) {
	s := alertsTestStore(t)
	ctx := context.Background()
	_, err := s.db.Exec(ctx, `INSERT INTO "company-metadata" (stock_code, company_name, industry) VALUES ('CBA', 'CBA', 'Banks')`)
	require.NoError(t, err)
	_, err = s.db.Exec(ctx, `
		INSERT INTO shorts ("DATE", "PRODUCT_CODE") VALUES
		(now() - interval '5 days', 'XYZ'),
		(now() - interval '60 days', 'OLD')
	`)
	require.NoError(t, err)

	for code, want := range map[string]bool{
		"CBA":  true,
		"xyz":  true,
		"OLD":  false,
		"NOPE": false,
	} {
		got, err := s.StockCodeKnown(code)
		require.NoError(t, err, code)
		assert.Equal(t, want, got, code)
	}
}

func TestAlertCheckedThroughIsEmptyUntilTheFirstRun(t *testing.T) {
	s := alertsTestStore(t)
	ctx := context.Background()

	through, err := s.AlertCheckedThrough()
	require.NoError(t, err)
	assert.Equal(t, "", through, "no evaluator row yet")

	_, err = s.db.Exec(ctx, `INSERT INTO alert_evaluator_state (id, daily_through) VALUES (1, '2026-10-22')`)
	require.NoError(t, err)
	through, err = s.AlertCheckedThrough()
	require.NoError(t, err)
	assert.Equal(t, "2026-10-22", through)

	_, err = s.db.Exec(ctx, `UPDATE alert_evaluator_state SET daily_through = NULL WHERE id = 1`)
	require.NoError(t, err)
	through, err = s.AlertCheckedThrough()
	require.NoError(t, err)
	assert.Equal(t, "", through, "a state row with no daily date reads as not yet checked")
}

// The cap is checked inside the insert and the resume statement. Paused monitors do
// not count, and another user is never affected.
func TestActiveAlertMonitorsAreCapped(t *testing.T) {
	s := alertsTestStore(t)
	var firstID string
	for i := 0; i < MaxActiveAlertMonitors; i++ {
		m := alertsTestMonitor(t, s, "capuser", fmt.Sprintf("C%02d", i))
		if i == 0 {
			firstID = m.ID
		}
	}

	threshold := 5.0
	_, err := s.CreateAlertMonitor(CreateAlertMonitorInput{
		UserID: "capuser", UserEmail: "capuser@example.com", Scope: "stock", Target: "OVER",
		Condition: "short_interest_above", Threshold: &threshold, Cadence: "daily",
	})
	require.ErrorIs(t, err, ErrAlertMonitorLimit, "the cap+1 monitor must be refused")

	// Another user has their own allowance.
	alertsTestMonitor(t, s, "otheruser", "BHP")

	// Pausing one frees a slot, and the paused monitor is not counted.
	_, err = s.UpdateAlertMonitorStatus("capuser", firstID, "paused", "")
	require.NoError(t, err)
	_, err = s.CreateAlertMonitor(CreateAlertMonitorInput{
		UserID: "capuser", UserEmail: "capuser@example.com", Scope: "stock", Target: "OVER",
		Condition: "short_interest_above", Threshold: &threshold, Cadence: "daily",
	})
	require.NoError(t, err, "a paused monitor frees its slot")
}

// Resuming a paused monitor is refused at the cap. Pausing, and resuming a monitor that
// is already active, are not, so the cap never strands a customer's existing alerts.
func TestResumeAtTheAlertCapIsRefusedButPauseAndNoOpResumeAreNot(t *testing.T) {
	s := alertsTestStore(t)
	var paused string
	for i := 0; i < MaxActiveAlertMonitors; i++ {
		m := alertsTestMonitor(t, s, "capuser", fmt.Sprintf("R%02d", i))
		if i == 0 {
			paused = m.ID
		}
	}
	var active string
	_, err := s.UpdateAlertMonitorStatus("capuser", paused, "paused", "")
	require.NoError(t, err)
	// Every other monitor is active, so the cap is reached again with the new one.
	threshold := 5.0
	created, err := s.CreateAlertMonitor(CreateAlertMonitorInput{
		UserID: "capuser", UserEmail: "capuser@example.com", Scope: "stock", Target: "NEW",
		Condition: "short_interest_above", Threshold: &threshold, Cadence: "daily",
	})
	require.NoError(t, err)
	active = created.ID

	_, err = s.UpdateAlertMonitorStatus("capuser", paused, "active", "")
	require.ErrorIs(t, err, ErrAlertMonitorLimit, "resuming past the cap is refused")

	_, err = s.UpdateAlertMonitorStatus("capuser", active, "active", "")
	require.NoError(t, err, "an already-active monitor resumes as a no-op even at the cap")

	_, err = s.UpdateAlertMonitorStatus("capuser", active, "paused", "")
	require.NoError(t, err, "pausing is never refused")

	_, err = s.UpdateAlertMonitorStatus("capuser", "00000000-0000-0000-0000-000000000000", "active", "")
	require.ErrorIs(t, err, ErrAlertMonitorNotFound, "a monitor that is not the user's is not found, even at the cap")
}

// A monitor created before the address was verified is stored with no address. The
// refresh points that user's monitors at the verified address, and touches no one else.
func TestRefreshAlertMonitorEmailReachesOnlyStaleRowsOfTheUser(t *testing.T) {
	s := alertsTestStore(t)
	threshold := 5.0
	unverified, err := s.CreateAlertMonitor(CreateAlertMonitorInput{
		UserID: "u1", UserEmail: "", Scope: "stock", Target: "AAA",
		Condition: "short_interest_above", Threshold: &threshold, Cadence: "daily",
	})
	require.NoError(t, err)
	require.Empty(t, unverified.UserEmail, "an unverified address is stored as NULL")
	other := alertsTestMonitor(t, s, "u2", "BBB")

	require.NoError(t, s.RefreshAlertMonitorEmail("u1", "u1@verified.example"))
	monitors, _, err := s.ListAlertMonitors("u1", 10, 0)
	require.NoError(t, err)
	require.Len(t, monitors, 1)
	assert.Equal(t, "u1@verified.example", monitors[0].UserEmail)

	untouched, _, err := s.ListAlertMonitors("u2", 10, 0)
	require.NoError(t, err)
	require.Len(t, untouched, 1)
	assert.Equal(t, other.UserEmail, untouched[0].UserEmail, "another user's monitors are not refreshed")

	require.NoError(t, s.RefreshAlertMonitorEmail("u1", ""), "an empty address changes nothing")
	monitors, _, err = s.ListAlertMonitors("u1", 10, 0)
	require.NoError(t, err)
	assert.Equal(t, "u1@verified.example", monitors[0].UserEmail)
}
