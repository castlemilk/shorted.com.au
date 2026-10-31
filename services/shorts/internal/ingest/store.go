package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/encoding/protojson"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// The SQL behind the ingest. Every statement that decides an outcome (the receipt,
// the dispatch state, the close) runs on the sweep's transaction, so its result is
// read under the key's advisory lock. The helpers that take a *pgxpool.Pool run
// outside any sweep, after it has finished, and never hold a connection while they
// take another.

// receipt is a stored ingest receipt: the body digest and the response to replay.
type receipt struct {
	rig  string
	sha  []byte
	resp *pb.PushSweepResponse
}

// lockKeyTx takes the transaction-level advisory lock for one idempotency key. It is
// the first statement of every sweep. A transaction-level lock is released at COMMIT
// or ROLLBACK, so it cannot outlive the transaction on a pooled backend, and it works
// behind a transaction pooler where a session lock would not.
func lockKeyTx(ctx context.Context, tx pgx.Tx, key string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, key)
	return err
}

// loadReceiptTx returns the receipt for key, read on tx.
func loadReceiptTx(ctx context.Context, tx pgx.Tx, key string) (receipt, bool, error) {
	var (
		r       receipt
		payload []byte
	)
	err := tx.QueryRow(ctx,
		`SELECT rig_subject, body_sha256, response::text FROM crawl_ingest_receipts WHERE key = $1`, key).
		Scan(&r.rig, &r.sha, &payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return receipt{}, false, nil
	}
	if err != nil {
		return receipt{}, false, err
	}
	r.resp = &pb.PushSweepResponse{}
	if err := protojson.Unmarshal(payload, r.resp); err != nil {
		return receipt{}, false, err
	}
	return r, true, nil
}

