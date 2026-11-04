package shortdatasync

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// database is the subset of *pgxpool.Pool this job uses. Narrowing it keeps the
// upsert/refresh semantics testable without a live Postgres.
type database interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// pgStore is the Postgres side of the ASIC shorts pipeline.
type pgStore struct {
	db database
}

// upsertShortsSQL is the row write. The conflict target is the
// (DATE, PRODUCT_CODE) unique index, and the update list is EXACTLY the
// Python's: PRODUCT is deliberately NOT refreshed on conflict, so an existing
// row keeps the product name it was first ingested with.
const upsertShortsSQL = `
        INSERT INTO shorts (
            "DATE", "PRODUCT", "PRODUCT_CODE",
            "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE",
            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT ("DATE", "PRODUCT_CODE") DO UPDATE SET
            "REPORTED_SHORT_POSITIONS" = EXCLUDED."REPORTED_SHORT_POSITIONS",
            "TOTAL_PRODUCT_IN_ISSUE" = EXCLUDED."TOTAL_PRODUCT_IN_ISSUE",
            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" =
                EXCLUDED."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"`

// UpsertRows writes one file's rows and returns how many landed.
//
// Deliberately row-at-a-time in AUTOCOMMIT, like the Python: a row that trips a
// constraint is counted as a failure and the file keeps loading. A batch or an
// explicit transaction would abort every remaining row of the file on the first
// bad one — a behaviour change on the load-bearing table, so it is not made
// here. (pgx.Batch is additionally known to wedge on the Supabase transaction
// pooler.)
//
// Cancellation is respected between rows so a SIGTERM stops promptly with the
// already-written rows committed.
func (s *pgStore) UpsertRows(ctx context.Context, rows []shortsRow) (int, error) {
	written := 0
	failed := 0
	for _, r := range rows {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		_, err := s.db.Exec(ctx, upsertShortsSQL,
			r.Date, r.Product, r.ProductCode,
			r.ReportedShortPositions, r.TotalProductInIssue, r.Percent,
		)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return written, err
			}
			if failed == 0 {
				// Same posture as the Python: log the FIRST error of a file for
				// diagnosis, then stay quiet so a systemic failure cannot flood
				// the run log with one line per row.
				log.Printf("   insert error (first of file): %v", err)
			}
			failed++
			continue
		}
		written++
	}
	if failed > 0 {
		log.Printf("   ⚠️  %d row(s) failed to write", failed)
	}
	return written, nil
}

// The three ways the writer loads a file. They are the asic_report_ingests.mode values (000154).
const (
	modeDaily     = "daily"
	modePoll      = "poll"
	modeReconcile = "reconcile"
)

// ingestRecord is one ASIC report file as the writer has just left it: the date
// it is for, the distinct product codes it parsed, and how it was loaded.
type ingestRecord struct {
	ReportDate time.Time
	Codes      []string
	SourceFile string
	Mode       string
}

// loadedCodesSQL reads the distinct product codes shorts holds for the date, after
// the write. The codes come back as stored, padding and all: RecordIngest trims
// them in Go with strings.TrimSpace, the same trim RowsOnDate applies, so a padded
// legacy row ("WBT ") counts as its code under both readers. SQL trimming would
// trim a narrower set of characters than Go does, and the two would disagree on
// a non-space padding. The date range is the same half-open day range rowsOnDateSQL
// uses, so the (DATE, PRODUCT_CODE) index serves it.
const loadedCodesSQL = `
        SELECT COALESCE(array_agg(DISTINCT "PRODUCT_CODE"), '{}')
        FROM shorts
        WHERE "DATE" >= $1 AND "DATE" < $2 AND "PRODUCT_CODE" IS NOT NULL`

// upsertIngestSQL records one file. first_ingested_at and mode are the
// observation that must survive a later load, so the update leaves them alone.
const upsertIngestSQL = `
        INSERT INTO asic_report_ingests (report_date, file_rows, loaded_rows, source_file, mode, last_mode)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (report_date) DO UPDATE SET
            last_ingested_at = now(),
            file_rows        = EXCLUDED.file_rows,
            loaded_rows      = EXCLUDED.loaded_rows,
            source_file      = EXCLUDED.source_file,
            last_mode        = EXCLUDED.last_mode`

