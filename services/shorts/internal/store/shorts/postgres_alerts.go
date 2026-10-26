package shorts

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/industry"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const alertMonitorColumns = `
	id,
	user_id,
	COALESCE(user_email, ''),
	scope,
	target,
	condition,
	threshold,
	cadence,
	status,
	created_at,
	updated_at`

// CreateAlertMonitor persists a user-owned short-interest alert monitor. The cap is
// checked in the same statement as the insert, so two creates racing at the cap can
// overshoot it by at most the number of requests in flight. It answers
// ErrAlertMonitorLimit when the user already holds MaxActiveAlertMonitors.
func (s *postgresStore) CreateAlertMonitor(input CreateAlertMonitorInput) (*AlertMonitor, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	query := `
		INSERT INTO alert_monitors (
			user_id,
			user_email,
			scope,
			target,
			condition,
			threshold,
			cadence
		)
		SELECT $1::text, NULLIF($2::text, ''), $3::text, $4::text, $5::text, $6::double precision, $7::text
		WHERE (SELECT count(*) FROM alert_monitors WHERE user_id = $1::text AND status = 'active') < $8::bigint
		RETURNING ` + alertMonitorColumns

	monitor, err := scanAlertMonitor(s.db.QueryRow(
		ctx,
		query,
		input.UserID,
		input.UserEmail,
		input.Scope,
		input.Target,
		input.Condition,
		input.Threshold,
		input.Cadence,
		int64(MaxActiveAlertMonitors),
	))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAlertMonitorLimit
		}
		if isAlertMonitorUniqueViolation(err) {
			return nil, ErrAlertMonitorExists
		}
		return nil, fmt.Errorf("failed to create alert monitor: %w", err)
	}

	return monitor, nil
}

// RefreshAlertMonitorEmail points every one of the user's monitors at the address the
// user has verified. The alerts page calls it on each visit, so a monitor created
// before the address was verified starts emailing without being recreated. Rows that
// already hold the address are not written. An empty address changes nothing.
func (s *postgresStore) RefreshAlertMonitorEmail(userID, userEmail string) error {
	if userEmail == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := s.db.Exec(ctx, `
		UPDATE alert_monitors
		   SET user_email = $2
		 WHERE user_id = $1 AND user_email IS DISTINCT FROM $2`, userID, userEmail); err != nil {
		return fmt.Errorf("failed to refresh alert monitor email: %w", err)
	}
	return nil
}

// ListAlertMonitors returns the current user's monitors ordered newest first, each
// with its newest alert event.
func (s *postgresStore) ListAlertMonitors(userID string, limit, offset int32) ([]*AlertMonitor, int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if offset < 0 {
		offset = 0
	}

	var total int32
	if err := s.db.QueryRow(ctx, `
		SELECT count(*)::int
		FROM alert_monitors
		WHERE user_id = $1
	`, userID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("failed to count alert monitors: %w", err)
	}

	rows, err := s.db.Query(ctx, `
		SELECT
			m.id,
			m.user_id,
			COALESCE(m.user_email, ''),
			m.scope,
			m.target,
			m.condition,
			m.threshold,
			m.cadence,
			m.status,
			m.created_at,
			m.updated_at,
			last.report_date::text,
			last.email_status,
			last.created_at
		FROM alert_monitors m
		LEFT JOIN LATERAL (
			SELECT e.report_date, e.email_status, e.created_at
			FROM alert_events e
			WHERE e.monitor_id = m.id
			ORDER BY e.report_date DESC, e.id DESC
			LIMIT 1
		) last ON true
		WHERE m.user_id = $1
		ORDER BY m.created_at DESC, m.id DESC
		LIMIT $2 OFFSET $3
	`, userID, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list alert monitors: %w", err)
	}
	defer rows.Close()

	monitors := make([]*AlertMonitor, 0, limit)
	for rows.Next() {
		monitor, err := scanAlertMonitorWithLastEvent(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to scan alert monitor: %w", err)
		}
		monitors = append(monitors, monitor)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("failed to iterate alert monitors: %w", err)
	}

	return monitors, total, nil
}

// UpdateAlertMonitorStatus sets a monitor to active or paused. It answers
// ErrAlertMonitorNotFound when the monitor is not the user's, ErrAlertMonitorExists
// when resuming it would duplicate an active monitor, and ErrAlertMonitorLimit when
// resuming it would take the user past MaxActiveAlertMonitors. A non-empty userEmail
// replaces the stored address, so a changed address takes effect on the next alert.
func (s *postgresStore) UpdateAlertMonitorStatus(userID, monitorID, status, userEmail string) (*AlertMonitor, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	monitor, err := scanAlertMonitor(s.db.QueryRow(ctx, `
		UPDATE alert_monitors AS m
		SET status = $3,
		    user_email = COALESCE(NULLIF($4, ''), m.user_email)
		WHERE m.id = $2 AND m.user_id = $1
		  AND ($3 <> 'active' OR m.status = 'active' OR (
		        SELECT count(*) FROM alert_monitors AS o
		         WHERE o.user_id = $1 AND o.status = 'active') < $5::bigint)
		RETURNING `+alertMonitorColumns, userID, monitorID, status, userEmail, int64(MaxActiveAlertMonitors)))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// No row is either a monitor that is not the user's, or a resume refused by
			// the cap. Tell them apart so the caller can say which.
			var exists bool
			if qerr := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM alert_monitors WHERE id = $2 AND user_id = $1)`,
				userID, monitorID).Scan(&exists); qerr != nil {
				return nil, fmt.Errorf("failed to check alert monitor: %w", qerr)
			}
			if !exists {
				return nil, ErrAlertMonitorNotFound
			}
			return nil, ErrAlertMonitorLimit
		}
		if isAlertMonitorUniqueViolation(err) {
			return nil, ErrAlertMonitorExists
		}
		return nil, fmt.Errorf("failed to update alert monitor: %w", err)
	}
	return monitor, nil
}

