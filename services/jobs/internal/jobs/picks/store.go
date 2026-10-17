package picks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// store is everything the job reads and writes. The pg implementation is the
// only one in production; tests use a fake so selection, dry-run and the exit
// rule are exercised without a database.
type store interface {
	// UniverseCodes: codes with a stock_prices row in the last 90 days, plus
	// every mv_screener_data code. Deduped, unordered.
	UniverseCodes(ctx context.Context) ([]string, error)
	// SyncStates: every stock_fundamentals_sync row, by code.
	SyncStates(ctx context.Context) (map[string]syncState, error)
	// RankInputs: market cap and 20-day dollar volume by code, the order of
	// never-attempted codes (§3.7). Best-effort: partial maps are fine.
	RankInputs(ctx context.Context) (map[string]rankInput, error)
	// RecentFilingHeadlines: (code, date, headline) from asx_announcements in
	// the last `days` days that pass the cheap SQL prefilter.
	RecentFilingHeadlines(ctx context.Context, days int) ([]filingHeadline, error)
	// UpsertPeriods writes one code's vendor rows as ONE statement under the
	// §2.2 vendor rules (upsertSQL).
	UpsertPeriods(ctx context.Context, code string, rows []PeriodRow, fetchedAt time.Time) error
	// RecordAttempt writes the code's stock_fundamentals_sync row.
	RecordAttempt(ctx context.Context, a attempt) error
	// RefreshStrategyViews runs refresh_strategy_views() and returns the
	// picker views it did not refresh: the ones it reported as skipped, and
	// any that exist but the call never named (a function body older than the
	// view, see pickerViews).
	RefreshStrategyViews(ctx context.Context) (skipped []string, err error)

	// The run lease (§3.8). ClaimLease returns claimed=false and the current
	// holder when another execution holds an unexpired lease; errLeaseAbsent
	// when the table does not exist (a database without 000132).
	ClaimLease(ctx context.Context, holder string) (claimed bool, current string, err error)
	ExtendLease(ctx context.Context, holder string) error
	ReleaseLease(ctx context.Context, holder string) error

	// filingStore: the -mode filings reads and writes (filings_store.go).
	filingStore
}

type filingHeadline struct {
	Code     string
	Date     time.Time
	Headline string
}

// attempt is one fetch outcome, recorded for every code the run asked about.
type attempt struct {
	Code          string
	At            time.Time
	Success       bool   // rows were written
	Outcome       string // outcomeLoaded | outcomeEmpty | outcomeFailed
	Err           string // "" on success; the reason otherwise
	PeriodsLoaded int
	// Measured: this attempt measured the code's vendor facts, so write
	// MedianK (nil = NULL) to stock_fundamentals_sync.median_k, FXConverted to
	// fx_converted and NativeCurrency ("" = NULL) to native_currency. False
	// keeps the stored values (a run Yahoo did not answer says nothing about
	// the identity reference or the currency).
	Measured       bool
	MedianK        *float64
	FXConverted    bool
	NativeCurrency string
}

// errLeaseAbsent: picks_run_lease does not exist (SQLSTATE 42P01): run
// without the lease (§3.8).
var errLeaseAbsent = errors.New("picks_run_lease absent")

type pgStore struct {
	pool    *pgxpool.Pool
	notices *noticeLog
	logf    func(format string, args ...any)

	schemaMu     sync.Mutex
	schemaKnown  bool
	fundExtended bool // stock_fundamentals has the 000132 columns
	syncExtended bool // stock_fundamentals_sync has the 000132 columns
}

func (s *pgStore) log(format string, args ...any) {
	if s.logf != nil {
		s.logf(format, args...)
	}
}

// undefinedTable is SQLSTATE 42P01: a relation that does not exist yet
// (mv_screener_data or asx_announcements in a dev database without those
// migrations, picks_run_lease before 000132).
func undefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

// undefinedColumn is SQLSTATE 42703: a column that does not exist yet (a
// database without 000132).
func undefinedColumn(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42703"
}

// ---------------------------------------------------------------------------
// Migration 000132 detection. Prod does not run `migrate up`: the new jobs
// image can meet a database that lacks 000132 (a deploy whose allowlist step
// failed, a laptop, the env-gated tests). Detected once per process from the
// catalog, and again from a 42703 on a write; either way the job falls back
// to the 000129 column set and says so once.

// fundamentals000132Columns are the stock_fundamentals columns 000132 adds.
func fundamentals000132Columns() []string {
	var out []string
	for _, c := range fundamentalsColumns {
		if !isColumn000129(c.name) {
			out = append(out, c.name)
		}
	}
	return append(out, "field_sources", "source_document_url", "source_document_date")
}

// sync000132Columns are the stock_fundamentals_sync columns 000132 adds.
var sync000132Columns = []string{"last_outcome", "consecutive_empty", "median_k", "fx_converted", "native_currency"}

// legacyColumns are the value columns of 000129 (today's column set).
func legacyColumns() []fundamentalsColumn {
	var out []fundamentalsColumn
	for _, c := range fundamentalsColumns {
		if isColumn000129(c.name) {
			out = append(out, c)
		}
	}
	return out
}

