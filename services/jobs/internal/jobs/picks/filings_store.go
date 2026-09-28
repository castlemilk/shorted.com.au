package picks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// The -mode filings half of the store: every statement only the filings path
// runs. The vendor path (upsertSQL, LastAttempts, RecordAttempt, the universe
// and the refresh) stays in store.go. Split so the filing rebuild can change
// here without touching the vendor writer (plan fundamentals-coverage.md §4.3).
//
// SCHEMA TOLERANCE. Migration 000132 adds stock_fundamentals.field_sources,
// source_document_url, source_document_date and
// financial_report_extractions.document_meta. Prod applies it before the jobs
// image swaps, but a database without it (a laptop, a scratch Postgres, a
// deploy whose migration step failed) must still run: every read falls back to
// a query without the new columns on SQLSTATE 42703, and the rebuild probes
// the catalog and takes the legacy write path (no markers, no per-field purge,
// no document columns). Each fallback is logged once per process.

// filingStore is the part of store the filings ingest reads and writes.
// store embeds it, so the method set of store is unchanged.
type filingStore interface {
	// FilingExtractions: every financial_report_extractions row whose metrics
	// carry a revenue / profit / EPS class, with digest_confidence and
	// document_meta (-mode filings). A database without the table reads as
	// no rows.
	FilingExtractions(ctx context.Context) ([]filingExtraction, error)
	// VendorRows: every non-filing annual and ttm stock_fundamentals row, by
	// code, with field_sources (the gates' vendor context).
	VendorRows(ctx context.Context) (map[string][]vendorRow, error)
	// CompanyProfiles: "company-metadata" name and industry by code (gate 1's
	// entity match, gate 8's property/investment exemption). A database
	// without the table reads as no profiles.
	CompanyProfiles(ctx context.Context) (map[string]companyProfile, error)
	// StoredFilingState: every stored row carrying filing data (the dry-run
	// and refusal would-purge list).
	StoredFilingState(ctx context.Context) ([]storedFiling, error)
	// RebuildFilings applies one rebuild in ONE transaction (plan §4.3).
	RebuildFilings(ctx context.Context, rb filingRebuild) (filingRebuildResult, error)
}

// filingUndefinedColumn is SQLSTATE 42703: a column that does not exist yet
// (migration 000132 absent).
func filingUndefinedColumn(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42703"
}

var filingSchemaNotices sync.Map

// filingSchemaNoticeOnce logs a schema fallback once per process.
func filingSchemaNoticeOnce(what string) {
	if _, loaded := filingSchemaNotices.LoadOrStore(what, true); !loaded {
		log.Printf("picks: filings: %s (migration 000132 not applied); using the pre-000132 path", what)
	}
}

