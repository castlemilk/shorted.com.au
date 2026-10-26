package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// All SQL lives here. Every write is either an insert that ON CONFLICT ignores, or
// an UPDATE keyed by a row id the same run claimed, so a retried run cannot
// double-send.

// Scanning the shorts table by its composite key keeps the window read on an index.
const windowSQL = `
WITH RECURSIVE d(dt) AS (
  SELECT max("DATE") FROM shorts
  UNION ALL
  SELECT (SELECT max("DATE") FROM shorts WHERE "DATE" < d.dt) FROM d WHERE d.dt IS NOT NULL
)
SELECT dt FROM d WHERE dt IS NOT NULL LIMIT $1`

type store struct {
	pool *pgxpool.Pool
}

// ensureState creates the single watermark row the first time a run writes.
func (s store) ensureState(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO alert_evaluator_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)
	return err
}

// abandonStaleRuns closes run rows a killed process left running. An hour is well
// past a run's 900-second ceiling.
func (s store) abandonStaleRuns(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE alert_evaluator_runs
		   SET outcome = 'failed', finished_at = now(), error = 'abandoned'
		 WHERE outcome = 'running' AND started_at < now() - interval '1 hour'`)
	return err
}

// asicSyncRow selects the sync_status rows the ASIC ingest wrote, and only those.
// shortdatasync's insert always sets environment (defaulting to 'development') and
// hostname (the execution id), while the market-data sync's insert sets neither.
// The table is shared, and the price sweep runs in the same 10:00 UTC slot as the
// ASIC backstop, so without this filter a price sweep would decide whether ASIC
// data is settled. shortdatasync's recorder_test pins the columns its insert sets.
const asicSyncRow = `environment IS NOT NULL AND hostname IS NOT NULL`

// syncRunning reports an ASIC ingest that is writing shorts right now. Its rows
// land one at a time, so a date is half-written until the sync finishes.
func (s store) syncRunning(ctx context.Context) (bool, error) {
	var busy bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM sync_status
		                WHERE status = 'running' AND started_at > now() - interval '2 hours'
		                  AND `+asicSyncRow+`)`).Scan(&busy)
	return busy, err
}

// latestSyncStatus is the status of the most recently started ASIC sync, or "" when
// none has ever run. Only a completed sync proves the newest report date was
// written in full: a sync that failed or was cancelled part-way leaves its last
// file partly written, and the next poll starts after that date, so nothing else
// repairs it until the 10:00 reconcile.
func (s store) latestSyncStatus(ctx context.Context) (string, error) {
	var status string
	err := s.pool.QueryRow(ctx, `
		SELECT status FROM sync_status WHERE `+asicSyncRow+`
		 ORDER BY started_at DESC LIMIT 1`).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read latest sync status: %w", err)
	}
	return status, nil
}

// reportDates returns the newest report dates, newest first.
func (s store) reportDates(ctx context.Context) ([]Date, error) {
	rows, err := s.pool.Query(ctx, windowSQL, windowDates)
	if err != nil {
		return nil, fmt.Errorf("read report dates: %w", err)
	}
	defer rows.Close()
	var out []Date
	for rows.Next() {
		var t time.Time
		if err := rows.Scan(&t); err != nil {
			return nil, fmt.Errorf("scan report date: %w", err)
		}
		out = append(out, dateOf(t))
	}
	return out, rows.Err()
}