func isColumn000129(name string) bool {
	switch name {
	case "revenue", "net_income", "eps_basic", "eps_diluted", "operating_cash_flow", "free_cash_flow", "shares_outstanding":
		return true
	}
	return false
}

const schemaSQL = `
SELECT c.relname::text, a.attname::text
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
WHERE a.attrelid IN (to_regclass('stock_fundamentals'), to_regclass('stock_fundamentals_sync'))
  AND a.attnum > 0 AND NOT a.attisdropped`

// schema reports which halves of 000132 are applied, reading the catalog on
// first use.
func (s *pgStore) schema(ctx context.Context) (fund, syncExt bool, err error) {
	s.schemaMu.Lock()
	defer s.schemaMu.Unlock()
	if s.schemaKnown {
		return s.fundExtended, s.syncExtended, nil
	}
	rows, err := s.pool.Query(ctx, schemaSQL)
	if err != nil {
		return false, false, fmt.Errorf("schema probe: %w", err)
	}
	defer rows.Close()
	have := map[string]map[string]bool{}
	for rows.Next() {
		var rel, col string
		if err := rows.Scan(&rel, &col); err != nil {
			return false, false, fmt.Errorf("schema probe: %w", err)
		}
		if have[rel] == nil {
			have[rel] = map[string]bool{}
		}
		have[rel][col] = true
	}
	if err := rows.Err(); err != nil {
		return false, false, fmt.Errorf("schema probe: %w", err)
	}
	s.fundExtended = hasAll(have["stock_fundamentals"], fundamentals000132Columns())
	s.syncExtended = hasAll(have["stock_fundamentals_sync"], sync000132Columns)
	s.schemaKnown = true
	if !s.fundExtended || !s.syncExtended {
		s.log("picks: migration 000132 not (fully) applied: stock_fundamentals extended=%t, stock_fundamentals_sync extended=%t; writing the 000129 column set where it is missing", s.fundExtended, s.syncExtended)
	}
	return s.fundExtended, s.syncExtended, nil
}

// downgrade records that a write met a missing 000132 column (42703).
func (s *pgStore) downgrade(fund bool) {
	s.schemaMu.Lock()
	defer s.schemaMu.Unlock()
	if fund && s.fundExtended {
		s.fundExtended = false
		s.log("picks: stock_fundamentals rejected a 000132 column (42703); falling back to the 000129 column set for this run")
	}
	if !fund && s.syncExtended {
		s.syncExtended = false
		s.log("picks: stock_fundamentals_sync rejected a 000132 column (42703); falling back to the 000129 columns for this run")
	}
}