// RecordIngest upserts the report's asic_report_ingests row. file_rows is the
// number of distinct codes the file parsed. loaded_rows is recounted from shorts
// here, never taken from the writer's own write count, so a row that failed to
// write is not counted and a row written by an earlier run is. That recount is
// the completeness fact: a report is complete when loaded_rows >= file_rows.
//
// A file that parsed to no codes records file_rows NULL, not 0. Zero is a
// complete report by that rule, so a file whose every record failed to parse
// (a format change, say) would read as complete and mark every code absent in a
// strategy read. NULL leaves completeness unknown, which is the truth.
func (s *pgStore) RecordIngest(ctx context.Context, rec ingestRecord) error {
	day := truncateDay(rec.ReportDate)
	var fileRows *int
	loaded := 0
	if len(rec.Codes) > 0 {
		n := len(distinctTrimmed(rec.Codes))
		fileRows = &n
		var stored []string
		if err := s.db.QueryRow(ctx, loadedCodesSQL,
			day, day.AddDate(0, 0, 1),
		).Scan(&stored); err != nil {
			return fmt.Errorf("ingest %s: count loaded rows: %w", day.Format("2006-01-02"), err)
		}
		loaded = countPresent(rec.Codes, stored)
	}
	if _, err := s.db.Exec(ctx, upsertIngestSQL,
		day, fileRows, loaded, rec.SourceFile, rec.Mode, rec.Mode,
	); err != nil {
		return fmt.Errorf("ingest %s: upsert: %w", day.Format("2006-01-02"), err)
	}
	return nil
}

// countPresent counts the distinct file codes that appear among the stored codes,
// comparing both sides trimmed the way RowsOnDate trims them.
func countPresent(fileCodes, stored []string) int {
	have := make(map[string]struct{}, len(stored))
	for _, c := range stored {
		have[strings.TrimSpace(c)] = struct{}{}
	}
	n := 0
	for _, c := range distinctTrimmed(fileCodes) {
		if _, ok := have[c]; ok {
			n++
		}
	}
	return n
}