// loadRows reads every reading between oldest and newest, inclusive. The range
// is the report window, so this is the same set as the window's dates.
func (s store) loadRows(ctx context.Context, oldest, newest Date) (map[Date]map[string]float64, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT "DATE", "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		  FROM shorts
		 WHERE "DATE" >= $1::date AND "DATE" < $2::date + 1
		   AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
		   AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)`,
		string(oldest), string(newest))
	if err != nil {
		return nil, fmt.Errorf("read readings: %w", err)
	}
	defer rows.Close()
	out := map[Date]map[string]float64{}
	for rows.Next() {
		var (
			t    time.Time
			code string
			pct  float64
		)
		if err := rows.Scan(&t, &code, &pct); err != nil {
			return nil, fmt.Errorf("scan reading: %w", err)
		}
		d := dateOf(t)
		if out[d] == nil {
			out[d] = map[string]float64{}
		}
		out[d][code] = pct
	}
	return out, rows.Err()
}

// loadCompanies reads each code's name, industry and logo. The sector column is
// absent from prod's company-metadata, so it is not read. The logo is the icon column
// only: the full logo is a wordmark, which is not shown in a square. The sector column
// is absent in prod, so it is not read either.
func (s store) loadCompanies(ctx context.Context) (map[string]CompanyInfo, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT stock_code, COALESCE(company_name, ''), COALESCE(industry, ''),
		       COALESCE(logo_icon_gcs_url, '')
		  FROM "company-metadata"`)
	if err != nil {
		return nil, fmt.Errorf("read company metadata: %w", err)
	}
	defer rows.Close()
	out := map[string]CompanyInfo{}
	for rows.Next() {
		var code, icon string
		var info CompanyInfo
		if err := rows.Scan(&code, &info.Name, &info.Industry, &icon); err != nil {
			return nil, fmt.Errorf("scan company: %w", err)
		}
		info.LogoURL = usableLogo(icon)
		out[code] = info
	}
	return out, rows.Err()
}

// Postgres float8 accepts NaN and Infinity, and encoding/json refuses them. A single
// such row would fail the whole commit, so both reads drop non-finite readings in SQL,
// and a non-finite share count is read as NULL: unknown, not an error. stockDetailOf
// repeats the check for anything that gets past the query.

// historyRow is one report's reading for a code, with the share counts that report
// gave. The counts are NULL on reports that did not give them.
type historyRow struct {
	date        Date
	pct         float64
	sharesShort *float64
	sharesOnIss *float64
}

// historyDays is the calendar span a stock's history reads: about six months of report
// dates. It is also the window that holds the 20-report comparison.
const historyDays = 190

// deferredCodes lists the codes whose product line on day is a DEFERRED settlement
// product. The site's top-shorts view excludes those lines, so the rank does too.
// The PRODUCT column is read here because the readings do not carry it.
func (s store) deferredCodes(ctx context.Context, day Date) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT "PRODUCT_CODE" FROM shorts
		 WHERE "DATE" = $1::date AND "PRODUCT" ILIKE '%DEFERRED%'`, string(day))
	if err != nil {
		return nil, fmt.Errorf("read deferred products: %w", err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, fmt.Errorf("scan deferred product: %w", err)
		}
		out[code] = true
	}
	return out, rows.Err()
}

// loadStockHistory reads each code's readings over historyDays up to and including
// newest, in one statement. The rows are oldest first per code. The
// idx_shorts_product_code_date index serves the code filter and the date range.
func (s store) loadStockHistory(ctx context.Context, codes []string, newest Date) (map[string][]historyRow, error) {
	out := map[string][]historyRow{}
	if len(codes) == 0 {
		return out, nil
	}
	day, err := newest.Day()
	if err != nil {
		return nil, fmt.Errorf("history: report date: %w", err)
	}
	from := day.AddDate(0, 0, -historyDays).Format(dateLayout)
	rows, err := s.pool.Query(ctx, `
		SELECT "PRODUCT_CODE", "DATE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS",
		       CASE WHEN "REPORTED_SHORT_POSITIONS" IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8) THEN NULL ELSE "REPORTED_SHORT_POSITIONS" END,
		       CASE WHEN "TOTAL_PRODUCT_IN_ISSUE" IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8) THEN NULL ELSE "TOTAL_PRODUCT_IN_ISSUE" END
		  FROM shorts
		 WHERE "PRODUCT_CODE" = ANY($1::text[])
		   AND "DATE" >= $2::date AND "DATE" < $3::date + 1
		   AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
		   AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)
		 ORDER BY "PRODUCT_CODE", "DATE"`, codes, from, string(newest))
	if err != nil {
		return nil, fmt.Errorf("read stock history: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			code string
			t    time.Time
			h    historyRow
		)
		if err := rows.Scan(&code, &t, &h.pct, &h.sharesShort, &h.sharesOnIss); err != nil {
			return nil, fmt.Errorf("scan stock history: %w", err)
		}
		h.date = dateOf(t)
		out[code] = append(out[code], h)
	}
	return out, rows.Err()
}

// state reads the watermarks. A missing row is the first run.
func (s store) state(ctx context.Context) (State, error) {
	var st State
	var daily, weekly string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(daily_through::text, ''), COALESCE(weekly_through::text, '')
		  FROM alert_evaluator_state WHERE id = 1`).Scan(&daily, &weekly)
	if errors.Is(err, pgx.ErrNoRows) {
		return State{}, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("read evaluator state: %w", err)
	}
	st.DailyThrough, st.WeeklyThrough = Date(daily), Date(weekly)
	return st, nil
}

