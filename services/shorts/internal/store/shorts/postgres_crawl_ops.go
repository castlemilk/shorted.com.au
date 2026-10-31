package shorts

// postgres_crawl_ops.go: the read-only queries behind the admin housing-crawl debugging
// tools (services/shorts/internal/mcp/admin_crawl_ops.go). Every statement is a SELECT, and every
// read runs in a READ ONLY transaction with a 5-second statement timeout (crawlOpsRead). Nothing
// here reads or writes a listing row: the queries touch the ledger, the receipts (counts and the
// response's counts-only fields), the quarantine (reason and counts) and the finalize watermark.
// Tables are in migrations 000150 to 000152. The indexes these queries rely on are in 000153.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// crawlOpsStatementTimeout bounds every crawl-ops read. The prod pool has three connections per
// instance, so one slow read must not hold one for long.
const crawlOpsStatementTimeout = "5s"

// crawlOpsRead runs fn in a READ ONLY transaction with a statement timeout. Nothing it does can write,
// and no statement it runs can outlive the timeout. A transaction is used, not a session setting, so
// the timeout is local to these reads and works through the transaction pooler (port 6543).
func (s *postgresStore) crawlOpsRead(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '"+crawlOpsStatementTimeout+"'"); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CrawlOpsAdminStore is the read-only housing crawl view the admin tools use.
type CrawlOpsAdminStore interface {
	// CrawlDispatchOpen counts ledger rows still open (not closed, not expired), and the open ones that
	// expire within 24 hours.
	CrawlDispatchOpen(ctx context.Context) (open, expiringWithin24h int64, err error)
	// CrawlReceiptGroups counts receipts created at or after since, grouped by portal, applied status
	// and suburb. statuses, when non-empty, restricts the applied status. rigSubject, when non-empty,
	// restricts to one rig's subject (rig:<id>).
	CrawlReceiptGroups(ctx context.Context, since time.Time, rigSubject string, statuses []string) ([]CrawlReceiptGroup, error)
	// CrawlQuarantineReasons counts quarantine rows created at or after since, by reason.
	CrawlQuarantineReasons(ctx context.Context, since time.Time, rigSubject string) ([]CrawlReasonCount, error)
	// CrawlFinalizeWatermark is the crawl-finalize cursor. ok is false when no run has ever finalized.
	CrawlFinalizeWatermark(ctx context.Context) (watermark, updatedAt time.Time, ok bool, err error)
	// CrawlDispatchForRun returns the ledger rows a run wrote, oldest first.
	CrawlDispatchForRun(ctx context.Context, runID string) ([]CrawlDispatchRow, error)
	// CrawlOpenDispatchForSuburb returns the open ledger rows (not closed, not expired) for a catalog
	// slug, for either portal. Every pending BrandBrain job is dispatched, so an open row means the
	// suburb is already queued.
	CrawlOpenDispatchForSuburb(ctx context.Context, slug string) ([]CrawlDispatchRow, error)
	// CrawlDispatchForJob returns one ledger row, or nil when the job has none.
	CrawlDispatchForJob(ctx context.Context, jobID string) (*CrawlDispatchRow, error)
	// CrawlReceiptsForJob returns every receipt for a job (keys <job_id>:<attempt>:<source>).
	CrawlReceiptsForJob(ctx context.Context, jobID string) ([]CrawlReceipt, error)
	// CrawlQuarantineForJob returns the quarantine rows a job produced.
	CrawlQuarantineForJob(ctx context.Context, jobID string) ([]CrawlQuarantineEntry, error)
}

// CrawlDispatchRow is one crawl_dispatch row: a job the server enqueued for a rig.
type CrawlDispatchRow struct {
	JobID     string
	RunID     string
	Selection string
	Suburb    string
	State     string
	Postcode  string
	Source    string
	CreatedAt time.Time
	ExpiresAt time.Time
	ClosedAt  *time.Time
}

// CrawlReceipt is one crawl_ingest_receipts row, reduced to its counts-only response. RigSubject is
// the rig that pushed it (rig:<id>), which the verdict reads as the rig that crawled the job.
type CrawlReceipt struct {
	Key              string
	RigSubject       string
	AppliedStatus    string
	ListingsUpserted int
	Events           int
	Delisted         int
	Quarantined      bool
	Poisoned         bool
	Replayed         bool
	CreatedAt        time.Time
}

// CrawlReceiptGroup is one count of receipts for a portal, status and suburb. Source is "unknown" for
// a receipt whose key names no ledger row.
type CrawlReceiptGroup struct {
	Source        string
	AppliedStatus string
	Suburb        string
	Count         int64
}

// CrawlReasonCount is one count of quarantine rows for a reason.
type CrawlReasonCount struct {
	Reason string
	Count  int64
}

// CrawlQuarantineEntry is one quarantine row for a job: its reason and when it was held.
type CrawlQuarantineEntry struct {
	Reason    string
	CreatedAt time.Time
}

// CrawlDispatchOpen implements CrawlOpsAdminStore.
func (s *postgresStore) CrawlDispatchOpen(ctx context.Context) (int64, int64, error) {
	var open, soon int64
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE closed_at IS NULL AND expires_at > now()),
			       count(*) FILTER (WHERE closed_at IS NULL AND expires_at > now()
			                          AND expires_at <= now() + interval '24 hours')
			FROM crawl_dispatch`).Scan(&open, &soon)
	})
	return open, soon, err
}

// CrawlReceiptGroups implements CrawlOpsAdminStore. A receipt whose key has no ledger row (a key from
// before the ledger, or a foreign one) reads as source "unknown", not dropped.
func (s *postgresStore) CrawlReceiptGroups(ctx context.Context, since time.Time, rigSubject string, statuses []string) ([]CrawlReceiptGroup, error) {
	if statuses == nil {
		statuses = []string{}
	}
	out := []CrawlReceiptGroup{}
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT COALESCE(d.source, 'unknown'),
			       COALESCE(r.response->>'appliedStatus', 'unknown'),
			       COALESCE(d.suburb, ''),
			       count(*)
			FROM crawl_ingest_receipts r
			LEFT JOIN crawl_dispatch d ON d.job_id = split_part(r.key, ':', 1)
			WHERE r.created_at >= $1
			  AND ($2::text = '' OR r.rig_subject = $2)
			  AND (cardinality($3::text[]) = 0 OR (r.response->>'appliedStatus') = ANY($3::text[]))
			GROUP BY 1, 2, 3
			ORDER BY 1, 2, 3`, since, rigSubject, statuses)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var g CrawlReceiptGroup
			if err := rows.Scan(&g.Source, &g.AppliedStatus, &g.Suburb, &g.Count); err != nil {
				return err
			}
			out = append(out, g)
		}
		return rows.Err()
	})
	return out, err
}

