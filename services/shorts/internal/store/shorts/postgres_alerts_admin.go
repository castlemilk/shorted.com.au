package shorts

// postgres_alerts_admin.go: the read-side queries behind the admin MCP server's
// alerts tools (services/shorts/internal/services/shorts/mcp_admin_alerts.go).
//
// These are operator views, so they read across owners. The rows they return
// carry the owner's id (UserID) ONLY so the caller can compute "is this mine";
// the admin service layer never passes UserID, or any address, to a client.

import (
	"context"
	"fmt"
	"time"
)

// AdminAlertsStore is the admin alerts view of the store. Reached by a type
// assertion, like BillingStore, so the shared Store interface and its mocks are
// unchanged.
type AdminAlertsStore interface {
	ReportWindow(ctx context.Context) (AlertWindow, error)
	AdminAlertMonitorCounts(ctx context.Context) ([]AlertMonitorCount, error)
	AdminAlertDeliveryHealth(ctx context.Context) (AlertDeliveryHealth, error)
	AdminAlertEvaluatorRuns(ctx context.Context, limit int) ([]AdminAlertRun, error)
	AdminRecentAlertEvents(ctx context.Context, limit int) ([]AdminAlertEvent, error)
	AdminAlertEventsOnDate(ctx context.Context, userID, monitorID, reportDate string) (owned bool, events []AdminAlertEvent, err error)
}

// AlertMonitorCount is how many monitors hold one status and cadence.
type AlertMonitorCount struct {
	Status  string
	Cadence string
	Count   int
}

// AdminAlertRun is one evaluator run (alert_evaluator_runs).
type AdminAlertRun struct {
	ID                int64
	StartedAt         time.Time
	FinishedAt        *time.Time
	Outcome           string
	Note              string
	MonitorsEvaluated int
	EventsCreated     int
	EmailsSent        int
	EmailsRetrying    int
	EmailsFailed      int
	SkippedUnentitled int
	HasCanaryResendID bool
	Error             string
}

// AdminAlertEvent is one alert_events row. UserID is the owner, for the caller's
// own-or-not check only.
type AdminAlertEvent struct {
	ID              int64
	MonitorID       string
	UserID          string
	Target          string
	ReportDate      string
	ComparedToDate  string
	LatestPercent   *float64
	PreviousPercent *float64
	EmailStatus     string
	EmailAttempts   int
	HasResendID     bool
	LastError       string
	// CreatedAt is when the row was written. A replay's insert is ON CONFLICT DO
	// NOTHING, so a row older than the replay that found it is not that replay's.
	CreatedAt time.Time
	// RunID is alert_evaluator_runs.id of the run that wrote the row, 0 when the
	// row has none.
	RunID int64
}

// AdminAlertMonitorCounts counts every monitor by status and cadence, across owners.
// Counts only: no owner, address or target leaves the store here.
func (s *postgresStore) AdminAlertMonitorCounts(ctx context.Context) ([]AlertMonitorCount, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT status, cadence, count(*)::int
		  FROM alert_monitors
		 GROUP BY status, cadence
		 ORDER BY status, cadence`)
	if err != nil {
		return nil, fmt.Errorf("count alert monitors: %w", err)
	}
	defer rows.Close()
	var out []AlertMonitorCount
	for rows.Next() {
		var c AlertMonitorCount
		if err := rows.Scan(&c.Status, &c.Cadence, &c.Count); err != nil {
			return nil, fmt.Errorf("scan alert monitor count: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// AdminAlertEvaluatorRuns returns the newest evaluator runs, newest first.
func (s *postgresStore) AdminAlertEvaluatorRuns(ctx context.Context, limit int) ([]AdminAlertRun, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT id, started_at, finished_at, outcome, COALESCE(note, ''),
		       monitors_evaluated, events_created, emails_sent, emails_retrying, emails_failed,
		       skipped_unentitled, canary_resend_id IS NOT NULL, COALESCE(error, '')
		  FROM alert_evaluator_runs
		 ORDER BY started_at DESC, id DESC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("read alert evaluator runs: %w", err)
	}
	defer rows.Close()
	var out []AdminAlertRun
	for rows.Next() {
		var r AdminAlertRun
		if err := rows.Scan(&r.ID, &r.StartedAt, &r.FinishedAt, &r.Outcome, &r.Note,
			&r.MonitorsEvaluated, &r.EventsCreated, &r.EmailsSent, &r.EmailsRetrying, &r.EmailsFailed,
			&r.SkippedUnentitled, &r.HasCanaryResendID, &r.Error); err != nil {
			return nil, fmt.Errorf("scan alert evaluator run: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AdminRecentAlertEvents returns the newest alert events across owners, newest first.
func (s *postgresStore) AdminRecentAlertEvents(ctx context.Context, limit int) ([]AdminAlertEvent, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	rows, err := s.db.Query(ctx, `
		SELECT id, monitor_id, user_id, target, report_date::text, compared_to_date::text,
		       latest_percent, previous_percent, email_status, email_attempts,
		       resend_id IS NOT NULL, COALESCE(last_error, ''), created_at, COALESCE(run_id, 0)
		  FROM alert_events
		 ORDER BY created_at DESC, id DESC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("read alert events: %w", err)
	}
	defer rows.Close()
	var out []AdminAlertEvent
	for rows.Next() {
		e, err := scanAdminAlertEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// AdminAlertEventsOnDate returns one monitor's events on one report date, and
// whether the monitor belongs to userID. The events are read only when it does,
// so a monitor id that is not the caller's reads as not owned, never as empty.
func (s *postgresStore) AdminAlertEventsOnDate(ctx context.Context, userID, monitorID, reportDate string) (bool, []AdminAlertEvent, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var owned bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM alert_monitors WHERE id = $1 AND user_id = $2)`,
		monitorID, userID).Scan(&owned); err != nil {
		return false, nil, fmt.Errorf("check alert monitor owner: %w", err)
	}
	if !owned {
		return false, nil, nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, monitor_id, user_id, target, report_date::text, compared_to_date::text,
		       latest_percent, previous_percent, email_status, email_attempts,
		       resend_id IS NOT NULL, COALESCE(last_error, ''), created_at, COALESCE(run_id, 0)
		  FROM alert_events
		 WHERE monitor_id = $1 AND report_date = $2::date
		 ORDER BY id`, monitorID, reportDate)
	if err != nil {
		return true, nil, fmt.Errorf("read alert events on date: %w", err)
	}
	defer rows.Close()
	var out []AdminAlertEvent
	for rows.Next() {
		e, err := scanAdminAlertEvent(rows)
		if err != nil {
			return true, nil, err
		}
		out = append(out, e)
	}
	return true, out, rows.Err()
}

func scanAdminAlertEvent(rows interface{ Scan(...any) error }) (AdminAlertEvent, error) {
	var e AdminAlertEvent
	if err := rows.Scan(&e.ID, &e.MonitorID, &e.UserID, &e.Target, &e.ReportDate, &e.ComparedToDate,
		&e.LatestPercent, &e.PreviousPercent, &e.EmailStatus, &e.EmailAttempts,
		&e.HasResendID, &e.LastError, &e.CreatedAt, &e.RunID); err != nil {
		return AdminAlertEvent{}, fmt.Errorf("scan alert event: %w", err)
	}
	return e, nil
}