// loadMonitors returns the active monitors that existed when the run started.
// userID, when set, limits the list to one owner (an operator replay).
func (s store) loadMonitors(ctx context.Context, runStarted time.Time, userID string) ([]Monitor, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_id, COALESCE(user_email, ''), scope, target, condition, threshold, cadence, created_at
		  FROM alert_monitors
		 WHERE status = 'active' AND created_at <= $1 AND ($2 = '' OR user_id = $2)
		 ORDER BY created_at, id`, runStarted, userID)
	if err != nil {
		return nil, fmt.Errorf("read monitors: %w", err)
	}
	defer rows.Close()
	var out []Monitor
	for rows.Next() {
		var m Monitor
		if err := rows.Scan(&m.ID, &m.UserID, &m.Email, &m.Scope, &m.Target, &m.Condition, &m.Threshold, &m.Cadence, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan monitor: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// canaryDue is true when no canary has gone out in the last twenty hours.
func (s store) canaryDue(ctx context.Context) (bool, error) {
	var due bool
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(last_canary_at IS NULL OR last_canary_at < now() - interval '20 hours', true)
		  FROM alert_evaluator_state WHERE id = 1`).Scan(&due)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	return due, err
}

// hasDeliveryWork reports rows still waiting on Resend, or a legacy row waiting on an
// entitlement lookup so it can expire, including a claim a crash left behind.
func (s store) hasDeliveryWork(ctx context.Context) (bool, error) {
	var work bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM alert_events
		                WHERE email_status IN ('pending', 'awaiting_entitlement')
		                   OR (email_status = 'sending' AND send_claimed_at < now() - interval '15 minutes'))`).Scan(&work)
	return work, err
}

// insertRun opens a run row. Its id and start time make the canary's idempotency key.
func (s store) insertRun(ctx context.Context, execution, note string, daily []Date, weekly Date) (int64, time.Time, error) {
	var dates []string
	for _, d := range daily {
		dates = append(dates, string(d))
	}
	var (
		id      int64
		started time.Time
	)
	err := s.pool.QueryRow(ctx, `
		INSERT INTO alert_evaluator_runs (execution, note, daily_dates, weekly_report_date)
		VALUES (NULLIF($1, ''), NULLIF($2, ''), $3::date[], NULLIF($4, '')::date)
		RETURNING id, started_at`, execution, note, dates, string(weekly)).Scan(&id, &started)
	return id, started, err
}

// runResult is what a finished run records.
type runResult struct {
	Outcome           string
	Error             string
	MonitorsEvaluated int
	EventsCreated     int
	EmailsSent        int
	EmailsRetrying    int
	EmailsFailed      int
	SkippedUnentitled int
	CanaryResendID    string
}

func (s store) finishRun(ctx context.Context, id int64, r runResult) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE alert_evaluator_runs
		   SET finished_at = now(), outcome = $2, error = NULLIF($3, ''),
		       monitors_evaluated = $4, events_created = $5, emails_sent = $6,
		       emails_retrying = $7, emails_failed = $8, skipped_unentitled = $9,
		       canary_resend_id = NULLIF($10, '')
		 WHERE id = $1`,
		id, r.Outcome, r.Error, r.MonitorsEvaluated, r.EventsCreated, r.EmailsSent,
		r.EmailsRetrying, r.EmailsFailed, r.SkippedUnentitled, r.CanaryResendID)
	return err
}