// CrawlQuarantineReasons implements CrawlOpsAdminStore.
func (s *postgresStore) CrawlQuarantineReasons(ctx context.Context, since time.Time, rigSubject string) ([]CrawlReasonCount, error) {
	out := []CrawlReasonCount{}
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT reason, count(*)
			FROM crawl_ingest_quarantine
			WHERE created_at >= $1 AND ($2::text = '' OR rig_subject = $2)
			GROUP BY reason
			ORDER BY reason`, since, rigSubject)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var c CrawlReasonCount
			if err := rows.Scan(&c.Reason, &c.Count); err != nil {
				return err
			}
			out = append(out, c)
		}
		return rows.Err()
	})
	return out, err
}

// CrawlFinalizeWatermark implements CrawlOpsAdminStore.
func (s *postgresStore) CrawlFinalizeWatermark(ctx context.Context) (time.Time, time.Time, bool, error) {
	var w, u time.Time
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT watermark, updated_at FROM crawl_finalize_state WHERE name = 'crawl-finalize'`).Scan(&w, &u)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, time.Time{}, false, err
	}
	return w, u, true, nil
}

const crawlDispatchColumns = `job_id, COALESCE(run_id, ''), COALESCE(selection, ''), suburb, state, postcode, source, created_at, expires_at, closed_at`

func scanCrawlDispatch(scan func(...any) error) (CrawlDispatchRow, error) {
	var r CrawlDispatchRow
	err := scan(&r.JobID, &r.RunID, &r.Selection, &r.Suburb, &r.State, &r.Postcode, &r.Source, &r.CreatedAt, &r.ExpiresAt, &r.ClosedAt)
	return r, err
}