// DeleteAlertMonitor removes one of the user's monitors. Its alert events are
// removed with it.
func (s *postgresStore) DeleteAlertMonitor(userID, monitorID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	tag, err := s.db.Exec(ctx, `DELETE FROM alert_monitors WHERE id = $2 AND user_id = $1`, userID, monitorID)
	if err != nil {
		return fmt.Errorf("failed to delete alert monitor: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrAlertMonitorNotFound
	}
	return nil
}

// PauseAlertMonitorByID pauses a monitor by id, without an owner check: the id
// comes from a signed token, which is the authority. It reports whether the
// monitor was already paused, and ErrAlertMonitorNotFound when no monitor has the
// id.
func (s *postgresStore) PauseAlertMonitorByID(monitorID string) (*AlertMonitor, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	monitor, err := scanAlertMonitor(s.db.QueryRow(ctx, `
		UPDATE alert_monitors
		SET status = 'paused'
		WHERE id = $1 AND status = 'active'
		RETURNING `+alertMonitorColumns, monitorID))
	if err == nil {
		return monitor, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, fmt.Errorf("failed to pause alert monitor: %w", err)
	}

	// Not active: it is already paused, or it does not exist.
	monitor, err = scanAlertMonitor(s.db.QueryRow(ctx, `
		SELECT `+alertMonitorColumns+`
		FROM alert_monitors
		WHERE id = $1`, monitorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, ErrAlertMonitorNotFound
	}
	if err != nil {
		return nil, false, fmt.Errorf("failed to read alert monitor: %w", err)
	}
	return monitor, true, nil
}

// ListAlertEvents returns the user's alert events, newest report first. A
// non-empty monitorID restricts the list to that monitor.
func (s *postgresStore) ListAlertEvents(userID, monitorID string, limit, offset int32) ([]*AlertEvent, int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if offset < 0 {
		offset = 0
	}

	var total int32
	if err := s.db.QueryRow(ctx, `
		SELECT count(*)::int
		FROM alert_events
		WHERE user_id = $1 AND ($2 = '' OR monitor_id = $2)
	`, userID, monitorID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("failed to count alert events: %w", err)
	}

	rows, err := s.db.Query(ctx, `
		SELECT
			id,
			monitor_id,
			scope,
			target,
			condition,
			threshold,
			cadence,
			report_date::text,
			compared_to_date::text,
			payload,
			email_status,
			sent_at,
			created_at
		FROM alert_events
		WHERE user_id = $1 AND ($2 = '' OR monitor_id = $2)
		ORDER BY report_date DESC, id DESC
		LIMIT $3 OFFSET $4
	`, userID, monitorID, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list alert events: %w", err)
	}
	defer rows.Close()

	events := make([]*AlertEvent, 0, limit)
	for rows.Next() {
		event := &AlertEvent{}
		var threshold *float64
		if err := rows.Scan(
			&event.ID,
			&event.MonitorID,
			&event.Scope,
			&event.Target,
			&event.Condition,
			&threshold,
			&event.Cadence,
			&event.ReportDate,
			&event.ComparedToDate,
			&event.Payload,
			&event.EmailStatus,
			&event.SentAt,
			&event.CreatedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("failed to scan alert event: %w", err)
		}
		event.Threshold = threshold
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("failed to iterate alert events: %w", err)
	}

	return events, total, nil
}

// CanonicalIndustry returns the spelling of an industry that a target names. It
// matches by industry.Slug against the industry on company-metadata, skips
// placeholders, and keeps the spelling the most companies carry (a tie goes to
// the name sorting first). The bool is false when no industry matches.
func (s *postgresStore) CanonicalIndustry(target string) (string, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	want := industry.Slug(target)
	if industry.IsPlaceholderSlug(want) {
		return "", false, nil
	}

	rows, err := s.db.Query(ctx, `
		SELECT btrim(industry), count(*)::int
		FROM "company-metadata"
		WHERE industry IS NOT NULL AND btrim(industry) <> ''
		GROUP BY btrim(industry)
	`)
	if err != nil {
		return "", false, fmt.Errorf("failed to read industries: %w", err)
	}
	defer rows.Close()

	type spelling struct {
		name  string
		count int
	}
	var matches []spelling
	for rows.Next() {
		var name string
		var count int
		if err := rows.Scan(&name, &count); err != nil {
			return "", false, fmt.Errorf("failed to scan industry: %w", err)
		}
		if industry.IsPlaceholder(name) || industry.Slug(name) != want {
			continue
		}
		matches = append(matches, spelling{name: name, count: count})
	}
	if err := rows.Err(); err != nil {
		return "", false, fmt.Errorf("failed to iterate industries: %w", err)
	}
	if len(matches) == 0 {
		return "", false, nil
	}

	sort.Slice(matches, func(i, j int) bool {
		if matches[i].count != matches[j].count {
			return matches[i].count > matches[j].count
		}
		return matches[i].name < matches[j].name
	})
	return matches[0].name, true, nil
}

// StockCodeKnown reports whether code is an ASX code the site knows: one on
// company-metadata, or one reported in the last 30 days.
func (s *postgresStore) StockCodeKnown(code string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	code = strings.ToUpper(strings.TrimSpace(code))
	var known bool
	if err := s.db.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM "company-metadata" WHERE stock_code = $1)
		    OR EXISTS (
		        SELECT 1 FROM shorts
		        WHERE "PRODUCT_CODE" = $1
		          AND "DATE" >= now() - interval '30 days'
		    )
	`, code).Scan(&known); err != nil {
		return false, fmt.Errorf("failed to check stock code: %w", err)
	}
	return known, nil
}

// AlertCheckedThrough is the latest report date the evaluator has checked, as
// YYYY-MM-DD. It is empty before the evaluator's first run.
func (s *postgresStore) AlertCheckedThrough() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var through *string
	err := s.db.QueryRow(ctx, `
		SELECT to_char(daily_through, 'YYYY-MM-DD')
		FROM alert_evaluator_state
		WHERE id = 1
	`).Scan(&through)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("failed to read alert evaluator state: %w", err)
	}
	if through == nil {
		return "", nil
	}
	return *through, nil
}

func scanAlertMonitor(row pgx.Row) (*AlertMonitor, error) {
	monitor := &AlertMonitor{}
	var threshold *float64
	if err := row.Scan(
		&monitor.ID,
		&monitor.UserID,
		&monitor.UserEmail,
		&monitor.Scope,
		&monitor.Target,
		&monitor.Condition,
		&threshold,
		&monitor.Cadence,
		&monitor.Status,
		&monitor.CreatedAt,
		&monitor.UpdatedAt,
	); err != nil {
		return nil, err
	}
	monitor.Threshold = threshold
	return monitor, nil
}

func scanAlertMonitorWithLastEvent(row pgx.Row) (*AlertMonitor, error) {
	monitor := &AlertMonitor{}
	var threshold *float64
	if err := row.Scan(
		&monitor.ID,
		&monitor.UserID,
		&monitor.UserEmail,
		&monitor.Scope,
		&monitor.Target,
		&monitor.Condition,
		&threshold,
		&monitor.Cadence,
		&monitor.Status,
		&monitor.CreatedAt,
		&monitor.UpdatedAt,
		&monitor.LastEventReportDate,
		&monitor.LastEventEmailStatus,
		&monitor.LastEventAt,
	); err != nil {
		return nil, err
	}
	monitor.Threshold = threshold
	return monitor, nil
}

// isAlertMonitorUniqueViolation reports whether err is the active-monitor unique
// index (idx_alert_monitors_active_unique) refusing a duplicate.
func isAlertMonitorUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