// queryEach runs sql and calls scan for every row. Errors from the query and
// from the row stream come back alike (pgx may report a planning error either
// way), so a caller can classify one error and retry another variant.
func queryEach(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, sql string, args []any, scan func(pgx.Rows) error) error {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// queryVariants runs the first variant that does not fail with 42703: the
// same query with fewer (newer) columns each time. what names the fallback in
// the once-per-process log. reset is called before every attempt.
func queryVariants(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, what string, variants []string, args []any, reset func(), scan func(pgx.Rows) error) error {
	var err error
	for i, sql := range variants {
		reset()
		err = queryEach(ctx, q, sql, args, scan)
		if err == nil || !filingUndefinedColumn(err) || i == len(variants)-1 {
			return err
		}
		filingSchemaNoticeOnce(what)
	}
	return err
}

// filingExtractionsSQL reads the extractions -mode filings parses. The JSONB
// key prefilter (?| over the metric class names, filingKeys) keeps the ~98%
// of rows with no usable metric out of the wire entirely. %s is the
// digest_confidence / document_meta column list.
const filingExtractionsSQL = `
SELECT stock_code::text, report_url, COALESCE(report_type, ''), COALESCE(report_title, ''),
       report_date, metrics::text, %s
FROM financial_report_extractions
WHERE jsonb_typeof(metrics) = 'object'
  AND metrics ?| $1::text[]
ORDER BY stock_code, report_date NULLS LAST, report_url`

var filingExtractionsVariants = []string{
	fmt.Sprintf(filingExtractionsSQL, "digest_confidence, document_meta::text"),
	fmt.Sprintf(filingExtractionsSQL, "digest_confidence, NULL::text"),
	fmt.Sprintf(filingExtractionsSQL, "NULL::float8, NULL::text"),
}

func (s *pgStore) FilingExtractions(ctx context.Context) ([]filingExtraction, error) {
	var out []filingExtraction
	err := queryVariants(ctx, s.pool, "financial_report_extractions.document_meta is absent",
		filingExtractionsVariants, []any{filingKeys()},
		func() { out = nil },
		func(rows pgx.Rows) error {
			var e filingExtraction
			var reportDate *time.Time
			var meta *string
			if err := rows.Scan(&e.Code, &e.URL, &e.Type, &e.Title, &reportDate, &e.Metrics, &e.DigestConfidence, &meta); err != nil {
				return err
			}
			if reportDate != nil {
				e.ReportDate = dateOnly(*reportDate)
			}
			if meta != nil {
				e.DocumentMeta = *meta
			}
			out = append(out, e)
			return nil
		})
	if err != nil {
		if undefinedTable(err) {
			return nil, nil // no extractor table in this database: nothing to ingest
		}
		return nil, fmt.Errorf("filing extractions: %w", err)
	}
	return out, nil
}

// vendorRowsSQL: the vendor rows the filing gates consult. Annual and ttm only
// (quarter rows are balance snapshots with no flow line); a filing row is never
// its own reference. %s is the field_sources column.
const vendorRowsSQL = `
SELECT stock_code::text, period_type::text, period_end, currency::text, source::text,
       revenue, net_income, eps_basic, eps_diluted, shares_outstanding, %s
FROM stock_fundamentals
WHERE period_type IN ('annual', 'ttm') AND source <> '` + sourceFiling + `'`

var vendorRowsVariants = []string{
	fmt.Sprintf(vendorRowsSQL, "field_sources::text"),
	fmt.Sprintf(vendorRowsSQL, "NULL::text"),
}

func (s *pgStore) VendorRows(ctx context.Context) (map[string][]vendorRow, error) {
	var out map[string][]vendorRow
	err := queryVariants(ctx, s.pool, "stock_fundamentals.field_sources is absent",
		vendorRowsVariants, nil,
		func() { out = map[string][]vendorRow{} },
		func(rows pgx.Rows) error {
			var code string
			var v vendorRow
			var fs *string
			if err := rows.Scan(&code, &v.PeriodType, &v.PeriodEnd, &v.Currency, &v.Source,
				&v.Revenue, &v.NetIncome, &v.EPSBasic, &v.EPSDiluted, &v.Shares, &fs); err != nil {
				return err
			}
			v.PeriodEnd = dateOnly(v.PeriodEnd)
			if fs != nil && *fs != "" && *fs != "{}" {
				m := map[string]string{}
				if err := json.Unmarshal([]byte(*fs), &m); err == nil {
					v.FieldSources = m
				}
			}
			code = strings.ToUpper(strings.TrimSpace(code))
			out[code] = append(out[code], v)
			return nil
		})
	if err != nil {
		return nil, fmt.Errorf("vendor rows: %w", err)
	}
	return out, nil
}

var companyProfilesVariants = []string{
	`SELECT stock_code::text, COALESCE(company_name::text, ''), COALESCE(industry::text, '') FROM "company-metadata"`,
	`SELECT stock_code::text, COALESCE(company_name::text, ''), '' FROM "company-metadata"`,
}

func (s *pgStore) CompanyProfiles(ctx context.Context) (map[string]companyProfile, error) {
	var out map[string]companyProfile
	err := queryVariants(ctx, s.pool, `"company-metadata".industry is absent`,
		companyProfilesVariants, nil,
		func() { out = map[string]companyProfile{} },
		func(rows pgx.Rows) error {
			var code string
			var p companyProfile
			if err := rows.Scan(&code, &p.Name, &p.Industry); err != nil {
				return err
			}
			out[strings.ToUpper(strings.TrimSpace(code))] = p
			return nil
		})
	if err != nil {
		if undefinedTable(err) {
			return map[string]companyProfile{}, nil
		}
		return nil, fmt.Errorf("company profiles: %w", err)
	}
	return out, nil
}

var storedFilingVariants = []string{`
SELECT stock_code::text, period_type::text, period_end, source::text,
       COALESCE((SELECT string_agg(e.key, ',' ORDER BY e.key)
                 FROM jsonb_each_text(f.field_sources) e
                 WHERE e.value = '` + sourceFiling + `'), '')
FROM stock_fundamentals f
WHERE f.source = '` + sourceFiling + `'
   OR EXISTS (SELECT 1 FROM jsonb_each_text(f.field_sources) e WHERE e.value = '` + sourceFiling + `')`, `
SELECT stock_code::text, period_type::text, period_end, source::text, ''
FROM stock_fundamentals
WHERE source = '` + sourceFiling + `'`,
}

func (s *pgStore) StoredFilingState(ctx context.Context) ([]storedFiling, error) {
	var out []storedFiling
	err := queryVariants(ctx, s.pool, "stock_fundamentals.field_sources is absent",
		storedFilingVariants, nil,
		func() { out = nil },
		func(rows pgx.Rows) error {
			var sf storedFiling
			var cols string
			if err := rows.Scan(&sf.Key.Code, &sf.Key.Type, &sf.Key.End, &sf.Source, &cols); err != nil {
				return err
			}
			sf.Key.Code = strings.ToUpper(strings.TrimSpace(sf.Key.Code))
			sf.Key.End = dateOnly(sf.Key.End)
			if cols != "" {
				sf.FilingCols = strings.Split(cols, ",")
			}
			out = append(out, sf)
			return nil
		})
	if err != nil {
		return nil, fmt.Errorf("stored filing state: %w", err)
	}
	return out, nil
}

// ------------------------------------------------------------------ rebuild

// filingSchema132SQL counts the 000132 columns the rebuild writes.
const filingSchema132SQL = `
SELECT count(*)
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'stock_fundamentals'
  AND column_name IN ('field_sources', 'source_document_url', 'source_document_date')`

// filingPurgeSQL deletes every FILING row whose key this run does not produce
// (plan §4.3). The predicate is evaluated at write time, inside the rebuild
// transaction. It never touches a vendor row.
const filingPurgeSQL = `
DELETE FROM stock_fundamentals d
WHERE d.source = '` + sourceFiling + `'
  AND NOT EXISTS (
      SELECT 1 FROM unnest($1::text[], $2::text[], $3::date[]) AS k(stock_code, period_type, period_end)
      WHERE k.stock_code = d.stock_code AND k.period_type = d.period_type AND k.period_end = d.period_end)
RETURNING d.stock_code::text, d.period_type::text, d.period_end`

// filingNullFieldSQL nulls column col on every VENDOR row where field_sources
// marks it filing-filled and this run does not reproduce it for that key, and
// drops the marker (plan §4.3: "per field UPDATE ... SET col=NULL,
// field_sources=field_sources-'col' WHERE field_sources->>'col' =
// 'asx-filing-extraction' AND key NOT IN (keys reproducing col)"). col is
// always one of filingWriteColumns, never caller input.
func filingNullFieldSQL(col string) string {
	return `
UPDATE stock_fundamentals f
SET ` + col + ` = NULL, field_sources = f.field_sources - '` + col + `', updated_at = now()
WHERE f.source <> '` + sourceFiling + `'
  AND f.field_sources->>'` + col + `' = '` + sourceFiling + `'
  AND NOT EXISTS (
      SELECT 1 FROM unnest($1::text[], $2::text[], $3::date[]) AS k(stock_code, period_type, period_end)
      WHERE k.stock_code = f.stock_code AND k.period_type = f.period_type AND k.period_end = f.period_end)
RETURNING f.stock_code::text, f.period_type::text, f.period_end`
}

// filingClearDocumentsSQL: a vendor row left with no filing-filled field no
// longer names a filing ("and the document columns with them").
const filingClearDocumentsSQL = `
UPDATE stock_fundamentals f
SET source_document_url = NULL, source_document_date = NULL, updated_at = now()
WHERE f.source <> '` + sourceFiling + `'
  AND (f.source_document_url IS NOT NULL OR f.source_document_date IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(f.field_sources) e WHERE e.value = '` + sourceFiling + `')`

// filingUpsertSQL is the filing upsert of plan §2.2, in SQL so no caller can
// get it wrong:
//
//   - No stored row (every 'half' period; an annual the vendor has not
//     published yet): inserted whole, source asx-filing-extraction, no
//     field_sources exceptions, the document named.
//   - The stored row is a FILING row: replaced (this run's merged row is the
//     complete picture; a NULL means no document supports the value any
//     more), except a column field_sources marks as coming from somewhere
//     else (a vendor value on a filing row), which is kept while the
//     currency is unchanged.
//   - The stored row is a VENDOR row (any other source): its currency,
//     source, fiscal year and fetch time stay the vendor's, and per column,
//     only when the currencies agree, the filing's value
//   - FILLS a column the vendor left NULL, or
//   - REPLACES a column already marked asx-filing-extraction (a previous
//     run's fill, or a filing value the vendor kept when it took the row
//     over, plan §2.2 rule 5),
//     recording field_sources[col] = 'asx-filing-extraction' and the
//     document. A vendor's own value is never touched.
//
// The purge statements run first in the same transaction, so a marked column
// this run does not reproduce is already NULL (and unmarked) here. The WHERE
// skips no-op updates, so updated_at moves only when something did.
var filingUpsertSQL = buildFilingUpsertSQL()

func buildFilingUpsertSQL() string {
	const filing = "'" + sourceFiling + "'"
	isFiling := "f.source = " + filing
	sameCur := "f.currency = EXCLUDED.currency"
	marked := func(c string) string { return "f.field_sources->>'" + c + "' = " + filing }
	vendorOrigin := func(c string) string {
		return "(" + sameCur + " AND f.field_sources ? '" + c + "' AND f.field_sources->>'" + c + "' <> " + filing + ")"
	}
	take := func(c string) string {
		return "(" + sameCur + " AND EXCLUDED." + c + " IS NOT NULL AND (f." + c + " IS NULL OR " + marked(c) + "))"
	}
	newVal := func(c string) string {
		return "CASE WHEN " + isFiling + " THEN (CASE WHEN " + vendorOrigin(c) + " THEN f." + c + " ELSE EXCLUDED." + c + " END)" +
			" WHEN " + take(c) + " THEN EXCLUDED." + c + " ELSE f." + c + " END"
	}
	var takes, pairs []string
	for _, c := range filingWriteColumns {
		takes = append(takes, take(c))
		pairs = append(pairs, "'"+c+"', CASE WHEN "+take(c)+" THEN "+filing+" END")
	}
	anyTake := "(" + strings.Join(takes, " OR ") + ")"
	newFS := "CASE WHEN " + isFiling + " THEN (CASE WHEN " + sameCur +
		" THEN COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(f.field_sources) e WHERE e.value <> to_jsonb(" + filing + "::text)), '{}'::jsonb)" +
		" ELSE '{}'::jsonb END)" +
		" ELSE f.field_sources || jsonb_strip_nulls(jsonb_build_object(" + strings.Join(pairs, ", ") + ")) END"
	newURL := "CASE WHEN " + isFiling + " OR " + anyTake + " THEN EXCLUDED.source_document_url ELSE f.source_document_url END"
	newDate := "CASE WHEN " + isFiling + " OR " + anyTake + " THEN EXCLUDED.source_document_date ELSE f.source_document_date END"
	newFY := "CASE WHEN " + isFiling + " THEN EXCLUDED.fiscal_year ELSE COALESCE(f.fiscal_year, EXCLUDED.fiscal_year) END"
	newCur := "CASE WHEN " + isFiling + " THEN EXCLUDED.currency ELSE f.currency END"
	newFetched := "CASE WHEN " + isFiling + " THEN EXCLUDED.source_fetched_at ELSE f.source_fetched_at END"

	var set, newTuple, oldTuple []string
	for _, c := range filingWriteColumns {
		set = append(set, "    "+c+" = "+newVal(c))
		newTuple = append(newTuple, newVal(c))
		oldTuple = append(oldTuple, "f."+c)
	}
	set = append(set,
		"    field_sources = "+newFS,
		"    source_document_url = "+newURL,
		"    source_document_date = "+newDate,
		"    fiscal_year = "+newFY,
		"    currency = "+newCur,
		"    source_fetched_at = "+newFetched,
		"    updated_at = now()",
	)
	newTuple = append(newTuple, newFS, newURL, newDate, newFY, newCur)
	oldTuple = append(oldTuple, "f.field_sources", "f.source_document_url", "f.source_document_date", "f.fiscal_year", "f.currency")

	return `
WITH t AS (
    SELECT *
    FROM unnest(
        $1::text[], $2::text[], $3::date[], $4::int2[], $5::text[],
        $6::float8[], $7::float8[], $8::float8[], $9::float8[],
        $10::text[], $11::date[]
    ) AS t(stock_code, period_type, period_end, fiscal_year, currency,
           revenue, net_income, eps_basic, eps_diluted,
           source_document_url, source_document_date)
)
INSERT INTO stock_fundamentals AS f (
    stock_code, period_type, period_end, fiscal_year, currency,
    revenue, net_income, eps_basic, eps_diluted,
    source, source_fetched_at, field_sources, source_document_url, source_document_date, updated_at
)
SELECT t.stock_code, t.period_type, t.period_end, t.fiscal_year, t.currency,
       t.revenue, t.net_income, t.eps_basic, t.eps_diluted,
       ` + filing + `, $12::timestamptz, '{}'::jsonb, t.source_document_url, t.source_document_date, now()
FROM t
ON CONFLICT (stock_code, period_type, period_end) DO UPDATE SET
` + strings.Join(set, ",\n") + `
WHERE (` + strings.Join(newTuple, ",\n       ") + `)
      IS DISTINCT FROM (` + strings.Join(oldTuple, ", ") + `)
RETURNING f.stock_code::text`
}

// filingUpsertArgs builds filingUpsertSQL's arguments for every code at once.
func filingUpsertArgs(rows map[string][]PeriodRow, fetchedAt time.Time) []any {
	var codes, types, ends, currencies []string
	var fiscalYears []*int16
	var revenue, netIncome, epsBasic, epsDiluted []*float64
	var docURLs, docDates []*string
	for _, code := range sortedCodes(rows) {
		for _, r := range rows[code] {
			codes = append(codes, code)
			types = append(types, r.PeriodType)
			ends = append(ends, r.PeriodEnd.Format("2006-01-02"))
			fiscalYears = append(fiscalYears, r.FiscalYear)
			currencies = append(currencies, r.Currency)
			revenue = append(revenue, r.Revenue)
			netIncome = append(netIncome, r.NetIncome)
			epsBasic = append(epsBasic, r.EPSBasic)
			epsDiluted = append(epsDiluted, r.EPSDiluted)
			var url, d *string
			if r.SourceDocumentURL != "" {
				u := r.SourceDocumentURL
				url = &u
			}
			if r.SourceDocumentDate != nil {
				s := r.SourceDocumentDate.Format("2006-01-02")
				d = &s
			}
			docURLs = append(docURLs, url)
			docDates = append(docDates, d)
		}
	}
	return []any{codes, types, ends, fiscalYears, currencies, revenue, netIncome, epsBasic, epsDiluted, docURLs, docDates, fetchedAt.UTC()}
}

// filingUpsertLegacySQL is the pre-000132 write path, kept for a database
// without the new columns: per code, a vendor row's NULL columns are filled
// (same currency, no marker: there is no column to hold one), a filing row is
// replaced whole, and the code's filing rows it no longer produces are pruned
// (a no-op after the global purge the rebuild runs first).
const filingUpsertLegacySQL = `
WITH t AS (
    SELECT *
    FROM unnest(
        $3::text[], $4::date[], $5::int2[], $6::text[],
        $7::float8[], $8::float8[], $9::float8[], $10::float8[]
    ) AS t(period_type, period_end, fiscal_year, currency,
           revenue, net_income, eps_basic, eps_diluted)
), pruned AS (
    DELETE FROM stock_fundamentals d
    WHERE d.stock_code = $1
      AND d.source = '` + sourceFiling + `'
      AND NOT EXISTS (SELECT 1 FROM t WHERE t.period_type = d.period_type AND t.period_end = d.period_end)
    RETURNING 1
)
INSERT INTO stock_fundamentals AS f (
    stock_code, period_type, period_end, fiscal_year, currency,
    revenue, net_income, eps_basic, eps_diluted,
    source, source_fetched_at, updated_at
)
SELECT $1, t.period_type, t.period_end, t.fiscal_year, t.currency,
       t.revenue, t.net_income, t.eps_basic, t.eps_diluted,
       '` + sourceFiling + `', $2::timestamptz, now()
FROM t
ON CONFLICT (stock_code, period_type, period_end) DO UPDATE SET
    revenue           = CASE WHEN f.source <> '` + sourceFiling + `'
                             THEN CASE WHEN f.currency = EXCLUDED.currency THEN COALESCE(f.revenue, EXCLUDED.revenue) ELSE f.revenue END
                             ELSE EXCLUDED.revenue END,
    net_income        = CASE WHEN f.source <> '` + sourceFiling + `'
                             THEN CASE WHEN f.currency = EXCLUDED.currency THEN COALESCE(f.net_income, EXCLUDED.net_income) ELSE f.net_income END
                             ELSE EXCLUDED.net_income END,
    eps_basic         = CASE WHEN f.source <> '` + sourceFiling + `'
                             THEN CASE WHEN f.currency = EXCLUDED.currency THEN COALESCE(f.eps_basic, EXCLUDED.eps_basic) ELSE f.eps_basic END
                             ELSE EXCLUDED.eps_basic END,
    eps_diluted       = CASE WHEN f.source <> '` + sourceFiling + `'
                             THEN CASE WHEN f.currency = EXCLUDED.currency THEN COALESCE(f.eps_diluted, EXCLUDED.eps_diluted) ELSE f.eps_diluted END
                             ELSE EXCLUDED.eps_diluted END,
    fiscal_year       = CASE WHEN f.source <> '` + sourceFiling + `' THEN COALESCE(f.fiscal_year, EXCLUDED.fiscal_year) ELSE EXCLUDED.fiscal_year END,
    currency          = CASE WHEN f.source <> '` + sourceFiling + `' THEN f.currency ELSE EXCLUDED.currency END,
    source            = CASE WHEN f.source <> '` + sourceFiling + `' THEN f.source ELSE EXCLUDED.source END,
    source_fetched_at = CASE WHEN f.source <> '` + sourceFiling + `' THEN f.source_fetched_at ELSE EXCLUDED.source_fetched_at END,
    updated_at        = now()
WHERE (f.source = '` + sourceFiling + `'
       AND (f.revenue, f.net_income, f.eps_basic, f.eps_diluted, f.currency, f.fiscal_year)
           IS DISTINCT FROM (EXCLUDED.revenue, EXCLUDED.net_income, EXCLUDED.eps_basic, EXCLUDED.eps_diluted, EXCLUDED.currency, EXCLUDED.fiscal_year))
   OR (f.source <> '` + sourceFiling + `' AND f.currency = EXCLUDED.currency
       AND ((f.revenue     IS NULL AND EXCLUDED.revenue     IS NOT NULL)
         OR (f.net_income  IS NULL AND EXCLUDED.net_income  IS NOT NULL)
         OR (f.eps_basic   IS NULL AND EXCLUDED.eps_basic   IS NOT NULL)
         OR (f.eps_diluted IS NULL AND EXCLUDED.eps_diluted IS NOT NULL)))`

// filingUpsertLegacyArgs builds filingUpsertLegacySQL's arguments for one code.
func filingUpsertLegacyArgs(code string, rows []PeriodRow, fetchedAt time.Time) []any {
	n := len(rows)
	periodTypes, ends, currencies := make([]string, n), make([]string, n), make([]string, n)
	fiscalYears := make([]*int16, n)
	revenue, netIncome, epsBasic, epsDiluted := make([]*float64, n), make([]*float64, n), make([]*float64, n), make([]*float64, n)
	for i, r := range rows {
		periodTypes[i] = r.PeriodType
		ends[i] = r.PeriodEnd.Format("2006-01-02")
		fiscalYears[i] = r.FiscalYear
		currencies[i] = r.Currency
		revenue[i], netIncome[i], epsBasic[i], epsDiluted[i] = r.Revenue, r.NetIncome, r.EPSBasic, r.EPSDiluted
	}
	return []any{code, fetchedAt.UTC(), periodTypes, ends, fiscalYears, currencies, revenue, netIncome, epsBasic, epsDiluted}
}

func scanRowKeys(ctx context.Context, tx pgx.Tx, sql string, args []any) ([]filingRowKey, error) {
	var out []filingRowKey
	err := queryEach(ctx, tx, sql, args, func(rows pgx.Rows) error {
		var k filingRowKey
		if err := rows.Scan(&k.Code, &k.Type, &k.End); err != nil {
			return err
		}
		k.Code = strings.ToUpper(strings.TrimSpace(k.Code))
		k.End = dateOnly(k.End)
		out = append(out, k)
		return nil
	})
	return out, err
}

// RebuildFilings applies one rebuild in ONE transaction (plan §4.3), in this
// order, every predicate evaluated at write time:
//
//  1. delete filing rows whose key the run does not produce (filingPurgeSQL);
//  2. per written column, null the filing-filled vendor values the run does
//     not reproduce, dropping their markers (filingNullFieldSQL);
//  3. clear the document columns of vendor rows left with no filing value;
//  4. the upserts (filingUpsertSQL, plan §2.2).
//
// Any error rolls the whole transaction back: nothing is deleted or written.
// On a database without migration 000132 it runs step 1 and the legacy
// per-code upsert instead (res.Legacy).
func (s *pgStore) RebuildFilings(ctx context.Context, rb filingRebuild) (filingRebuildResult, error) {
	var res filingRebuildResult
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return res, fmt.Errorf("filing rebuild: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // a no-op after Commit

	var n132 int
	if err := tx.QueryRow(ctx, filingSchema132SQL).Scan(&n132); err != nil {
		return res, fmt.Errorf("filing rebuild: schema probe: %w", err)
	}
	res.Legacy = n132 < 3
	if res.Legacy {
		filingSchemaNoticeOnce("stock_fundamentals.field_sources / source_document_* are absent")
	}

	codes, types, ends := keyArrays(rb.keys())
	if res.Purged, err = scanRowKeys(ctx, tx, filingPurgeSQL, []any{codes, types, ends}); err != nil {
		return filingRebuildResult{}, fmt.Errorf("filing rebuild: purge: %w", err)
	}

	written := map[string]bool{}
	if res.Legacy {
		for _, code := range sortedCodes(rb.Rows) {
			tag, err := tx.Exec(ctx, filingUpsertLegacySQL, filingUpsertLegacyArgs(code, rb.Rows[code], rb.FetchedAt)...)
			if err != nil {
				return filingRebuildResult{}, fmt.Errorf("filing rebuild: legacy upsert %s: %w", code, err)
			}
			if n := int(tag.RowsAffected()); n > 0 {
				res.Upserted += n
				written[code] = true
			}
		}
	} else {
		for _, col := range filingWriteColumns {
			c, t, e := keyArrays(rb.keysWith(col))
			keys, err := scanRowKeys(ctx, tx, filingNullFieldSQL(col), []any{c, t, e})
			if err != nil {
				return filingRebuildResult{}, fmt.Errorf("filing rebuild: null %s: %w", col, err)
			}
			for _, k := range keys {
				res.Nulled = append(res.Nulled, filingFieldKey{k, col})
			}
		}
		tag, err := tx.Exec(ctx, filingClearDocumentsSQL)
		if err != nil {
			return filingRebuildResult{}, fmt.Errorf("filing rebuild: clear documents: %w", err)
		}
		res.DocsCleared = int(tag.RowsAffected())
		if len(codes) > 0 {
			err = queryEach(ctx, tx, filingUpsertSQL, filingUpsertArgs(rb.Rows, rb.FetchedAt), func(rows pgx.Rows) error {
				var code string
				if err := rows.Scan(&code); err != nil {
					return err
				}
				res.Upserted++
				written[code] = true
				return nil
			})
			if err != nil {
				return filingRebuildResult{}, fmt.Errorf("filing rebuild: upsert: %w", err)
			}
		}
	}
	res.Codes = len(written)
	if err := tx.Commit(ctx); err != nil {
		return filingRebuildResult{}, fmt.Errorf("filing rebuild: commit: %w", err)
	}
	return res, nil
}