// CrawlDispatchForRun implements CrawlOpsAdminStore. It uses crawl_dispatch(run_id).
func (s *postgresStore) CrawlDispatchForRun(ctx context.Context, runID string) ([]CrawlDispatchRow, error) {
	out := []CrawlDispatchRow{}
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+crawlDispatchColumns+` FROM crawl_dispatch WHERE run_id = $1 ORDER BY created_at, job_id`, runID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			r, err := scanCrawlDispatch(rows.Scan)
			if err != nil {
				return err
			}
			out = append(out, r)
		}
		return rows.Err()
	})
	return out, err
}

// CrawlOpenDispatchForSuburb implements CrawlOpsAdminStore. The ledger keeps the catalog's display name
// ("St Kilda"); the slug is the same name lower-cased with hyphens. The partial expression index on
// that expression (000153) covers the closed_at IS NULL predicate.
func (s *postgresStore) CrawlOpenDispatchForSuburb(ctx context.Context, slug string) ([]CrawlDispatchRow, error) {
	out := []CrawlDispatchRow{}
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+crawlDispatchColumns+` FROM crawl_dispatch
			WHERE lower(replace(suburb, ' ', '-')) = $1 AND closed_at IS NULL AND expires_at > now()
			ORDER BY created_at, job_id`, slug)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			r, err := scanCrawlDispatch(rows.Scan)
			if err != nil {
				return err
			}
			out = append(out, r)
		}
		return rows.Err()
	})
	return out, err
}

// CrawlDispatchForJob implements CrawlOpsAdminStore.
func (s *postgresStore) CrawlDispatchForJob(ctx context.Context, jobID string) (*CrawlDispatchRow, error) {
	var out *CrawlDispatchRow
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		r, err := scanCrawlDispatch(tx.QueryRow(ctx, `SELECT `+crawlDispatchColumns+` FROM crawl_dispatch WHERE job_id = $1`, jobID).Scan)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		out = &r
		return nil
	})
	return out, err
}

// CrawlReceiptsForJob implements CrawlOpsAdminStore. The lookup is on split_part(key, ':', 1), the job
// id, which the expression index in 000153 covers. A key is <job_id>:<attempt>:<source>, so the match is
// exact: a job id that is a prefix of another job's id matches only its own keys.
func (s *postgresStore) CrawlReceiptsForJob(ctx context.Context, jobID string) ([]CrawlReceipt, error) {
	out := []CrawlReceipt{}
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT key,
			       rig_subject,
			       COALESCE(response->>'appliedStatus', ''),
			       COALESCE((response->>'listingsUpserted')::int, 0),
			       COALESCE((response->>'events')::int, 0),
			       COALESCE((response->>'delisted')::int, 0),
			       COALESCE((response->>'quarantined')::boolean, false),
			       COALESCE((response->>'poisoned')::boolean, false),
			       COALESCE((response->>'replayed')::boolean, false),
			       created_at
			FROM crawl_ingest_receipts
			WHERE split_part(key, ':', 1) = $1
			ORDER BY created_at, key`, jobID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r CrawlReceipt
			if err := rows.Scan(&r.Key, &r.RigSubject, &r.AppliedStatus, &r.ListingsUpserted, &r.Events, &r.Delisted,
				&r.Quarantined, &r.Poisoned, &r.Replayed, &r.CreatedAt); err != nil {
				return err
			}
			out = append(out, r)
		}
		return rows.Err()
	})
	return out, err
}

// CrawlQuarantineForJob implements CrawlOpsAdminStore.
func (s *postgresStore) CrawlQuarantineForJob(ctx context.Context, jobID string) ([]CrawlQuarantineEntry, error) {
	out := []CrawlQuarantineEntry{}
	err := s.crawlOpsRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT reason, created_at FROM crawl_ingest_quarantine WHERE job_id = $1 ORDER BY created_at, id`, jobID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var q CrawlQuarantineEntry
			if err := rows.Scan(&q.Reason, &q.CreatedAt); err != nil {
				return err
			}
			out = append(out, q)
		}
		return rows.Err()
	})
	return out, err
}