// distinctTrimmed returns the trimmed codes once each.
func distinctTrimmed(codes []string) []string {
	seen := make(map[string]struct{}, len(codes))
	out := make([]string, 0, len(codes))
	for _, c := range codes {
		t := strings.TrimSpace(c)
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return out
}

// revisionRecord is one stored row that ASIC's current file changed: the stored
// values and the file's. A NULL stored value is a revision too: it is a repair.
type revisionRecord struct {
	Date                                time.Time
	Code                                string
	OldPositions, OldShares, OldPercent *float64
	NewPositions, NewShares, NewPercent float64
}

// insertRevisionSQL is one shorts_revisions row. It is written by the writer, not a
// trigger: shorts holds about 2.1M rows and must not gain one (architecture 9.1).
const insertRevisionSQL = `
        INSERT INTO shorts_revisions (
            report_date, product_code,
            old_positions, new_positions, old_shares, new_shares, old_percent, new_percent)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

// InsertRevisions records one row per revision and returns how many landed. It
// is row-at-a-time in autocommit, like UpsertRows, so a row that fails is counted
// and the rest are kept. Cancellation is respected between rows.
func (s *pgStore) InsertRevisions(ctx context.Context, revs []revisionRecord) (int, error) {
	written := 0
	failed := 0
	for _, r := range revs {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		_, err := s.db.Exec(ctx, insertRevisionSQL,
			truncateDay(r.Date), r.Code,
			r.OldPositions, r.NewPositions, r.OldShares, r.NewShares, r.OldPercent, r.NewPercent,
		)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return written, err
			}
			if failed == 0 {
				log.Printf("   revision insert error (first of batch): %v", err)
			}
			failed++
			continue
		}
		written++
	}
	if failed > 0 {
		log.Printf("   ⚠️  %d revision row(s) failed to write", failed)
	}
	return written, nil
}

// LastShortsDate returns MAX("DATE") from shorts, and false when the table is
// empty (the Python's initial-load branch).
func (s *pgStore) LastShortsDate(ctx context.Context) (time.Time, bool, error) {
	var last *time.Time
	if err := s.db.QueryRow(ctx, `SELECT MAX("DATE") FROM shorts`).Scan(&last); err != nil {
		return time.Time{}, false, fmt.Errorf("last shorts date: %w", err)
	}
	if last == nil {
		return time.Time{}, false, nil
	}
	return truncateDay(*last), true, nil
}

// ExistingKeys returns the (date, product_code) pairs already present from
// `from` onwards, used by the shadow run to classify would-insert vs
// would-update WITHOUT writing anything.
func (s *pgStore) ExistingKeys(ctx context.Context, from time.Time) (map[string]struct{}, error) {
	rows, err := s.db.Query(ctx,
		`SELECT "DATE", "PRODUCT_CODE" FROM shorts WHERE "DATE" >= $1`, from)
	if err != nil {
		return nil, fmt.Errorf("existing keys: %w", err)
	}
	defer rows.Close()

	out := map[string]struct{}{}
	for rows.Next() {
		var d time.Time
		var code string
		if err := rows.Scan(&d, &code); err != nil {
			return nil, fmt.Errorf("existing keys: scan: %w", err)
		}
		out[rowKey(truncateDay(d), code)] = struct{}{}
	}
	return out, rows.Err()
}

// rowsOnDateSQL reads the rows the table holds for ONE observation date — the
// comparison side of the reconcile pass (reconcile.go).
//
// A half-open day range rather than equality, so a time-of-day component on a
// row can never hide it from the comparison. It is a range scan of the
// (DATE, PRODUCT_CODE) unique index the upsert already depends on.
const rowsOnDateSQL = `
        SELECT "PRODUCT_CODE",
               "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE",
               "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
        FROM shorts
        WHERE "DATE" >= $1 AND "DATE" < $2 AND "PRODUCT_CODE" IS NOT NULL`

// RowsOnDate returns the rows already stored for date d, keyed by TRIMMED code.
//
// Trimmed with the same strings.TrimSpace parseFile applies to a file's codes,
// because pre-2023 files padded some codes ("WBT ") and legacy loads stored
// them that way: a padded row must count as present, or a repair would write a
// second, trimmed copy and double-count the date. When a date holds both forms,
// the exact one wins — it is the row an upsert would touch.
func (s *pgStore) RowsOnDate(ctx context.Context, d time.Time) (map[string]storedRow, error) {
	day := truncateDay(d)
	rows, err := s.db.Query(ctx, rowsOnDateSQL, day, day.AddDate(0, 0, 1))
	if err != nil {
		return nil, fmt.Errorf("rows on %s: %w", day.Format("2006-01-02"), err)
	}
	defer rows.Close()

	out := map[string]storedRow{}
	for rows.Next() {
		var st storedRow
		if err := rows.Scan(&st.Code, &st.Short, &st.Issue, &st.Pct); err != nil {
			return nil, fmt.Errorf("rows on %s: scan: %w", day.Format("2006-01-02"), err)
		}
		key := strings.TrimSpace(st.Code)
		if prev, ok := out[key]; ok && prev.Code == key {
			continue
		}
		out[key] = st
	}
	return out, rows.Err()
}

// rowsForCodesSQL reads the CURRENT rows for a handful of product codes over
// the sync window. Read-only, parameterised, and bounded by the caller's
// validated code list (max 20) — it is the only extra database access a
// `-shadow -stocks` validation run performs.
const rowsForCodesSQL = `
        SELECT "DATE", "PRODUCT", "PRODUCT_CODE",
               "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE",
               "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
        FROM shorts
        WHERE "DATE" >= $1 AND "PRODUCT_CODE" = ANY($2)`

// RowsForCodes returns the current shorts rows for `codes` from `from` onwards,
// keyed by rowKey(date, code), so a shadow run can diff file against database
// without writing anything.
//
// A NULL numeric column reads back as 0 rather than failing the whole report —
// the diff's job is to SHOW the discrepancy, not to refuse to run because of it.
func (s *pgStore) RowsForCodes(ctx context.Context, codes []string, from time.Time) (map[string]shortsRow, error) {
	out := map[string]shortsRow{}
	if len(codes) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, rowsForCodesSQL, from, codes)
	if err != nil {
		return nil, fmt.Errorf("rows for codes: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			d                 time.Time
			product, code     *string
			short, total, pct *float64
		)
		if err := rows.Scan(&d, &product, &code, &short, &total, &pct); err != nil {
			return nil, fmt.Errorf("rows for codes: scan: %w", err)
		}
		r := shortsRow{
			Date:                   truncateDay(d),
			Product:                derefString(product),
			ProductCode:            derefString(code),
			ReportedShortPositions: derefFloat(short),
			TotalProductInIssue:    derefFloat(total),
			Percent:                derefFloat(pct),
		}
		out[rowKey(r.Date, r.ProductCode)] = r
	}
	return out, rows.Err()
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefFloat(f *float64) float64 {
	if f == nil {
		return 0
	}
	return *f
}

// healthReport is check_data_health()'s payload.
type healthReport struct {
	TotalStocks int
	Incomplete  int
	Partial     int
	Complete    int
	HealthScore float64
	StaleStocks []staleStock
}

// staleStock is one stock whose price history stopped more than 7 days ago.
type staleStock struct {
	StockCode string
	LastDate  time.Time
}

const healthSummarySQL = `
            SELECT
                COUNT(*) as total_stocks,
                COUNT(CASE WHEN records < 500 THEN 1 END) as incomplete,
                COUNT(CASE WHEN records >= 500 AND records < 2000 THEN 1 END) as partial,
                COUNT(CASE WHEN records >= 2000 THEN 1 END) as complete
            FROM (
                SELECT stock_code, COUNT(*) as records
                FROM stock_prices
                GROUP BY stock_code
            ) sub`

const healthStaleSQL = `
            SELECT stock_code, MAX(date) as last_date
            FROM stock_prices
            GROUP BY stock_code
            HAVING MAX(date) < CURRENT_DATE - INTERVAL '7 days'
            ORDER BY MAX(date) ASC
            LIMIT 10`

// Health reproduces check_data_health(): a read-only completeness report over
// stock_prices. It is kept even though this job no longer syncs prices — the
// block is part of the run's log surface and costs two cheap aggregates.
func (s *pgStore) Health(ctx context.Context) (healthReport, error) {
	var h healthReport
	if err := s.db.QueryRow(ctx, healthSummarySQL).
		Scan(&h.TotalStocks, &h.Incomplete, &h.Partial, &h.Complete); err != nil {
		return healthReport{}, fmt.Errorf("health summary: %w", err)
	}
	rows, err := s.db.Query(ctx, healthStaleSQL)
	if err != nil {
		return healthReport{}, fmt.Errorf("health stale: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var st staleStock
		if err := rows.Scan(&st.StockCode, &st.LastDate); err != nil {
			return healthReport{}, fmt.Errorf("health stale: scan: %w", err)
		}
		h.StaleStocks = append(h.StaleStocks, st)
	}
	if err := rows.Err(); err != nil {
		return healthReport{}, err
	}
	h.HealthScore = healthScore(h.Complete, h.TotalStocks)
	return h, nil
}

// healthScore is complete/total as a percentage rounded to 1dp, with the
// Python's max(total,1) guard against a divide-by-zero on an empty table.
func healthScore(complete, total int) float64 {
	denom := max(total, 1)
	return round1(float64(complete) / float64(denom) * 100)
}

func round1(f float64) float64 {
	return float64(int64(f*10+0.5)) / 10
}

// refreshAllSQL is ONE statement string on purpose.
//
// Supabase arms a session statement_timeout when the client command starts, so
// it must be cleared on THIS session — a SET inside
// refresh_all_materialized_views() cannot disarm it, and a cancelled refresh
// silently starves every MV after it in the chain (Jul 2026: /statistics and
// /scans served 19-day-old data). Sending the SET and the refresh as ONE
// simple-protocol command keeps them on ONE backend session even through a
// transaction pooler, where two separate Execs may land on different backends.
//
// platform.Connect sets QueryExecModeSimpleProtocol, which is what makes a
// multi-statement Exec legal here — do not "fix" this into two calls.
const refreshAllSQL = `SET statement_timeout = 0; SELECT refresh_all_materialized_views()`

// individualMVs is the fallback chain the Python tried when the aggregate
// function failed, in the same order.
var individualMVs = []string{"mv_treemap_data", "mv_top_shorts", "mv_watchlist_defaults"}

// RefreshMaterializedViews refreshes the read-path MVs, falling back to the
// three individual REFRESH statements when the aggregate function errors.
// Best-effort: a refresh failure is logged and never fails the run (the data is
// already committed; the MVs self-heal on the next cycle).
func (s *pgStore) RefreshMaterializedViews(ctx context.Context) {
	_, err := s.db.Exec(ctx, refreshAllSQL)
	if err == nil {
		for _, mv := range individualMVs {
			log.Printf("   ✅ %s refreshed", mv)
		}
		return
	}
	log.Printf("⚠️ Could not refresh materialized views: %v", err)
	for _, mv := range individualMVs {
		// The same timeout argument applies to each fallback statement.
		if _, err := s.db.Exec(ctx, fmt.Sprintf("SET statement_timeout = 0; REFRESH MATERIALIZED VIEW %s", mv)); err != nil {
			continue
		}
		log.Printf("   ✅ %s refreshed (fallback)", mv)
	}
}

const cleanupStuckSQL = `
        UPDATE sync_status
        SET status = 'failed',
            completed_at = CURRENT_TIMESTAMP,
            error_message = 'Job timed out (cleaned up by next run)'
        WHERE status = 'running'
          AND started_at < NOW() - INTERVAL '5 hours'`

// CleanupStuckRuns marks runs that have been 'running' for over 5 hours as
// failed, so the admin jobs dashboard is not pinned by an abandoned execution.
func (s *pgStore) CleanupStuckRuns(ctx context.Context) (int64, error) {
	tag, err := s.db.Exec(ctx, cleanupStuckSQL)
	if err != nil {
		return 0, fmt.Errorf("cleanup stuck runs: %w", err)
	}
	return tag.RowsAffected(), nil
}

// truncateDay drops the time-of-day component; the shorts "DATE" column is a
// timestamp but is only ever populated at midnight.
func truncateDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// rowKey is the (date, code) identity of a shorts row.
func rowKey(d time.Time, code string) string {
	return d.Format("2006-01-02") + "|" + code
}
