package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/encoding/protojson"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// The SQL behind the ingest. Each function touches the tables the migration
// (000150) creates, plus crawl_run_status (000089) for the counts. Nothing here
// reads a listing row back out to a caller.

// receipt is a stored ingest receipt: the body digest and the response to replay.
type receipt struct {
	rig  string
	sha  []byte
	resp *pb.PushSweepResponse
}

// loadReceipt returns the receipt for key, if one exists. q is the connection that
// holds the key's advisory lock, so the read cannot race a concurrent apply.
func loadReceipt(ctx context.Context, q *pgxpool.Conn, key string) (receipt, bool, error) {
	var (
		r       receipt
		payload []byte
	)
	err := q.QueryRow(ctx,
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

// insertReceipt stores a receipt inside tx. The response is stored with replayed
// false, so a replay sets the flag on its own copy.
func insertReceipt(ctx context.Context, tx pgx.Tx, key, rig string, sum []byte, resp *pb.PushSweepResponse) error {
	payload, err := marshalResponse(resp)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO crawl_ingest_receipts (key, rig_subject, body_sha256, response)
		VALUES ($1, $2, $3, $4::jsonb)`,
		key, rig, sum, payload)
	return err
}

// marshalResponse encodes a response for storage. The response carries counts
// only, so this is the entire replay payload.
func marshalResponse(resp *pb.PushSweepResponse) (string, error) {
	b, err := protojson.Marshal(resp)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// dispatch is one row of the crawl_dispatch ledger.
type dispatch struct {
	Suburb   string
	State    string
	Postcode string
	Source   string
	RunID    string
}

// loadDispatch returns the ledger row for job, if the job was dispatched.
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

// insertQuarantine records a held sweep: its reason and counts, never listing rows.
func insertQuarantine(ctx context.Context, tx pgx.Tx, key, rig, job string, sum []byte, reason string, stats quarantineStats) error {
	payload, err := json.Marshal(stats)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO crawl_ingest_quarantine
			(receipt_key, rig_subject, job_id, reason, stats, payload_sha256)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
		key, rig, job, reason, payload, sum)
	return err
}

// quarantineStats is what a quarantine row keeps about the held sweep. Counts and
// the reason only.
type quarantineStats struct {
	Existing     int    `json:"existing"`
	LargeMoves   int    `json:"large_moves"`
	ActiveBefore int    `json:"active_before"`
	WouldDelist  int    `json:"would_delist"`
	Listings     int    `json:"listings"`
	Status       string `json:"status"`
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
// vocabulary is ok, blocked, rewarm, partial and error. A deferred cycle did no
// work, which is partial progress at best, and every failure is an error.
func cycleStatus(outcome string) string {
	switch outcome {
	case "ok", "blocked", "partial", "rewarm":
		return outcome
	case "deferred":
		return "partial"
	default:
		return "error"
	}
}

// cycleDetail is the bounded free text on the row: the outcome and exit code.
func cycleDetail(msg *pb.ReportCycleRequest) string {
	return "outcome=" + msg.Outcome + " exit=" + strconv.FormatInt(int64(msg.ExitCode), 10)
}
