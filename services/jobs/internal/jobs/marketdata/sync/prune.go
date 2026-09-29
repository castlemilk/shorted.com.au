package sync

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// pruneReferences are the stocks whose sessions define the ASX's trading
// calendar. A weekday on which none of them traded was a market holiday: ten
// of the largest names do not all halt on the same day for any other reason.
var pruneReferences = []string{"BHP", "CBA", "CSL", "NAB", "WBC", "ANZ", "RIO", "WES", "TLS", "WOW"}

// pruneStatementTimeout bounds each of the prune's statements. Every one of
// them reads the whole table (a weekday cannot be indexed), and the role's
// default statement timeout is 2 minutes: the dry run of 2026-09-28 counted
// 362,943 weekend rows inside it, and the live run of 2026-09-29 did not
// ("count weekend rows: canceling statement due to statement timeout"). Set
// on the prune's own transaction only, never on the connection, so no other
// statement on the pool inherits it.
const pruneStatementTimeout = "15min"

// pruneLockKey is the transaction-scoped advisory lock one prune holds while
// it counts and deletes. Behind the transaction pooler a statement can keep
// running on the server after the task that sent it has exited, so a Cloud Run
// retry can start while the previous attempt's scan is still going; two
// whole-table scans then slow each other, and the rest of the database, past
// their timeouts. The retry refuses instead. The value is arbitrary but fixed.
const pruneLockKey int64 = 0x7072756e65 // "prune"

// ErrPruneRunning is a prune that found another prune's transaction still
// open on the server.
var ErrPruneRunning = errors.New("another prune is still running on the database")

// maxHolidaysPerYear bounds a plausible year of ASX holidays. There are eight
// fixed ones, plus substitute days and the odd one-off closure; more than this
// in one year means the calendar is missing sessions, and deleting on it
// would delete trading days.
const maxHolidaysPerYear = 15

// PruneOptions controls one prune.
type PruneOptions struct {
	// DryRun counts what would be deleted and deletes nothing.
	DryRun bool
	// From starts the holiday calendar here instead of at the first stored
	// session, for a table whose oldest years the provider covers too sparsely
	// to judge. Weekend rows are deleted wherever they are: no weekend is ever
	// a session.
	From time.Time
}

// PruneReport is what one prune found and did.
type PruneReport struct {
	Mode       string   `json:"mode"` // always "prune"; the sweep's report has none
	Execution  string   `json:"execution,omitempty"`
	DryRun     bool     `json:"dry_run"`
	Attempt    int      `json:"attempt"`
	Duration   string   `json:"duration"`
	Error      string   `json:"error,omitempty"`
	References []string `json:"references"`

	// The calendar: the first and last session any reference holds, how many
	// sessions lie between them, and the weekdays in that span none traded.
	From        string   `json:"from,omitempty"`
	To          string   `json:"to,omitempty"`
	TradingDays int      `json:"trading_days"`
	Holidays    []string `json:"holidays,omitempty"`

	// Rows dated on a weekend (anywhere in the table) or on a holiday.
	WeekendRows       int            `json:"weekend_rows"`
	WeekendRowsByYear map[string]int `json:"weekend_rows_by_year,omitempty"`
	HolidayRows       int            `json:"holiday_rows"`
	HolidayRowsByDate map[string]int `json:"holiday_rows_by_date,omitempty"`
	Deleted           int            `json:"deleted"`
}

// Prune deletes stored prices dated on days the ASX did not trade: every
// weekend row, and every row on a market holiday.
//
// Those rows are not sessions. Most are the daylight-time dating defect: a
// bar stamped in UTC was filed on the previous day, so each Monday's session
// sat under the Sunday before it, and a session after a holiday under the
// holiday. The sweep overwrites sessions and never deletes, so these outlive
// every repair of the days around them. A weekday row on a trading day is
// kept whether or not the provider still has that session: providers drop the
// history of some codes (Yahoo's ASM starts on 2026-07-17), and the stored
// sessions are then the only record.
//
// The holidays come from the reference stocks' sessions at the primary
// provider only. A fallback is never asked: Alpha Vantage answers an ASX code
// with the US security of the same name, whose calendar is the NYSE's. If any
// reference fails to answer, or a year has more holidays than a real year
// can, nothing is deleted.
func (m *SyncManager) Prune(ctx context.Context, opts PruneOptions) (*PruneReport, error) {
	started := time.Now()
	r := &PruneReport{Mode: "prune", DryRun: opts.DryRun, Attempt: taskAttempt(), References: pruneReferences}
	err := m.prune(ctx, opts, r)
	r.Duration = time.Since(started).Round(time.Second).String()
	if err != nil {
		r.Error = err.Error()
	}
	r.log()
	r.publish(context.WithoutCancel(ctx), m.gcs, m.config.GCSBucketName)
	return r, err
}