// pruneRuns keeps six months of run history.
func (s store) pruneRuns(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM alert_evaluator_runs WHERE started_at < now() - interval '180 days'`)
	return err
}

// eventRow is one alert_events row a commit inserts.
type eventRow struct {
	monitorID string
	userID    string
	msg       Message
	status    string
	lastError string
}

// commit writes one run's events and, unless it is a replay, its watermarks, in
// one transaction. planned is the state the run read. If another run has moved the
// watermarks since, nothing is written and applied is false.
//
// A monitor deleted after the run read it is not an error. Its row is skipped and
// counted in vanished, and the rest of the run commits. The monitors the rows name
// are share-locked first, so a delete cannot commit between the check and the insert:
// the delete waits for this transaction, and the foreign key cannot fail on a row that
// the lock kept.
func (s store) commit(ctx context.Context, planned, next State, replay bool, runID int64, rows []eventRow) (applied bool, inserted, vanished int, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, 0, 0, fmt.Errorf("begin commit: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if !replay {
		var daily, weekly string
		err := tx.QueryRow(ctx, `
			SELECT COALESCE(daily_through::text, ''), COALESCE(weekly_through::text, '')
			  FROM alert_evaluator_state WHERE id = 1 FOR UPDATE`).Scan(&daily, &weekly)
		if err != nil {
			return false, 0, 0, fmt.Errorf("lock evaluator state: %w", err)
		}
		if Date(daily) != planned.DailyThrough || Date(weekly) != planned.WeeklyThrough {
			return false, 0, 0, nil
		}
	}

	present, err := lockMonitors(ctx, tx, rows)
	if err != nil {
		return false, 0, 0, err
	}
	for _, r := range rows {
		if !present[r.monitorID] {
			vanished++
			continue
		}
		payload, err := encodePayload(r.msg.Payload)
		if err != nil {
			return false, 0, 0, fmt.Errorf("encode payload: %w", err)
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO alert_events
			  (monitor_id, user_id, scope, target, condition, threshold, cadence,
			   report_date, compared_to_date, latest_percent, previous_percent,
			   payload, email_status, last_error, run_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11, $12::jsonb, $13, NULLIF($14, ''), NULLIF($15, 0))
			ON CONFLICT (monitor_id, report_date) DO NOTHING`,
			r.monitorID, r.userID, r.msg.Scope, r.msg.Target, r.msg.Condition, r.msg.Threshold, r.msg.Cadence,
			string(r.msg.ReportDate), string(r.msg.ComparedTo), r.msg.Latest, r.msg.Previous,
			string(payload), r.status, r.lastError, runID)
		if err != nil {
			return false, 0, 0, fmt.Errorf("insert alert event: %w", err)
		}
		inserted += int(tag.RowsAffected())
	}

	if !replay && next != planned {
		if _, err := tx.Exec(ctx, `
			UPDATE alert_evaluator_state
			   SET daily_through = NULLIF($1, '')::date, weekly_through = NULLIF($2, '')::date, updated_at = now()
			 WHERE id = 1`, string(next.DailyThrough), string(next.WeeklyThrough)); err != nil {
			return false, 0, 0, fmt.Errorf("advance watermarks: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, 0, 0, fmt.Errorf("commit: %w", err)
	}
	return true, inserted, vanished, nil
}

// encodePayload encodes an event's payload. The stock detail is optional, so a
// payload that will not encode is retried without it: one bad detail must not fail
// the commit for every owner in the run. The event goes out without the detail.
func encodePayload(p alertevents.Payload) ([]byte, error) {
	b, err := json.Marshal(p)
	if err == nil || p.Stock == nil {
		return b, err
	}
	log.Printf("alerts: stock detail would not encode, event committed without it: %v", err)
	p.Stock = nil
	return json.Marshal(p)
}

// lockMonitors takes a share lock on every monitor the rows name, and returns the
// ids that still exist. The lock is held until the commit ends, so a monitor found
// here is still there when its events are inserted.
func lockMonitors(ctx context.Context, tx pgx.Tx, rows []eventRow) (map[string]bool, error) {
	seen := map[string]bool{}
	var ids []string
	for _, r := range rows {
		if !seen[r.monitorID] {
			seen[r.monitorID] = true
			ids = append(ids, r.monitorID)
		}
	}
	present := make(map[string]bool, len(ids))
	if len(ids) == 0 {
		return present, nil
	}
	found, err := tx.Query(ctx, `SELECT id FROM alert_monitors WHERE id = ANY($1::text[]) FOR KEY SHARE`, ids)
	if err != nil {
		return nil, fmt.Errorf("lock alert monitors: %w", err)
	}
	defer found.Close()
	for found.Next() {
		var id string
		if err := found.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan alert monitor: %w", err)
		}
		present[id] = true
	}
	if err := found.Err(); err != nil {
		return nil, fmt.Errorf("iterate alert monitors: %w", err)
	}
	return present, nil
}

