package picks

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// The -mode filings half of the store: every statement only the filings path
// runs. The vendor path (upsertSQL, LastAttempts, RecordAttempt, the universe
// and the refresh) stays in store.go. Split so the filing rebuild can change
// here without touching the vendor writer (plan fundamentals-coverage.md §4.3).

// filingStore is the part of store the filings ingest reads and writes.
// store embeds it, so the method set of store is unchanged.
type filingStore interface {
	// FilingExtractions: every financial_report_extractions row whose metrics
	// carry a revenue / profit / EPS class (-mode filings).
	FilingExtractions(ctx context.Context) ([]filingExtraction, error)
	// VendorAnnuals: every non-filing annual stock_fundamentals row, by code
	// (balance date, reporting currency and the magnitude/EPS cross-checks).
	VendorAnnuals(ctx context.Context) (map[string][]vendorAnnual, error)
	// UpsertFilingPeriods writes one code's filing rows as ONE statement under
	// the filing conflict policy (filingUpsertSQL).
	UpsertFilingPeriods(ctx context.Context, code string, rows []PeriodRow, fetchedAt time.Time) error
}

// filingExtractionsSQL reads the extractions -mode filings parses. The JSONB
// key prefilter (?| over the metric class names, filingKeys) keeps the ~98%
// of rows with no usable metric out of the wire entirely.
const filingExtractionsSQL = `
SELECT stock_code::text, report_url, COALESCE(report_type, ''), COALESCE(report_title, ''),
       report_date, metrics::text
FROM financial_report_extractions
WHERE jsonb_typeof(metrics) = 'object'
  AND metrics ?| $1::text[]
ORDER BY stock_code, report_date NULLS LAST, report_url`

func (s *pgStore) FilingExtractions(ctx context.Context) ([]filingExtraction, error) {
	rows, err := s.pool.Query(ctx, filingExtractionsSQL, filingKeys())
	if err != nil {
		if undefinedTable(err) {
			return nil, nil // no extractor table in this database: nothing to ingest
		}
		return nil, fmt.Errorf("filing extractions: %w", err)
	}
	defer rows.Close()
	var out []filingExtraction
	for rows.Next() {
		var e filingExtraction
		var reportDate *time.Time
		if err := rows.Scan(&e.Code, &e.URL, &e.Type, &e.Title, &reportDate, &e.Metrics); err != nil {
			return nil, fmt.Errorf("filing extractions: %w", err)
		}
		if reportDate != nil {
			e.ReportDate = time.Date(reportDate.Year(), reportDate.Month(), reportDate.Day(), 0, 0, 0, 0, time.UTC)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// vendorAnnualsSQL: the vendor rows the filing rules consult. Only annual
// rows (balance date, revenue scale, share count); a filing row is never its
// own reference.
const vendorAnnualsSQL = `
SELECT stock_code::text, period_end, currency::text, revenue, shares_outstanding
FROM stock_fundamentals
WHERE period_type = 'annual' AND source <> '` + sourceFiling + `'`

func (s *pgStore) VendorAnnuals(ctx context.Context) (map[string][]vendorAnnual, error) {
	rows, err := s.pool.Query(ctx, vendorAnnualsSQL)
	if err != nil {
		return nil, fmt.Errorf("vendor annual rows: %w", err)
	}
	defer rows.Close()
	out := map[string][]vendorAnnual{}
	for rows.Next() {
		var code string
		var v vendorAnnual
		if err := rows.Scan(&code, &v.PeriodEnd, &v.Currency, &v.Revenue, &v.Shares); err != nil {
			return nil, fmt.Errorf("vendor annual rows: %w", err)
		}
		v.PeriodEnd = time.Date(v.PeriodEnd.Year(), v.PeriodEnd.Month(), v.PeriodEnd.Day(), 0, 0, 0, 0, time.UTC)
		code = strings.ToUpper(strings.TrimSpace(code))
		out[code] = append(out[code], v)
	}
	return out, rows.Err()
}

// filingUpsertSQL is the filing CONFLICT POLICY, in SQL so no caller can get
// it wrong (plan §2.6):
//
//   - The stored row is a VENDOR row (any source but asx-filing-extraction:
//     Yahoo, Markit, or a future licensed feed): its non-null values are never
//     touched. A filing only fills a column the vendor left NULL, and only
//     when the currencies agree; currency, source and source_fetched_at stay
//     the vendor's.
//   - The stored row is a FILING row: replaced whole. -mode filings is a
//     deterministic rebuild from every extraction, so this run's merged row is
//     the complete picture and a NULL means no document supports the value
//     any more.
//   - No stored row (every 'half' period; an annual Yahoo has not published
//     yet): inserted whole.
//   - A FILING row of this code that this run no longer produces (a parser
//     rule tightened, or a date re-keyed onto a vendor's) is deleted in the
//     same statement (the pruned CTE). Scoped to one code and to the filing
//     source, and only reached for a code with at least one new row, so a
//     vendor row is never deleted and an empty read deletes nothing. A code
//     that stops producing rows entirely keeps its old ones (docs: README
//     "picks", cleanup).
//
// The WHERE skips no-op updates, so updated_at moves only when a value did.
// The reverse direction (Yahoo arriving after a filing row) is upsertSQL's:
// the vendor's values win and the filing's survive only where it has NULL.
const filingUpsertSQL = `
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

// filingUpsertArgs builds filingUpsertSQL's arguments.
func filingUpsertArgs(code string, rows []PeriodRow, fetchedAt time.Time) []any {
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

func (s *pgStore) UpsertFilingPeriods(ctx context.Context, code string, rows []PeriodRow, fetchedAt time.Time) error {
	if len(rows) == 0 {
		return nil
	}
	if _, err := s.pool.Exec(ctx, filingUpsertSQL, filingUpsertArgs(code, rows, fetchedAt)...); err != nil {
		return fmt.Errorf("filing upsert %s: %w", code, err)
	}
	return nil
}