func hasAll(have map[string]bool, want []string) bool {
	for _, w := range want {
		if !have[w] {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Reads.

func (s *pgStore) UniverseCodes(ctx context.Context) ([]string, error) {
	set := map[string]bool{}
	collect := func(sql string) error {
		rows, err := s.pool.Query(ctx, sql)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var code string
			if err := rows.Scan(&code); err != nil {
				return err
			}
			set[code] = true
		}
		return rows.Err()
	}
	if err := collect(`SELECT DISTINCT stock_code::text FROM stock_prices WHERE date >= CURRENT_DATE - 90`); err != nil {
		return nil, fmt.Errorf("universe (stock_prices): %w", err)
	}
	// Two queries rather than one UNION so a database without
	// mv_screener_data still gets the price universe.
	if err := collect(`SELECT stock_code::text FROM mv_screener_data`); err != nil {
		if !undefinedTable(err) {
			return nil, fmt.Errorf("universe (mv_screener_data): %w", err)
		}
	}
	out := make([]string, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	return out, nil
}

// The last column is syncState.Legacy. With 000132 it is TRUE for a row no
// attempt has written since the migration (last_outcome NULL): that code's
// stored rows are the 000129 seven-column shape, so selection re-fetches it
// like a never-attempted code. Without 000132 it is always FALSE: the job can
// only write the 000129 columns there, so a re-fetch would gain nothing and
// would re-queue the same largest codes every night, starving the rest.
const (
	syncStatesSQL = `SELECT stock_code::text, last_attempt_at, last_success_at, COALESCE(last_error, ''),
       last_outcome::text, consecutive_empty, (last_outcome IS NULL)
FROM stock_fundamentals_sync`
	syncStatesLegacySQL = `SELECT stock_code::text, last_attempt_at, last_success_at, COALESCE(last_error, ''),
       NULL::text, 0::smallint, false
FROM stock_fundamentals_sync`
)

func (s *pgStore) SyncStates(ctx context.Context) (map[string]syncState, error) {
	_, syncExt, err := s.schema(ctx)
	if err != nil {
		return nil, err
	}
	q := syncStatesLegacySQL
	if syncExt {
		q = syncStatesSQL
	}
	rows, err := s.pool.Query(ctx, q)
	if err != nil && syncExt && undefinedColumn(err) {
		s.downgrade(false)
		rows, err = s.pool.Query(ctx, syncStatesLegacySQL)
	}
	if err != nil {
		return nil, fmt.Errorf("sync states: %w", err)
	}
	defer rows.Close()
	out := map[string]syncState{}
	for rows.Next() {
		var code, lastErr string
		var st syncState
		var outcome *string
		var empties int16
		if err := rows.Scan(&code, &st.LastAttempt, &st.LastSuccess, &lastErr, &outcome, &empties, &st.Legacy); err != nil {
			return nil, fmt.Errorf("sync states: %w", err)
		}
		if outcome != nil && *outcome != "" {
			st.LastOutcome, st.ConsecutiveEmpty = *outcome, int(empties)
		} else {
			st.LastOutcome, st.ConsecutiveEmpty = deriveOutcome(st.LastAttempt, st.LastSuccess, lastErr)
		}
		out[strings.ToUpper(strings.TrimSpace(code))] = st
	}
	return out, rows.Err()
}

// rankDollarVolumeSQL: the mean close x volume of each code's last 20
// sessions (window of 45 calendar days).
const rankDollarVolumeSQL = `
SELECT stock_code::text, avg(close::float8 * volume::float8)
FROM (
    SELECT stock_code, close, volume,
           row_number() OVER (PARTITION BY stock_code ORDER BY date DESC) AS rn
    FROM stock_prices
    WHERE date >= CURRENT_DATE - 45 AND close IS NOT NULL AND volume IS NOT NULL
) p
WHERE rn <= 20
GROUP BY stock_code`

func (s *pgStore) RankInputs(ctx context.Context) (map[string]rankInput, error) {
	out := map[string]rankInput{}
	var firstErr error
	scan := func(sql string, set func(r *rankInput, v float64)) {
		rows, err := s.pool.Query(ctx, sql)
		if err != nil {
			if !undefinedTable(err) && firstErr == nil {
				firstErr = err
			}
			return
		}
		defer rows.Close()
		for rows.Next() {
			var code string
			var v *float64
			if err := rows.Scan(&code, &v); err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			if v == nil || !storable(*v) {
				continue
			}
			code = strings.ToUpper(strings.TrimSpace(code))
			r := out[code]
			set(&r, *v)
			out[code] = r
		}
		if err := rows.Err(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	scan(`SELECT stock_code::text, market_cap::float8 FROM mv_screener_data`, func(r *rankInput, v float64) { r.MarketCap = v })
	scan(rankDollarVolumeSQL, func(r *rankInput, v float64) { r.DollarVolume20d = v })
	if firstErr != nil {
		return out, fmt.Errorf("rank inputs: %w", firstErr)
	}
	return out, nil
}

func (s *pgStore) RecentFilingHeadlines(ctx context.Context, days int) ([]filingHeadline, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT stock_code::text, announcement_date, headline
		FROM asx_announcements
		WHERE announcement_date >= CURRENT_DATE - $1::int
		  AND `+filingPrefilterSQL, days)
	if err != nil {
		if undefinedTable(err) {
			return nil, nil // no announcements table: no priority, not a failure
		}
		return nil, fmt.Errorf("recent filings: %w", err)
	}
	defer rows.Close()
	var out []filingHeadline
	for rows.Next() {
		var h filingHeadline
		if err := rows.Scan(&h.Code, &h.Date, &h.Headline); err != nil {
			return nil, fmt.Errorf("recent filings: %w", err)
		}
		h.Date = time.Date(h.Date.Year(), h.Date.Month(), h.Date.Day(), 0, 0, 0, 0, time.UTC)
		out = append(out, h)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// The vendor upsert (plan fundamentals-coverage.md §2.2).
//
// One statement per code (the unnest idiom of marketdata/sync's stock_prices
// upsert), built from the column table so a column cannot be forgotten. Per
// field, same currency, the new row carrying a Rejected mask:
//
//  1. the vendor supplies x: take it; field_sources[x] becomes the new row's
//     marker for x (a Markit fill or a derivation), or is deleted;
//  2. x is Rejected: NULL, key deleted (a gate refused it: never keep an
//     earlier run's copy of a value that now fails);
//  3. otherwise keep the stored value on 'ttm' rows (Yahoo keeps TTM revenue
//     only at the latest point or two, so the history is ours to keep) and
//     'quarter' snapshots, or when its effective source (field_sources[x],
//     else the stored row's source) is a filing or Markit and not the new
//     row's own source;
//  4. otherwise, on 'annual' rows, NULL: a vendor value it no longer
//     publishes, or a pre-000132 filing fill stored without a marker;
//  5. a stored FILING row is taken over only when the vendor supplies revenue
//     or net income for the period; otherwise it is left untouched. On a
//     takeover every value kept from the filing row is marked
//     'asx-filing-extraction' (rule 3's effective source does exactly
//     that), and source_document_url/date survive only while a kept value
//     still points at the filing;
//  6. a currency change replaces the row and field_sources wholesale.
//
// Further guards: a Markit row never takes over a stored Yahoo row (the
// fallback never overwrites the primary's history), and a row with no value
// (only a Rejected mask) is written only when a stored row exists for it,
// so a mask never inserts an empty row.
//
// One fiscal year under two dates (52/53-week years: Markit dates LOV's FY26
// 28 June, Yahoo 30 June; sameFYWindow is the week both sides use):
//   - the pruned CTE deletes this code's stored Markit annual row when this
//     statement writes a Yahoo annual row within a week of it that carries
//     revenue or net income. An EPS-only Yahoo row (Markit failed tonight and
//     no TTM point at the year end filled it) prunes nothing: deleting the
//     Markit row would drop the year's only revenue and net income. The next
//     run Markit answers, mergeFallback fills the Yahoo row and the prune
//     then fires;
//   - a Markit annual row is not written when a non-Markit annual row within
//     a week of it that carries revenue or net income is already stored, or
//     is in this statement: the year is held. That is the Yahoo-failure case,
//     where mergeFallback had no primary year to fold Markit's into and every
//     Markit year arrives under its own date. The same carve-out as the
//     prune: beside an EPS-only year the Markit row is written, because it
//     holds the only revenue and net income for the year.
// The same date is the ON CONFLICT rules' business, never these guards'.

// Argument positions of upsertSQL / legacyUpsertSQL.
const (
	argCode = iota + 1
	argFetchedAt
	argPeriodTypes
	argEnds
	argFiscalYears
	argCurrencies
	argSources
	argFieldSources
	argRejected
	argFirstValue
)

var (
	// upsertSQL is the vendor statement over every column (000132 applied).
	upsertSQL = buildUpsertSQL(fundamentalsColumns, true)
	// legacyUpsertSQL is the fallback for a database without 000132.
	legacyUpsertSQL = buildUpsertSQL(legacyColumns(), false)
)

// buildUpsertSQL renders the vendor upsert over cols. extended=false is the
// pre-000132 statement: the 000129 column set, today's conflict policy
// (COALESCE within one currency, the vendor's source wins) plus rule 2, no
// field_sources, no pruning.
func buildUpsertSQL(cols []fundamentalsColumn, extended bool) string {
	var b strings.Builder
	names := make([]string, len(cols))
	for i, c := range cols {
		names[i] = c.name
	}
	p := func(n int) string { return "$" + strconv.Itoa(n) }

	// The input rows.
	b.WriteString("WITH t AS (\n    SELECT u.period_type, u.period_end, u.fiscal_year, u.currency, u.source,\n")
	b.WriteString("           COALESCE(NULLIF(u.field_sources, '')::jsonb, '{}'::jsonb) AS field_sources,\n")
	b.WriteString("           COALESCE(NULLIF(u.rejected, '')::jsonb, '[]'::jsonb) AS rejected")
	for _, n := range names {
		b.WriteString(",\n           u." + n)
	}
	b.WriteString("\n    FROM unnest(\n        ")
	b.WriteString(p(argPeriodTypes) + "::text[], " + p(argEnds) + "::date[], " + p(argFiscalYears) + "::int2[], " +
		p(argCurrencies) + "::text[], " + p(argSources) + "::text[], " + p(argFieldSources) + "::text[], " + p(argRejected) + "::text[]")
	for i := range names {
		b.WriteString(",\n        " + p(argFirstValue+i) + "::float8[]")
	}
	b.WriteString("\n    ) AS u(period_type, period_end, fiscal_year, currency, source, field_sources, rejected")
	for _, n := range names {
		b.WriteString(", " + n)
	}
	b.WriteString(")\n)")

	if extended {
		b.WriteString(`, pruned AS (
    DELETE FROM stock_fundamentals d
    WHERE d.stock_code = $1
      AND d.period_type = '` + periodAnnual + `'
      AND d.source = '` + sourceMarkit + `'
      AND EXISTS (SELECT 1 FROM t
                  WHERE t.period_type = '` + periodAnnual + `' AND t.source = '` + sourceYahoo + `'
                    AND t.period_end <> d.period_end
                    AND abs(t.period_end - d.period_end) <= 7
                    AND (t.revenue IS NOT NULL OR t.net_income IS NOT NULL))
    RETURNING 1
)`)
	}

	// The insert.
	b.WriteString("\nINSERT INTO stock_fundamentals AS f (\n    stock_code, period_type, period_end, fiscal_year, currency")
	for _, n := range names {
		b.WriteString(", " + n)
	}
	if extended {
		b.WriteString(", field_sources")
	}
	b.WriteString(",\n    source, source_fetched_at, updated_at\n)\nSELECT $1, t.period_type, t.period_end, t.fiscal_year, t.currency")
	for _, n := range names {
		b.WriteString(", t." + n)
	}
	if extended {
		b.WriteString(", t.field_sources")
	}
	b.WriteString(",\n       t.source, " + p(argFetchedAt) + "::timestamptz, now()\nFROM t\nWHERE (num_nonnulls(")
	for i, n := range names {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString("t." + n)
	}
	b.WriteString(") > 0\n   OR EXISTS (SELECT 1 FROM stock_fundamentals s\n              WHERE s.stock_code = $1 AND s.period_type = t.period_type AND s.period_end = t.period_end))\n")
	if extended {
		// A Markit year already held under another date within a week.
		heldNear := func(rel string) string {
			return rel + ".period_type = '" + periodAnnual + "' AND " + rel + ".source <> '" + sourceMarkit + "'\n" +
				"                    AND " + rel + ".period_end <> t.period_end AND abs(" + rel + ".period_end - t.period_end) <= 7\n" +
				"                    AND (" + rel + ".revenue IS NOT NULL OR " + rel + ".net_income IS NOT NULL)"
		}
		b.WriteString("  AND NOT (t.source = '" + sourceMarkit + "' AND t.period_type = '" + periodAnnual + "' AND (\n")
		b.WriteString("       EXISTS (SELECT 1 FROM stock_fundamentals s\n                  WHERE s.stock_code = $1 AND " + heldNear("s") + ")\n")
		b.WriteString("    OR EXISTS (SELECT 1 FROM t o\n                  WHERE " + heldNear("o") + ")))\n")
	}
	b.WriteString("ON CONFLICT (stock_code, period_type, period_end) DO UPDATE SET\n")

	rej := "(SELECT t.rejected FROM t WHERE t.period_type = EXCLUDED.period_type AND t.period_end = EXCLUDED.period_end)"
	sameCur := "EXCLUDED.currency = f.currency"

	set := func(col, expr string) { fmt.Fprintf(&b, "    %-19s = %s", col, expr) }
	tail := func(last string) {
		set("fiscal_year", "COALESCE(EXCLUDED.fiscal_year, f.fiscal_year),\n")
		set("currency", "EXCLUDED.currency,\n")
		set("source", "EXCLUDED.source,\n")
		set("source_fetched_at", "EXCLUDED.source_fetched_at,\n")
		set("updated_at", "now()"+last)
	}

	if !extended {
		for _, n := range names {
			set(n, fmt.Sprintf("CASE WHEN %s ? '%s' THEN NULL WHEN %s THEN COALESCE(EXCLUDED.%s, f.%s) ELSE EXCLUDED.%s END,\n",
				rej, n, sameCur, n, n, n))
		}
		tail("")
		return b.String()
	}

	// eff(x): where the stored value of x came from.
	eff := func(n string) string { return "COALESCE(f.field_sources->>'" + n + "', f.source)" }
	// keep(x): rule 3 (and rule 5 through it).
	keep := func(n string) string {
		return "(f." + n + " IS NOT NULL AND (f.period_type IN ('" + periodTTM + "', '" + periodQuarter + "') OR (" +
			eff(n) + " IN ('" + sourceFiling + "', '" + sourceMarkit + "') AND " + eff(n) + " <> EXCLUDED.source)))"
	}
	// marker(x): the field_sources entry a kept value carries.
	marker := func(n string) string {
		return "CASE WHEN " + eff(n) + " = EXCLUDED.source THEN NULL ELSE " + eff(n) + " END"
	}
	// Per value column: a currency change takes the new row whole (rule 6); a
	// Rejected field is NULL (rule 2); where rule 3/5 keeps the stored value
	// the new one still wins when present (rule 1); otherwise the new value,
	// which on an annual row may be NULL (rule 4).
	for _, n := range names {
		set(n, fmt.Sprintf("CASE WHEN NOT (%s) THEN EXCLUDED.%s\n", sameCur, n))
		fmt.Fprintf(&b, "                          WHEN %s ? '%s' THEN NULL\n", rej, n)
		fmt.Fprintf(&b, "                          WHEN %s THEN COALESCE(EXCLUDED.%s, f.%s)\n", keep(n), n, n)
		fmt.Fprintf(&b, "                          ELSE EXCLUDED.%s END,\n", n)
	}
	set("field_sources", fmt.Sprintf("CASE WHEN NOT (%s) THEN EXCLUDED.field_sources ELSE jsonb_strip_nulls(jsonb_build_object(\n", sameCur))
	for i, n := range names {
		sep := ","
		if i == len(names)-1 {
			sep = ""
		}
		fmt.Fprintf(&b, "        '%s', CASE WHEN %s ? '%s' THEN NULL WHEN EXCLUDED.%s IS NOT NULL THEN EXCLUDED.field_sources->>'%s' WHEN %s THEN %s ELSE NULL END%s\n",
			n, rej, n, n, n, keep(n), marker(n), sep)
	}
	b.WriteString("    )) END,\n")
	// The filing document survives only while a kept value still points at
	// the filing.
	var keptFiling []string
	for _, n := range names {
		keptFiling = append(keptFiling, fmt.Sprintf("(EXCLUDED.%s IS NULL AND NOT (%s ? '%s') AND %s AND %s = '%s')",
			n, rej, n, keep(n), eff(n), sourceFiling))
	}
	anyKeptFiling := "(" + sameCur + " AND (" + strings.Join(keptFiling, "\n         OR ") + "))"
	set("source_document_url", fmt.Sprintf("CASE WHEN %s THEN f.source_document_url ELSE NULL END,\n", anyKeptFiling))
	set("source_document_date", fmt.Sprintf("CASE WHEN %s THEN f.source_document_date ELSE NULL END,\n", anyKeptFiling))
	tail("\n")
	b.WriteString("WHERE (f.source <> '" + sourceFiling + "' OR EXCLUDED.revenue IS NOT NULL OR EXCLUDED.net_income IS NOT NULL)\n")
	b.WriteString("  AND NOT (f.source = '" + sourceYahoo + "' AND EXCLUDED.source = '" + sourceMarkit + "')")
	return b.String()
}

// upsertArgs builds the statement's arguments for cols (fundamentalsColumns
// for upsertSQL, legacyColumns() for legacyUpsertSQL); split out so
// tests can check the arrays line up with the placeholders without a
// database.
func upsertArgs(code string, rows []PeriodRow, fetchedAt time.Time, cols []fundamentalsColumn) []any {
	n := len(rows)
	periodTypes, ends, currencies, sources := make([]string, n), make([]string, n), make([]string, n), make([]string, n)
	fieldSources, rejected := make([]string, n), make([]string, n)
	fiscalYears := make([]*int16, n)
	values := make([][]*float64, len(cols))
	for j := range cols {
		values[j] = make([]*float64, n)
	}
	for i, r := range rows {
		periodTypes[i] = r.PeriodType
		ends[i] = r.PeriodEnd.Format("2006-01-02")
		fiscalYears[i] = r.FiscalYear
		currencies[i] = r.Currency
		sources[i] = r.Source
		fieldSources[i] = jsonText(r.FieldSources)
		rejected[i] = jsonText(r.Rejected)
		for j, c := range cols {
			values[j][i] = c.get(&rows[i])
		}
	}
	args := []any{code, fetchedAt.UTC(), periodTypes, ends, fiscalYears, currencies, sources, fieldSources, rejected}
	for j := range cols {
		args = append(args, values[j])
	}
	return args
}

// jsonText renders a FieldSources map or a Rejected list for the statement
// ("" for empty, which the SQL reads as {} / []).
func jsonText(v any) string {
	switch x := v.(type) {
	case map[string]string:
		if len(x) == 0 {
			return ""
		}
	case []string:
		if len(x) == 0 {
			return ""
		}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

func (s *pgStore) UpsertPeriods(ctx context.Context, code string, rows []PeriodRow, fetchedAt time.Time) error {
	if len(rows) == 0 {
		return nil
	}
	fund, _, err := s.schema(ctx)
	if err != nil {
		return err
	}
	if fund {
		_, err := s.pool.Exec(ctx, upsertSQL, upsertArgs(code, rows, fetchedAt, fundamentalsColumns)...)
		if err == nil {
			return nil
		}
		if !undefinedColumn(err) {
			return fmt.Errorf("upsert %s: %w", code, err)
		}
		s.downgrade(true)
	}
	legacy := make([]PeriodRow, 0, len(rows))
	for _, r := range rows {
		if r.PeriodType != periodQuarter { // snapshots carry only 000132 columns
			legacy = append(legacy, r)
		}
	}
	if len(legacy) == 0 {
		return nil
	}
	if _, err := s.pool.Exec(ctx, legacyUpsertSQL, upsertArgs(code, legacy, fetchedAt, legacyColumns())...); err != nil {
		return fmt.Errorf("upsert %s: %w", code, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// The attempt log (§2.3).

// recordAttemptSQL: last_success_at and periods_loaded move only on a
// success, so a failed retry never hides when the code last loaded.
// consecutive_empty counts empty answers in a row and resets on anything
// else; median_k, fx_converted and native_currency move only when the
// attempt measured them ($7).
const recordAttemptSQL = `
INSERT INTO stock_fundamentals_sync AS s (
    stock_code, last_attempt_at, last_success_at, last_error, periods_loaded,
    last_outcome, consecutive_empty, median_k, fx_converted, native_currency)
VALUES ($1, $2::timestamptz, CASE WHEN $3::bool THEN $2::timestamptz END, NULLIF($4::text, ''), $5::int,
        $6::text, CASE WHEN $6::text = '` + outcomeEmpty + `' THEN 1 ELSE 0 END, CASE WHEN $7::bool THEN $8::float8 END,
        CASE WHEN $7::bool THEN $9::bool END, CASE WHEN $7::bool THEN NULLIF($10::text, '') END)
ON CONFLICT (stock_code) DO UPDATE SET
    last_attempt_at   = EXCLUDED.last_attempt_at,
    last_success_at   = CASE WHEN $3::bool THEN EXCLUDED.last_attempt_at ELSE s.last_success_at END,
    last_error        = EXCLUDED.last_error,
    periods_loaded    = CASE WHEN $3::bool THEN EXCLUDED.periods_loaded ELSE s.periods_loaded END,
    last_outcome      = EXCLUDED.last_outcome,
    consecutive_empty = CASE WHEN $6::text = '` + outcomeEmpty + `' THEN LEAST(s.consecutive_empty + 1, 32767) ELSE 0 END,
    median_k          = CASE WHEN $7::bool THEN $8::float8 ELSE s.median_k END,
    fx_converted      = CASE WHEN $7::bool THEN $9::bool ELSE s.fx_converted END,
    native_currency   = CASE WHEN $7::bool THEN NULLIF($10::text, '') ELSE s.native_currency END`

// recordAttemptLegacySQL is the 000129 statement (no last_outcome,
// consecutive_empty or median_k).
const recordAttemptLegacySQL = `
INSERT INTO stock_fundamentals_sync AS s (stock_code, last_attempt_at, last_success_at, last_error, periods_loaded)
VALUES ($1, $2::timestamptz, CASE WHEN $3::bool THEN $2::timestamptz END, NULLIF($4::text, ''), $5::int)
ON CONFLICT (stock_code) DO UPDATE SET
    last_attempt_at = EXCLUDED.last_attempt_at,
    last_success_at = CASE WHEN $3::bool THEN EXCLUDED.last_attempt_at ELSE s.last_success_at END,
    last_error      = EXCLUDED.last_error,
    periods_loaded  = CASE WHEN $3::bool THEN EXCLUDED.periods_loaded ELSE s.periods_loaded END`

// recordAttemptArgs builds recordAttemptSQL's arguments. A median_k that
// could not be stored (non-finite, implausible) is written as NULL.
func recordAttemptArgs(a attempt) []any {
	errText := a.Err
	if len(errText) > 1000 {
		errText = errText[:1000]
	}
	var k *float64
	if a.Measured && a.MedianK != nil && storable(*a.MedianK) {
		k = a.MedianK
	}
	outcome := a.Outcome
	if outcome == "" {
		outcome = outcomeFailed
		if a.Success {
			outcome = outcomeLoaded
		}
	}
	native := strings.ToUpper(strings.TrimSpace(a.NativeCurrency))
	if len(native) > 8 || !a.FXConverted {
		native = ""
	}
	return []any{a.Code, a.At.UTC(), a.Success, errText, a.PeriodsLoaded, outcome, a.Measured, k, a.FXConverted, native}
}

func (s *pgStore) RecordAttempt(ctx context.Context, a attempt) error {
	_, syncExt, err := s.schema(ctx)
	if err != nil {
		return err
	}
	args := recordAttemptArgs(a)
	if syncExt {
		_, err := s.pool.Exec(ctx, recordAttemptSQL, args...)
		if err == nil {
			return nil
		}
		if !undefinedColumn(err) {
			return fmt.Errorf("record attempt %s: %w", a.Code, err)
		}
		s.downgrade(false)
	}
	if _, err := s.pool.Exec(ctx, recordAttemptLegacySQL, args[:5]...); err != nil {
		return fmt.Errorf("record attempt %s: %w", a.Code, err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// The run lease (§2.4, §3.8): one fundamentals/filings writer at a time.

// leaseName is the one lease row the job uses.
const leaseName = "picks"

// claimLeaseSQL takes the lease when it is free, expired, or already held by
// this holder (a Cloud Run task RETRY runs in the same execution as the
// attempt that died holding it).
const claimLeaseSQL = `
INSERT INTO picks_run_lease AS l (name, holder, expires_at)
VALUES ('` + leaseName + `', $1, now() + interval '4 hours')
ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
WHERE l.expires_at < now() OR l.holder = EXCLUDED.holder
RETURNING holder`

const (
	leaseHolderSQL  = `SELECT holder || ' (until ' || to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC)' FROM picks_run_lease WHERE name = '` + leaseName + `'`
	extendLeaseSQL  = `UPDATE picks_run_lease SET expires_at = now() + interval '4 hours' WHERE name = '` + leaseName + `' AND holder = $1`
	releaseLeaseSQL = `DELETE FROM picks_run_lease WHERE name = '` + leaseName + `' AND holder = $1`
)

func (s *pgStore) ClaimLease(ctx context.Context, holder string) (bool, string, error) {
	var got string
	err := s.pool.QueryRow(ctx, claimLeaseSQL, holder).Scan(&got)
	switch {
	case err == nil:
		return true, got, nil
	case undefinedTable(err):
		return false, "", errLeaseAbsent
	case !errors.Is(err, pgx.ErrNoRows):
		return false, "", fmt.Errorf("claim lease: %w", err)
	}
	var current string
	if err := s.pool.QueryRow(ctx, leaseHolderSQL).Scan(&current); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, "", fmt.Errorf("read lease holder: %w", err)
	}
	return false, current, nil
}

func (s *pgStore) ExtendLease(ctx context.Context, holder string) error {
	if _, err := s.pool.Exec(ctx, extendLeaseSQL, holder); err != nil && !undefinedTable(err) {
		return fmt.Errorf("extend lease: %w", err)
	}
	return nil
}

func (s *pgStore) ReleaseLease(ctx context.Context, holder string) error {
	if _, err := s.pool.Exec(ctx, releaseLeaseSQL, holder); err != nil && !undefinedTable(err) {
		return fmt.Errorf("release lease: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// The view refresh.

// refreshSQL is ONE simple-protocol command on purpose (the reason
// shortdatasync's refreshAllSQL is one string): the timeout must be disarmed
// on the same backend that runs the refresh, and through a transaction pooler
// two separate Execs can land on two backends. Unlike that call it is SET LOCAL
// inside an explicit transaction, so the disarmed timeout dies with the
// transaction instead of staying on a pooled backend for the next client
// (scripts/prod-psql.sh, "WHY TRANSACTION-SCOPED"). The function's own
// `SET statement_timeout TO '0'` cannot disarm the timer the calling command
// armed (000095's measurement), hence the SET before the call.
//
// platform.Connect sets QueryExecModeSimpleProtocol, which is what makes a
// multi-statement Exec legal; do not split this into several calls.
//
// client_min_messages is pinned to notice for the same transaction: the
// function's `Refreshing <view>` NOTICEs are how RefreshStrategyViews knows a
// view was refreshed at all, so a role or database default of warning must
// not be able to hide them (that would fail every refresh, loudly, but for
// nothing).
const refreshSQL = `BEGIN; SET LOCAL statement_timeout = 0; SET LOCAL client_min_messages = notice; SELECT refresh_strategy_views(); COMMIT`

// pickerViews are the materialized views refresh_strategy_views() exists to
// refresh (000130, plus mv_fundamentals_quality from 000132), in its order.
// A view in this list that exists in the catalog but that the call never
// announced with a `Refreshing <view>` NOTICE was not refreshed, with no
// WARNING to say so: the deploy replays 000130 (whose body has three views)
// before 000132 restores the four-view body in a separate psql call, so a
// failure between the two leaves the three-view body live and
// mv_fundamentals_quality silently stale. Such a view counts as skipped.
var pickerViews = []string{"mv_market_regime", "mv_fundamentals_growth", "mv_fundamentals_quality", "mv_price_features"}

// existingViewsSQL returns the names in $1 that resolve to a relation through
// the search_path, exactly as the function's unqualified REFRESH resolves
// them.
const existingViewsSQL = `SELECT v FROM unnest($1::text[]) AS v WHERE to_regclass(v) IS NOT NULL`

func (s *pgStore) RefreshStrategyViews(ctx context.Context) ([]string, error) {
	s.notices.reset()
	_, err := s.pool.Exec(ctx, refreshSQL)
	skipped := s.notices.skipped()
	if err != nil {
		return skipped, fmt.Errorf("refresh_strategy_views: %w", err)
	}
	existing, err := s.existingViews(ctx, pickerViews)
	if err != nil {
		return skipped, fmt.Errorf("refresh_strategy_views: which picker views exist: %w", err)
	}
	return append(skipped, unrefreshedViews(existing, s.notices.refreshed(), skipped)...), nil
}

func (s *pgStore) existingViews(ctx context.Context, names []string) ([]string, error) {
	rows, err := s.pool.Query(ctx, existingViewsSQL, names)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// unrefreshedViews: every existing picker view the call neither announced
// (refreshed) nor already reported as skipped, named with the reason.
func unrefreshedViews(existing, refreshed, skipped []string) []string {
	seen := map[string]bool{}
	for _, v := range refreshed {
		seen[v] = true
	}
	for _, v := range skipped {
		seen[v] = true
	}
	var out []string
	for _, v := range existing {
		if !seen[v] {
			out = append(out, v+" (never refreshed: refresh_strategy_views() does not name it; re-apply 000132)")
		}
	}
	return out
}

// noticeLog captures server NOTICE/WARNING messages. refresh_strategy_views()
// reports a view it could not refresh as `WARNING: Skipping <view>: <reason>`
// and still returns normally, so without reading notices a refresh that
// refreshed nothing looks like success: the silent-staleness failure 000095
// was written about.
type noticeLog struct {
	mu   sync.Mutex
	msgs []*pgconn.Notice
	logf func(format string, args ...any)
}

func (n *noticeLog) handle(_ *pgconn.PgConn, notice *pgconn.Notice) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.msgs = append(n.msgs, notice)
	if n.logf != nil {
		n.logf("picks: postgres %s: %s", notice.Severity, notice.Message)
	}
}

func (n *noticeLog) reset() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.msgs = nil
}

// skipped returns the views named by `Skipping <view>: ...` warnings.
func (n *noticeLog) skipped() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []string
	for _, m := range n.msgs {
		if v, ok := skippedView(m); ok {
			out = append(out, v)
		}
	}
	return out
}

// refreshed returns the views named by `Refreshing <view> ...` NOTICEs: the
// ones the call reached (a skip is reported separately, by skipped).
func (n *noticeLog) refreshed() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	var out []string
	for _, m := range n.msgs {
		if m == nil || !strings.EqualFold(m.Severity, "NOTICE") || !strings.HasPrefix(m.Message, "Refreshing ") {
			continue
		}
		if f := strings.Fields(strings.TrimPrefix(m.Message, "Refreshing ")); len(f) > 0 {
			out = append(out, f[0])
		}
	}
	return out
}

// skippedView parses the guard's skip warning. Only WARNING severity counts:
// the "Failed to refresh X concurrently ... Trying non-concurrent" warning is
// NOT a skip, because the fallback still refreshed the view.
func skippedView(m *pgconn.Notice) (string, bool) {
	if m == nil || !strings.EqualFold(m.Severity, "WARNING") || !strings.HasPrefix(m.Message, "Skipping ") {
		return "", false
	}
	rest := strings.TrimPrefix(m.Message, "Skipping ")
	if i := strings.Index(rest, ":"); i > 0 {
		return rest[:i], true
	}
	return rest, true
}