// recoverStale puts back or gives up on rows a crashed run left in 'sending'. A
// resend reuses the same idempotency key, which Resend dedupes for 24 hours from
// the first request. So a row created inside that window goes back to pending,
// and an older one is marked ambiguous and not resent.
func (s store) recoverStale(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `
		UPDATE alert_events SET email_status = 'pending', send_claimed_at = NULL, updated_at = now()
		 WHERE email_status = 'sending' AND send_claimed_at < now() - interval '15 minutes'
		   AND created_at > now() - interval '23 hours'`); err != nil {
		return fmt.Errorf("recover stale claims: %w", err)
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE alert_events
		   SET email_status = 'failed', last_error = 'ambiguous: claimed >23h ago, not resent', updated_at = now()
		 WHERE email_status = 'sending' AND send_claimed_at < now() - interval '15 minutes'
		   AND created_at <= now() - interval '23 hours'`); err != nil {
		return fmt.Errorf("mark ambiguous claims: %w", err)
	}
	return nil
}

// expirePending fails a row that waited 48 hours, whether for Resend or for an
// entitlement lookup. An alert that old is stale, so it is never sent. The evaluator
// no longer writes awaiting_entitlement, but a row an earlier build wrote still expires
// here rather than waiting forever.
func (s store) expirePending(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE alert_events
		   SET email_status = 'failed',
		       last_error = CASE WHEN email_status = 'awaiting_entitlement'
		                         THEN 'expired: entitlement lookup never succeeded' ELSE 'expired' END,
		       updated_at = now()
		 WHERE email_status IN ('pending', 'awaiting_entitlement') AND created_at < now() - interval '48 hours'`)
	return err
}

// claimed is one queued email, with the monitor's state at claim time.
type claimed struct {
	id        int64
	monitorID string
	userID    string
	msg       Message
	attempts  int
	email     string // the monitor's user_email now
	monStatus string // the monitor's status now; "" when the monitor is gone
	createdAt time.Time
}