// insertReceiptTx stores a receipt inside tx. The primary key on key is the final
// guard: a second writer of the same key fails here, and its transaction rolls back.
//
// The receipt records the token that made the push (jwt_jti, jwt_kid, migration 000152),
// so a replayed or forged push can be traced to its token. Those columns come from a
// later migration than the one that creates the table. Until that migration is applied
// the insert fails with undefined_column (42703), and the receipt is written without
// them: a deploy that runs before the DDL must not 500 the pushes. The first attempt
// runs under a savepoint, because a failed statement would otherwise abort the sweep.
func insertReceiptTx(ctx context.Context, tx pgx.Tx, key string, who identity, sum []byte, resp *pb.PushSweepResponse) error {
	payload, err := marshalResponse(resp)
	if err != nil {
		return err
	}
	sp, err := tx.Begin(ctx) // a SAVEPOINT on tx
	if err != nil {
		return err
	}
	_, err = sp.Exec(ctx, `
		INSERT INTO crawl_ingest_receipts (key, rig_subject, body_sha256, response, jwt_jti, jwt_kid)
		VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
		key, who.Subject, sum, payload, nullable(who.JTI), nullable(who.KID))
	if err == nil {
		return sp.Commit(ctx)
	}
	_ = sp.Rollback(ctx)
	if !isUndefinedColumn(err) {
		return err
	}
	warnAuditColumnsMissing()
	_, err = tx.Exec(ctx, `
		INSERT INTO crawl_ingest_receipts (key, rig_subject, body_sha256, response)
		VALUES ($1, $2, $3, $4::jsonb)`,
		key, who.Subject, sum, payload)
	return err
}

// auditColumnsWarned makes the missing-columns warning once per process, not per push.
var auditColumnsWarned sync.Once

func warnAuditColumnsMissing() {
	auditColumnsWarned.Do(func() {
		log.Warnf("housing ingest: crawl_ingest_receipts has no jwt_jti/jwt_kid (migration 000152 not applied); receipts are written without the token audit columns")
	})
}

// isUndefinedColumn reports Postgres undefined_column (42703).
func isUndefinedColumn(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42703"
}

// nullable maps an empty string to SQL NULL: a receipt from before a token carried
// the claim, or one written by a test, has no value to record.
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// marshalResponse encodes a response for storage. The response carries counts only,
// so this is the entire replay payload.
func marshalResponse(resp *pb.PushSweepResponse) (string, error) {
	b, err := protojson.Marshal(resp)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// dispatch is one row of the crawl_dispatch ledger, as the sweep reads it.
type dispatch struct {
	Suburb   string
	State    string
	Postcode string
	Source   string
	RunID    string
}

// loadDispatch returns the ledger row for job, if the job was dispatched. It runs on
// the pool, before the sweep. The fields it returns never change after the row is
// written, so the sweep can use them as its target. Closed and expired are checked
// again on the transaction, under the row lock.
func loadDispatch(ctx context.Context, pool *pgxpool.Pool, job string) (dispatch, bool, error) {
	var d dispatch
	err := pool.QueryRow(ctx, `
		SELECT suburb, state, postcode, source, COALESCE(run_id, '')
		FROM crawl_dispatch WHERE job_id = $1`, job).
		Scan(&d.Suburb, &d.State, &d.Postcode, &d.Source, &d.RunID)
	if errors.Is(err, pgx.ErrNoRows) {
		return dispatch{}, false, nil
	}
	if err != nil {
		return dispatch{}, false, err
	}
	return d, true, nil
}

// dispatchState is what the sweep's transaction sees for a job.
type dispatchState struct {
	found   bool
	closed  bool
	expired bool
}

// lockDispatchTx reads the job's ledger row on tx, FOR UPDATE. Two attempts of one job
// with different keys take different key locks, so this row lock is what makes them
// serialise: the second waits for the first to commit, then sees closed_at.
func lockDispatchTx(ctx context.Context, tx pgx.Tx, job string) (dispatchState, error) {
	var st dispatchState
	err := tx.QueryRow(ctx, `
		SELECT closed_at IS NOT NULL, expires_at <= now()
		FROM crawl_dispatch WHERE job_id = $1 FOR UPDATE`, job).
		Scan(&st.closed, &st.expired)
	if errors.Is(err, pgx.ErrNoRows) {
		return dispatchState{}, nil
	}
	if err != nil {
		return dispatchState{}, err
	}
	st.found = true
	return st, nil
}

// closeDispatchTx closes the job on tx. It is called when a COMPLETE or PARTIAL sweep
// was applied, and when a sweep was quarantined (terminal: the rig never retries a held
// job). A BLOCKED sweep may legitimately be retried, so it never closes a job.
func closeDispatchTx(ctx context.Context, tx pgx.Tx, job string) error {
	_, err := tx.Exec(ctx, `
		UPDATE crawl_dispatch SET closed_at = now()
		WHERE job_id = $1 AND closed_at IS NULL`, job)
	return err
}

// insertQuarantineTx records a held sweep: its reason and counts, never listing rows.
func insertQuarantineTx(ctx context.Context, tx pgx.Tx, key, rig, job string, sum []byte, reason string, stats quarantineStats) error {
	payload, err := json.Marshal(stats)
	if err != nil {
		return err
	}
	// The stats go as text. A []byte would be sent as a bytea literal under the simple
	// query protocol the ingest pool uses, and the jsonb cast would then fail.
	_, err = tx.Exec(ctx, `
		INSERT INTO crawl_ingest_quarantine
			(receipt_key, rig_subject, job_id, reason, stats, payload_sha256)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
		key, rig, job, reason, string(payload), sum)
	return err
}

// quarantineStats is what a quarantine row keeps about the held sweep. Counts and
// the reason only.
type quarantineStats struct {
	Status        string `json:"status"`
	Existing      int    `json:"existing"`
	LargeMoves    int    `json:"large_moves"`
	ActiveBefore  int    `json:"active_before"`
	WouldDelist   int    `json:"would_delist"`
	DelistedStale int    `json:"delisted_stale"`
	Listings      int    `json:"listings"`
	FreshBefore   int    `json:"fresh_before"`
	FreshSeen     int    `json:"fresh_seen"`
}

