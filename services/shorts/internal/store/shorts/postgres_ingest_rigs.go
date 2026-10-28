package shorts

// postgres_ingest_rigs.go: the allowlist the housing crawl ingest checks on every
// push (housing_ingest_rigs, migration 000150). Read and written by the admin MCP
// tools housing_crawl_rigs and housing_crawl_authorize. The ingest's own rigGate
// reads the same table and caches each answer for a minute.
//
// Every statement takes a parameterised subject. The table is small (one row per
// rig), so the list is bounded only as a guard.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// IngestRigListLimit bounds the list. There is one row per rig, so this is a guard
// against a runaway table, not a page size.
const IngestRigListLimit = 500

// IngestRig is one allowlist row, without its note: the note is free text and the
// admin read tool returns identifiers, enums, bools and timestamps only.
type IngestRig struct {
	Subject   string
	Enabled   bool
	CreatedAt time.Time
}

// Outcomes of DisableIngestRig.
const (
	IngestRigDisabled   = "disabled"
	IngestRigUnchanged  = "unchanged"
	IngestRigNotPresent = "not_present"
)

// IngestRigAdminStore is the admin-side view of the allowlist. The store implements
// it; the admin source narrows to it by type assertion.
type IngestRigAdminStore interface {
	ListIngestRigs(ctx context.Context) ([]IngestRig, error)
	IngestRigState(ctx context.Context, subject string) (present, enabled bool, err error)
	EnableIngestRig(ctx context.Context, subject string, note *string) (wasEnabled bool, err error)
	DisableIngestRig(ctx context.Context, subject string) (outcome string, err error)
}

// ListIngestRigs returns up to IngestRigListLimit rows, oldest first.
func (s *postgresStore) ListIngestRigs(ctx context.Context) ([]IngestRig, error) {
	rows, err := s.db.Query(ctx,
		`SELECT subject, enabled, created_at FROM housing_ingest_rigs
		 ORDER BY created_at, subject LIMIT $1`, IngestRigListLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []IngestRig{}
	for rows.Next() {
		var r IngestRig
		if err := rows.Scan(&r.Subject, &r.Enabled, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// IngestRigState reports whether subject has a row and whether it is enabled. A
// missing row is present=false, and is never treated as enabled.
func (s *postgresStore) IngestRigState(ctx context.Context, subject string) (bool, bool, error) {
	var enabled bool
	err := s.db.QueryRow(ctx,
		`SELECT enabled FROM housing_ingest_rigs WHERE subject = $1`, subject).Scan(&enabled)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return false, false, nil
	case err != nil:
		return false, false, err
	}
	return true, enabled, nil
}

// EnableIngestRig sets subject enabled, creating the row when it is absent. A nil
// note keeps the existing one. wasEnabled reports the state before the call, so an
// idempotent repeat is visible to the caller.
//
// It runs in one transaction. FOR UPDATE serialises it with a concurrent disable of
// the same subject, and ON CONFLICT covers a concurrent insert.
func (s *postgresStore) EnableIngestRig(ctx context.Context, subject string, note *string) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var wasEnabled bool
	err = tx.QueryRow(ctx,
		`SELECT enabled FROM housing_ingest_rigs WHERE subject = $1 FOR UPDATE`, subject).Scan(&wasEnabled)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		wasEnabled = false
	case err != nil:
		return false, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO housing_ingest_rigs (subject, enabled, note) VALUES ($1, true, $2)
		 ON CONFLICT (subject) DO UPDATE
		 SET enabled = true, note = COALESCE(EXCLUDED.note, housing_ingest_rigs.note)`,
		subject, note); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return wasEnabled, nil
}

// DisableIngestRig sets subject disabled. It never creates a row: a subject with no
// row is reported as IngestRigNotPresent and nothing is written. The prior value is
// read in the same statement that writes, under the row lock, so the outcome
// describes what this call changed.
func (s *postgresStore) DisableIngestRig(ctx context.Context, subject string) (string, error) {
	var priorEnabled bool
	err := s.db.QueryRow(ctx,
		`WITH old AS (
		   SELECT subject, enabled FROM housing_ingest_rigs WHERE subject = $1 FOR UPDATE
		 )
		 UPDATE housing_ingest_rigs AS r SET enabled = false
		 FROM old
		 WHERE r.subject = old.subject
		 RETURNING old.enabled`, subject).Scan(&priorEnabled)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return IngestRigNotPresent, nil
	case err != nil:
		return "", err
	case priorEnabled:
		return IngestRigDisabled, nil
	default:
		return IngestRigUnchanged, nil
	}
}