// claim takes up to max pending rows in one statement. SKIP LOCKED keeps two
// writers apart. userID, when set, limits the claim to one owner.
func (s store) claim(ctx context.Context, max int, userID string) ([]claimed, error) {
	rows, err := s.pool.Query(ctx, `
		WITH taken AS (
		  UPDATE alert_events
		     SET email_status = 'sending', send_claimed_at = now(),
		         email_attempts = email_attempts + 1, updated_at = now()
		   WHERE id IN (
		     SELECT id FROM alert_events
		      WHERE email_status = 'pending' AND ($2 = '' OR user_id = $2)
		      ORDER BY created_at, id
		      LIMIT $1
		      FOR UPDATE SKIP LOCKED)
		  RETURNING *)
		SELECT t.id, t.monitor_id, t.user_id, t.scope, t.target, t.condition, t.threshold, t.cadence,
		       t.report_date::text, t.compared_to_date::text, t.latest_percent, t.previous_percent,
		       t.payload, t.email_attempts, COALESCE(m.user_email, ''), COALESCE(m.status, ''), t.created_at
		  FROM taken t
		  LEFT JOIN alert_monitors m ON m.id = t.monitor_id
		 ORDER BY t.id`, max, userID)
	if err != nil {
		return nil, fmt.Errorf("claim queue: %w", err)
	}
	defer rows.Close()
	var out []claimed
	for rows.Next() {
		var (
			c       claimed
			payload []byte
			report  string
			compare string
		)
		if err := rows.Scan(&c.id, &c.monitorID, &c.userID, &c.msg.Scope, &c.msg.Target, &c.msg.Condition,
			&c.msg.Threshold, &c.msg.Cadence, &report, &compare, &c.msg.Latest, &c.msg.Previous,
			&payload, &c.attempts, &c.email, &c.monStatus, &c.createdAt); err != nil {
			return nil, fmt.Errorf("scan claim: %w", err)
		}
		c.msg.ReportDate, c.msg.ComparedTo = Date(report), Date(compare)
		if err := json.Unmarshal(payload, &c.msg.Payload); err != nil {
			return nil, fmt.Errorf("decode payload of event %d: %w", c.id, err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// markSent records an accepted send.
func (s store) markSent(ctx context.Context, id int64, resendID string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE alert_events
		   SET email_status = 'sent', resend_id = $2, sent_at = now(), last_error = NULL,
		       send_claimed_at = NULL, updated_at = now()
		 WHERE id = $1`, id, resendID)
	return err
}

// markRetry returns a row to the queue after a retryable failure. The attempt stays
// consumed.
func (s store) markRetry(ctx context.Context, id int64, lastErr string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE alert_events
		   SET email_status = 'pending', last_error = $2, send_claimed_at = NULL, updated_at = now()
		 WHERE id = $1`, id, lastErr)
	return err
}

// markFailed records a row that will not be sent.
func (s store) markFailed(ctx context.Context, id int64, lastErr string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE alert_events
		   SET email_status = 'failed', last_error = $2, send_claimed_at = NULL, updated_at = now()
		 WHERE id = $1`, id, lastErr)
	return err
}

// markSkipped records a row that was deliberately not sent.
func (s store) markSkipped(ctx context.Context, id int64, status string) error {
	if !validSkipStatus(status) {
		return fmt.Errorf("not a skip status: %s", status)
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE alert_events
		   SET email_status = $2, send_claimed_at = NULL, updated_at = now()
		 WHERE id = $1`, id, status)
	return err
}

// isSuppressed reports whether alert email to address is blocked by a bounce or a
// complaint. The address is compared lower-cased, as the webhook stores it.
func (s store) isSuppressed(ctx context.Context, address string) (bool, error) {
	var ok bool
	err := s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM alert_email_suppressions WHERE email = lower($1))`,
		strings.TrimSpace(address)).Scan(&ok)
	if err != nil {
		return false, fmt.Errorf("read suppression: %w", err)
	}
	return ok, nil
}

func validSkipStatus(status string) bool {
	switch status {
	case alertevents.StatusSkippedPaused, alertevents.StatusSkippedNoEmail, alertevents.StatusSkippedUnentitled, alertevents.StatusSkippedSuppressed:
		return true
	}
	return false
}

// returnToPending gives back rows that were claimed but not attempted, such as
// after a credential or quota failure. Their attempt is refunded.
func (s store) returnToPending(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE alert_events
		   SET email_status = 'pending', email_attempts = GREATEST(email_attempts - 1, 0),
		       send_claimed_at = NULL, updated_at = now()
		 WHERE id = ANY($1::bigint[])`, ids)
	return err
}

// markCanarySent records a delivered canary.
func (s store) markCanarySent(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `UPDATE alert_evaluator_state SET last_canary_at = now(), updated_at = now() WHERE id = 1`)
	return err
}