func (m *SyncManager) prune(ctx context.Context, opts PruneOptions, r *PruneReport) error {
	from := opts.From
	if from.IsZero() {
		var first *time.Time
		if err := m.db.QueryRow(ctx, `SELECT MIN(date) FROM stock_prices`).Scan(&first); err != nil {
			return fmt.Errorf("read the first stored session: %w", err)
		}
		if first == nil {
			return nil // nothing stored
		}
		from = *first
	}
	sessions, err := m.tradingCalendar(ctx, utcDate(from), lastClosedSession(m.now()))
	if err != nil {
		return err
	}
	holidays := weekdayHolidays(sessions)
	r.From = sessions[0].Format("2006-01-02")
	r.To = sessions[len(sessions)-1].Format("2006-01-02")
	r.TradingDays = len(sessions)
	for _, h := range holidays {
		r.Holidays = append(r.Holidays, h.Format("2006-01-02"))
	}
	if err := checkHolidays(holidays); err != nil {
		return err
	}

	return m.pruneRows(ctx, opts.DryRun, r)
}

// pruneRows counts, and unless it is a dry run deletes, the weekend and holiday
// rows, in ONE transaction under the prune's own statement timeout and lock.
// A live run deletes with RETURNING and counts what came back, so each kind of
// row costs one scan of the table rather than a count and then a delete.
func (m *SyncManager) pruneRows(ctx context.Context, dryRun bool, r *PruneReport) error {
	mode := pgx.ReadWrite
	if dryRun {
		mode = pgx.ReadOnly
	}
	tx, err := m.db.BeginTx(ctx, pgx.TxOptions{AccessMode: mode})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = '`+pruneStatementTimeout+`'`); err != nil {
		return err
	}
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, pruneLockKey).Scan(&locked); err != nil {
		return fmt.Errorf("take the prune lock: %w", err)
	}
	if !locked {
		return fmt.Errorf("%w (a previous attempt's statement, which the server finishes or times out within %s; nothing deleted)",
			ErrPruneRunning, pruneStatementTimeout)
	}

	weekendQuery, holidayQuery, verb := weekendRowsByYearQuery, holidayRowsByDateQuery, "count"
	if !dryRun {
		weekendQuery, holidayQuery, verb = deleteWeekendRowsQuery, deleteHolidayRowsQuery, "delete"
	}
	if r.WeekendRowsByYear, err = countBy(ctx, tx, weekendQuery); err != nil {
		return fmt.Errorf("%s weekend rows: %w", verb, err)
	}
	if r.HolidayRowsByDate, err = countBy(ctx, tx, holidayQuery, r.Holidays); err != nil {
		return fmt.Errorf("%s holiday rows: %w", verb, err)
	}
	r.WeekendRows, r.HolidayRows = sum(r.WeekendRowsByYear), sum(r.HolidayRowsByDate)
	if dryRun {
		return nil
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit the prune: %w", err)
	}
	r.Deleted = r.WeekendRows + r.HolidayRows
	if r.Deleted > 0 {
		if err := m.refreshStockPriceCoverage(ctx); err != nil {
			log.Printf("⚠️ Failed to refresh stock price coverage view: %v", err)
		}
	}
	return nil
}

// asxCode limits the prune to ASX codes. The calendar is the ASX's, so a row
// under any other kind of symbol, which may trade on other days, is not its to
// judge.
const asxCode = `stock_code ~ '^[A-Z0-9]{3,6}$'`

const weekendRowsByYearQuery = `
	SELECT to_char(date, 'YYYY'), count(*)
	FROM stock_prices
	WHERE EXTRACT(ISODOW FROM date) IN (6, 7) AND ` + asxCode + `
	GROUP BY 1`

const holidayRowsByDateQuery = `
	SELECT to_char(date, 'YYYY-MM-DD'), count(*)
	FROM stock_prices
	WHERE date = ANY($1::date[]) AND ` + asxCode + `
	GROUP BY 1`

// The live run's statements: the same rows as the counts above, deleted, and
// counted from what the delete returns.
const deleteWeekendRowsQuery = `
	WITH deleted AS (
		DELETE FROM stock_prices
		WHERE EXTRACT(ISODOW FROM date) IN (6, 7) AND ` + asxCode + `
		RETURNING date
	)
	SELECT to_char(date, 'YYYY'), count(*) FROM deleted GROUP BY 1`

const deleteHolidayRowsQuery = `
	WITH deleted AS (
		DELETE FROM stock_prices
		WHERE date = ANY($1::date[]) AND ` + asxCode + `
		RETURNING date
	)
	SELECT to_char(date, 'YYYY-MM-DD'), count(*) FROM deleted GROUP BY 1`

// countBy runs a two-column (key, count) query.
func countBy(ctx context.Context, tx pgx.Tx, query string, args ...any) (map[string]int, error) {
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var key string
		var n int
		if err := rows.Scan(&key, &n); err != nil {
			return nil, err
		}
		out[key] = n
	}
	return out, rows.Err()
}

// tradingCalendar is every session any reference stock holds at the primary
// provider in [from, to], sorted. Every reference must answer.
func (m *SyncManager) tradingCalendar(ctx context.Context, from, to time.Time) ([]time.Time, error) {
	if len(m.providers) == 0 {
		return nil, fmt.Errorf("no price provider configured")
	}
	p := m.providers[0]
	seen := map[time.Time]bool{}
	for _, ref := range pruneReferences {
		if err := m.pace(ctx, p); err != nil {
			return nil, err
		}
		records, err := p.FetchHistoricalData(ctx, ref, from, to)
		if err != nil {
			return nil, fmt.Errorf("trading calendar: %s from %s: %w (nothing deleted)", ref, p.Name(), err)
		}
		for _, rec := range sessionsIn(ref, records, from, to) {
			seen[rec.Date] = true
		}
	}
	if len(seen) == 0 {
		return nil, fmt.Errorf("trading calendar: no reference holds a session from %s to %s (nothing deleted)",
			from.Format("2006-01-02"), to.Format("2006-01-02"))
	}
	out := make([]time.Time, 0, len(seen))
	for d := range seen {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Before(out[j]) })
	return out, nil
}

// weekdayHolidays is every weekday between the first and last session that is
// not a session. Days outside that span are not judged.
func weekdayHolidays(sessions []time.Time) []time.Time {
	if len(sessions) == 0 {
		return nil
	}
	have := make(map[time.Time]bool, len(sessions))
	for _, s := range sessions {
		have[s] = true
	}
	var out []time.Time
	for d := sessions[0]; !d.After(sessions[len(sessions)-1]); d = d.AddDate(0, 0, 1) {
		if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday && !have[d] {
			out = append(out, d)
		}
	}
	return out
}

// checkHolidays refuses a calendar with more holidays in a year than a real
// year has: its reference sessions are incomplete.
func checkHolidays(holidays []time.Time) error {
	perYear := map[int]int{}
	for _, h := range holidays {
		perYear[h.Year()]++
	}
	for year, n := range perYear {
		if n > maxHolidaysPerYear {
			return fmt.Errorf("trading calendar: %d weekdays without a session in %d, more than a year of ASX holidays (%d); the reference sessions are incomplete (nothing deleted)",
				n, year, maxHolidaysPerYear)
		}
	}
	return nil
}

func sum(m map[string]int) int {
	n := 0
	for _, v := range m {
		n += v
	}
	return n
}

func (r *PruneReport) log() {
	verb := "would delete"
	if !r.DryRun {
		verb = "deleted"
	}
	log.Printf("🧹 Prune (%s): calendar %s to %s, %d sessions, %d holidays; %d weekend rows and %d holiday rows; %s %d",
		map[bool]string{true: "dry run", false: "live"}[r.DryRun], r.From, r.To, r.TradingDays, len(r.Holidays),
		r.WeekendRows, r.HolidayRows, verb, map[bool]int{true: r.WeekendRows + r.HolidayRows, false: r.Deleted}[r.DryRun])
	if r.Error != "" {
		log.Printf("❌ %s", r.Error)
	}
}