// bypassed reports whether an operator has released this suburb from quarantine. The
// row is crawl_ingest_quarantine_bypass, documented in migration 000150. It runs on the
// pool, before the sweep.
func bypassed(ctx context.Context, pool *pgxpool.Pool, suburb, state, source string) (bool, error) {
	var on bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM crawl_ingest_quarantine_bypass
			WHERE suburb = $1 AND state = $2 AND source = $3 AND expires_at > now())`,
		suburb, state, source).Scan(&on)
	return on, err
}

// bumpRunStatus adds one applied sweep's counts to the crawl_run_status row for the
// dispatch's run. It is best-effort: a failure is logged and never fails the push,
// because the sweep is already committed. A replay never reaches this.
func (s *Service) bumpRunStatus(ctx context.Context, runID string, blocked bool, listings, events, suburbs int) {
	if runID == "" {
		return
	}
	bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	blockedCount := 0
	if blocked {
		blockedCount = 1
	}
	_, err := s.pool.Exec(bctx, `
		UPDATE crawl_run_status
		SET listings_touched = listings_touched + $2,
		    events_written   = events_written + $3,
		    suburbs_done     = suburbs_done + $4,
		    blocked_count    = blocked_count + $5,
		    updated_at       = now()
		WHERE run_id = $1`,
		runID, listings, events, suburbs, blockedCount)
	if err != nil {
		log.Warnf("housing ingest: crawl_run_status count update failed (best-effort): %v", err)
	}
}

// recordCycle upserts the rig's cycle record into crawl_run_status. The row is
// keyed like the collector's own rows: run_type 'agent', host = the rig subject.
// Rounds that share a cycle_id accumulate, and a new cycle_id replaces the row, as
// the collector's upsert does.
func (s *Service) recordCycle(ctx context.Context, subject string, msg *pb.ReportCycleRequest) error {
	c := msg.Counts
	if c == nil {
		c = &pb.CycleCounts{}
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO crawl_run_status (
			run_type, host, run_id, started_at, finished_at, status,
			suburbs_selected, suburbs_done, listings_touched, events_written,
			blocked_count, rewarm_needed, detail, updated_at)
		VALUES ('agent', $1, $2, now(), now(), $3, $4, $5, $6, $7, $8, $9, NULLIF($10, ''), now())
		ON CONFLICT (run_type, host) DO UPDATE SET
			run_id      = EXCLUDED.run_id,
			started_at  = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.started_at ELSE EXCLUDED.started_at END,
			finished_at = EXCLUDED.finished_at,
			status      = EXCLUDED.status,
			suburbs_selected = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.suburbs_selected + EXCLUDED.suburbs_selected ELSE EXCLUDED.suburbs_selected END,
			suburbs_done = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.suburbs_done + EXCLUDED.suburbs_done ELSE EXCLUDED.suburbs_done END,
			listings_touched = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.listings_touched + EXCLUDED.listings_touched ELSE EXCLUDED.listings_touched END,
			events_written = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.events_written + EXCLUDED.events_written ELSE EXCLUDED.events_written END,
			blocked_count = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.blocked_count + EXCLUDED.blocked_count ELSE EXCLUDED.blocked_count END,
			rewarm_needed = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.rewarm_needed OR EXCLUDED.rewarm_needed ELSE EXCLUDED.rewarm_needed END,
			freshness_oldest_hours = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.freshness_oldest_hours ELSE NULL END,
			detail      = EXCLUDED.detail,
			updated_at  = now()`,
		subject, msg.CycleId, cycleStatus(msg.Outcome),
		c.SuburbsSelected, c.SuburbsDone, c.ListingsTouched, c.EventsWritten,
		c.BlockedCount, msg.Outcome == "rewarm", cycleDetail(msg))
	return err
}

// cycleStatus maps a cycle outcome onto crawl_run_status.status, whose CHECK
// vocabulary is ok, blocked, rewarm, partial and error. The housing-freshness
// sentinel raises an alarm on error and blocked only, so the mapping keeps a routine
// cancellation (an upgrade, a stop) out of it: cancelled is partial, a stop that
// was asked for and did not fail. failed is a real failure, so it is error.
func cycleStatus(outcome string) string {
	switch outcome {
	case "ok", "blocked", "partial", "rewarm":
		return outcome
	case "deferred", "cancelled":
		return "partial"
	default:
		return "error"
	}
}

// cycleDetail is the bounded free text on the row: the outcome and exit code.
func cycleDetail(msg *pb.ReportCycleRequest) string {
	return "outcome=" + msg.Outcome + " exit=" + strconv.FormatInt(int64(msg.ExitCode), 10)
}
