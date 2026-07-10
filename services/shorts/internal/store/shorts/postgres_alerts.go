package shorts

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

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

// CreateAlertMonitor persists a user-owned short-interest alert monitor.
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
		VALUES ($1, NULLIF($2, ''), $3, $4, $5, $6, $7)
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
	))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrAlertMonitorExists
		}
		return nil, fmt.Errorf("failed to create alert monitor: %w", err)
	}

	return monitor, nil
}

// ListAlertMonitors returns the current user's monitors ordered newest first.
func (s *postgresStore) ListAlertMonitors(userID string, limit, offset int32) ([]*AlertMonitor, int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
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
		SELECT `+alertMonitorColumns+`
		FROM alert_monitors
		WHERE user_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT $2 OFFSET $3
	`, userID, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list alert monitors: %w", err)
	}
	defer rows.Close()

	monitors := make([]*AlertMonitor, 0, limit)
	for rows.Next() {
		monitor, err := scanAlertMonitor(rows)
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

func scanAlertMonitor(row pgx.Row) (*AlertMonitor, error) {
	monitor := &AlertMonitor{}
	var threshold sql.NullFloat64
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
	if threshold.Valid {
		monitor.Threshold = &threshold.Float64
	}
	return monitor, nil
}
