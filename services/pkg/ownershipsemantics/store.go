package ownershipsemantics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrReplayConflict        = errors.New("ownership semantic revision identity already has different content")
	ErrInvalidLineage        = errors.New("ownership semantic revision lineage is invalid")
	ErrSchemaUnavailable     = errors.New("ownership semantic revision storage is not installed")
	ErrStoredRevisionInvalid = errors.New("stored ownership semantic revision failed integrity validation")
)

// Database is implemented by pgxpool.Pool and pgx.Conn. No ambient DSN or
// fallback store is selected: a caller explicitly supplies its database.
type Database interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

type Store struct{ db Database }

func NewStore(db Database) *Store { return &Store{db: db} }

const revisionColumns = `disclosure_id, revision_id, payload_sha256, payload, recorded_at`

// Append inserts once or returns the original revision for an exact replay.
// A changed payload under the same source/extractor/config/contract identity is
// a conflict, including a changed supplied review state. Concurrent replays
// converge through the unique key; there is no UPDATE, last-writer-wins path,
// "latest" promotion, parsed legacy write, notification or public selector.
func (s *Store) Append(ctx context.Context, in Input) (Revision, bool, error) {
	r, err := Prepare(in)
	if err != nil {
		return Revision{}, false, err
	}
	if s == nil || s.db == nil {
		return Revision{}, false, ErrSchemaUnavailable
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Revision{}, false, storeError(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	existing, err := readRevision(tx.QueryRow(ctx, `SELECT `+revisionColumns+`
		FROM ownership_disclosure_revisions WHERE revision_id = $1`, r.RevisionID))
	if err == nil {
		if existing.PayloadSHA256 != r.PayloadSHA256 {
			return Revision{}, false, fmt.Errorf("%w: %s", ErrReplayConflict, r.RevisionID)
		}
		if err := tx.Commit(ctx); err != nil {
			return Revision{}, false, storeError(err)
		}
		return existing, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Revision{}, false, storeError(err)
	}
	if in.SupersedesDisclosureID != "" {
		// Correction edges from different extractor revisions form a graph.
		// Serialize graph changes for the resolved table so opposite edges
		// cannot both validate against an earlier acyclic snapshot, even when
		// callers reach that same table through different search paths.
		if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '5s'`); err != nil {
			return Revision{}, false, storeError(err)
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(
			('ownership_disclosure_revisions'::regclass::oid)::text || ':ownership-semantic-corrections', 0))`); err != nil {
			return Revision{}, false, storeError(err)
		}
	}
	if err := validateLineage(ctx, tx, r); err != nil {
		return Revision{}, false, storeError(err)
	}
	raw, err := json.Marshal(r.Input)
	if err != nil {
		return Revision{}, false, err
	}
	tag, err := tx.Exec(ctx, `
		INSERT INTO ownership_disclosure_revisions (
			revision_id, disclosure_id, source_url, disclosure_slot, source_sha256,
			extractor_version, extractor_config_sha256, contract_version, document_format,
			review_state, extraction_completeness, publication_eligible,
			supersedes_revision_id, supersedes_disclosure_id, payload_sha256, payload)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, $12, $13, $14, $15::jsonb)
		ON CONFLICT (revision_id) DO NOTHING`,
		r.RevisionID, r.DisclosureID, in.Source.URL, in.DisclosureSlot, in.Source.SHA256,
		in.ExtractorVersion, in.ExtractorConfigSHA256, in.ContractVersion, in.DocumentFormat,
		in.ReviewState, in.ExtractionCompleteness, nullable(in.SupersedesRevisionID),
		nullable(in.SupersedesDisclosureID), r.PayloadSHA256, raw)
	if err != nil {
		return Revision{}, false, storeError(err)
	}
	// A separate statement obtains a new READ COMMITTED snapshot after a
	// concurrent INSERT has committed. A single INSERT/SELECT CTE can miss it.
	stored, err := readRevision(tx.QueryRow(ctx, `SELECT `+revisionColumns+`
		FROM ownership_disclosure_revisions WHERE revision_id = $1`, r.RevisionID))
	if err != nil {
		return Revision{}, false, storeError(err)
	}
	if stored.PayloadSHA256 != r.PayloadSHA256 {
		return Revision{}, false, fmt.Errorf("%w: %s", ErrReplayConflict, r.RevisionID)
	}
	if err := tx.Commit(ctx); err != nil {
		return Revision{}, false, storeError(err)
	}
	return stored, tag.RowsAffected() == 1, nil
}

func validateLineage(ctx context.Context, tx pgx.Tx, r Revision) error {
	in := r.Input
	if in.SupersedesRevisionID != "" {
		previous, err := readRevision(tx.QueryRow(ctx, `SELECT `+revisionColumns+`
			FROM ownership_disclosure_revisions WHERE revision_id = $1`, in.SupersedesRevisionID))
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: extraction predecessor is absent", ErrInvalidLineage)
		}
		if err != nil {
			return err
		}
		if previous.DisclosureID != r.DisclosureID || previous.Input.Source.SHA256 != in.Source.SHA256 ||
			previous.Input.DisclosureSlot != in.DisclosureSlot {
			return fmt.Errorf("%w: extraction predecessor must be the same disclosure, slot and source bytes", ErrInvalidLineage)
		}
	}
	if in.SupersedesDisclosureID != "" {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM ownership_disclosure_revisions WHERE disclosure_id = $1)`,
			in.SupersedesDisclosureID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("%w: corrected disclosure is absent", ErrInvalidLineage)
		}
		var cycle, tooDeep bool
		if err := tx.QueryRow(ctx, `
			WITH RECURSIVE ancestors(disclosure_id, depth) AS (
				SELECT $1::text, 0
				UNION
				SELECT r.supersedes_disclosure_id, a.depth + 1
				FROM ancestors a JOIN ownership_disclosure_revisions r
				  ON r.disclosure_id = a.disclosure_id
				WHERE r.supersedes_disclosure_id IS NOT NULL AND a.depth < 128
			)
			SELECT EXISTS (SELECT 1 FROM ancestors WHERE disclosure_id = $2),
			       EXISTS (SELECT 1 FROM ancestors WHERE depth = 128)`,
			in.SupersedesDisclosureID, r.DisclosureID).Scan(&cycle, &tooDeep); err != nil {
			return err
		}
		if cycle || tooDeep {
			return fmt.Errorf("%w: correction graph cycles or exceeds 128 links", ErrInvalidLineage)
		}
	}
	return nil
}

// Get is an explicit internal revision read. It returns pgx.ErrNoRows for an
// absent revision and ErrSchemaUnavailable for an unapplied migration. Existing
// public ownership reads do not call it and keep their legacy compatibility.
func (s *Store) Get(ctx context.Context, revisionID string) (Revision, error) {
	if !sha256Pattern.MatchString(revisionID) {
		return Revision{}, fmt.Errorf("invalid revision_id")
	}
	if s == nil || s.db == nil {
		return Revision{}, ErrSchemaUnavailable
	}
	r, err := readRevision(s.db.QueryRow(ctx, `SELECT `+revisionColumns+`
		FROM ownership_disclosure_revisions WHERE revision_id = $1`, revisionID))
	return r, storeError(err)
}

// List returns bounded immutable history, not a current or publishable holding.
// Callers must specify the disclosure and an explicit limit (1–1000).
func (s *Store) List(ctx context.Context, disclosureID string, limit int) ([]Revision, error) {
	if !sha256Pattern.MatchString(disclosureID) || limit < 1 || limit > 1000 {
		return nil, fmt.Errorf("expected disclosure_id and limit from 1 through 1000")
	}
	if s == nil || s.db == nil {
		return nil, ErrSchemaUnavailable
	}
	rows, err := s.db.Query(ctx, `SELECT `+revisionColumns+`
		FROM ownership_disclosure_revisions WHERE disclosure_id = $1
		ORDER BY recorded_at, revision_id LIMIT $2`, disclosureID, limit)
	if err != nil {
		return nil, storeError(err)
	}
	defer rows.Close()
	var out []Revision
	for rows.Next() {
		r, err := readRevision(rows)
		if err != nil {
			return nil, storeError(err)
		}
		out = append(out, r)
	}
	return out, storeError(rows.Err())
}

type scanner interface{ Scan(...any) error }

func readRevision(row scanner) (Revision, error) {
	var r Revision
	var raw []byte
	if err := row.Scan(&r.DisclosureID, &r.RevisionID, &r.PayloadSHA256, &raw, &r.RecordedAt); err != nil {
		return r, err
	}
	// JSONB renders additional insignificant whitespace. Compact only this
	// storage representation so a valid near-limit canonical payload can be
	// read under the same one-MiB contract; external DecodeInput stays strict.
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return Revision{}, fmt.Errorf("%w: %v", ErrStoredRevisionInvalid, err)
	}
	in, err := DecodeInput(compact.Bytes())
	if err != nil {
		return Revision{}, fmt.Errorf("%w: %v", ErrStoredRevisionInvalid, err)
	}
	canonical, err := Prepare(in)
	if err != nil || canonical.DisclosureID != r.DisclosureID || canonical.RevisionID != r.RevisionID ||
		canonical.PayloadSHA256 != r.PayloadSHA256 || r.RecordedAt.IsZero() {
		return Revision{}, ErrStoredRevisionInvalid
	}
	r.Input = canonical.Input
	return r, nil
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func storeError(err error) error {
	var pgerr *pgconn.PgError
	if errors.As(err, &pgerr) && (pgerr.Code == "42P01" || pgerr.Code == "42703") {
		return fmt.Errorf("%w: %s", ErrSchemaUnavailable, pgerr.Code)
	}
	return err
}
