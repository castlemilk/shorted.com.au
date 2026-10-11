package review

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// The review's queries: SELECTs only, run inside the job's READ ONLY
// transaction. A %s is one of two fixed fragments, chosen by whether the
// optional column exists (never caller input).
const (
	columnExistsSQL = `
SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = ANY (current_schemas(false)) AND table_name = $1 AND column_name = $2)`

	extractionsSQL = `
SELECT e.stock_code, e.report_url, COALESCE(e.report_title, ''), e.report_date,
       e.metrics::text, COALESCE(e.digest, '') <> '', e.digest_confidence,
       e.raw_text_length, %s, e.extracted_at, %s,
       COALESCE(cm.company_name, '')
FROM financial_report_extractions e
LEFT JOIN "company-metadata" cm ON cm.stock_code = e.stock_code
WHERE COALESCE(e.report_date, e.extracted_at::date) >= $1::date
ORDER BY e.report_date DESC NULLS LAST, e.stock_code, e.report_url`

	companiesSQL = `
SELECT stock_code, COALESCE(company_name, ''), COALESCE(financial_reports::text, ''),
       COALESCE(key_metrics->>'market_cap', ''), COALESCE(market_cap::text, '')
FROM "company-metadata"
WHERE financial_reports IS NOT NULL AND financial_reports::text LIKE '%asx_announcements%'`

	extractionStatesSQL = `
SELECT report_url, (metrics <> '{}'::jsonb OR COALESCE(digest, '') <> ''), raw_text_length, %s, extracted_at
FROM financial_report_extractions WHERE report_url = ANY($1)`

	noticeOutcomesSQL = `
SELECT outcome, %s, count(*), count(*) FILTER (WHERE attempted_at >= $1)
FROM dividend_notice_attempts GROUP BY 1, 2 ORDER BY 1, 2`

	// noticeFailuresSQL: superseded is whether another notice stored the
	// dividend this one names by its ex-date (parser 3 writes "ex YYYY-MM-DD"
	// first in the detail of a notice that waits on its update).
	noticeFailuresSQL = `
SELECT a.stock_code, a.outcome, COALESCE(a.detail, ''), a.announcement_url, a.attempted_at, %s,
       EXISTS (SELECT 1 FROM dividend_history d
               WHERE d.stock_code = a.stock_code AND d.announcement_url <> a.announcement_url
                 AND d.ex_date::text = substring(a.detail from '^ex ([0-9]{4}-[0-9]{2}-[0-9]{2})'))
FROM dividend_notice_attempts a
WHERE a.outcome NOT IN ('parsed', 'cancellation') AND a.attempted_at >= $1
ORDER BY a.attempted_at DESC, a.stock_code, a.announcement_url`
)

// queries lists every statement the review can send, for the read-only test.
var queries = []string{columnExistsSQL, extractionsSQL, companiesSQL, extractionStatesSQL, noticeOutcomesSQL, noticeFailuresSQL}

// optional is the column when it exists, else the constant that stands in
// for it (an attempt count of 1, parser version 1, no document_meta).
func optional(exists bool, column, fallback string) string {
	if exists {
		return column
	}
	return fallback
}

// source is the interface to extract data from the database.
type source interface {
	ColumnExists(ctx context.Context, table, column string) (bool, error)
	Extractions(ctx context.Context, since time.Time, attempts, meta bool) ([]extractionRow, error)
	Companies(ctx context.Context) ([]companyRow, error)
	ExtractionStates(ctx context.Context, urls []string, attempts bool) (map[string]extractionState, error)
	NoticeOutcomes(ctx context.Context, since time.Time, versioned bool) ([]outcomeCount, error)
	NoticeFailures(ctx context.Context, since time.Time, versioned bool) ([]noticeFailure, error)
}

// querier is the interface satisfied by pgx transaction.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// pgSource implements source using PostgreSQL queries.
type pgSource struct {
	q querier
}

// Row types for database results

type extractionRow struct {
	StockCode        string
	URL              string
	Title            string
	CompanyName      string
	ReportDate       *time.Time
	Metrics          []byte
	HasDigest        bool
	DigestConfidence *float64
	RawTextLength    *int
	Attempts         int
	ExtractedAt      time.Time
	DocumentMeta     []byte // nil when absent
}

type companyRow struct {
	StockCode        string
	CompanyName      string
	FinancialReports string // "" when NULL
	MarketCapKM      string // "" when NULL
	MarketCapCol     string // "" when NULL
}

type extractionState struct {
	Parsed        bool
	RawTextLength *int
	Attempts      int
	ExtractedAt   time.Time
}

type outcomeCount struct {
	Outcome       string
	ParserVersion int
	Total         int
	Recent        int
}

type noticeFailure struct {
	StockCode     string
	Outcome       string
	Detail        string
	URL           string
	AttemptedAt   time.Time
	ParserVersion int
	// Superseded: another notice stored the dividend this one waits on.
	Superseded bool
	// State is noticeState's reading, set by collect.
	State string
}

// ColumnExists checks whether a column exists in a table.
func (s *pgSource) ColumnExists(ctx context.Context, table, column string) (bool, error) {
	var exists bool
	if err := s.q.QueryRow(ctx, columnExistsSQL, table, column).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

// Extractions returns extraction rows from the window. attempts and meta flags
// control whether to select those optional columns.
func (s *pgSource) Extractions(ctx context.Context, since time.Time, attempts, meta bool) ([]extractionRow, error) {
	sql := fmt.Sprintf(extractionsSQL,
		optional(attempts, "e.extraction_attempts", "1"), optional(meta, "e.document_meta::text", "NULL::text"))
	rows, err := s.q.Query(ctx, sql, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []extractionRow
	for rows.Next() {
		var r extractionRow
		if err := rows.Scan(
			&r.StockCode, &r.URL, &r.Title, &r.ReportDate, &r.Metrics,
			&r.HasDigest, &r.DigestConfidence, &r.RawTextLength, &r.Attempts,
			&r.ExtractedAt, &r.DocumentMeta, &r.CompanyName,
		); err != nil {
			return nil, err
		}
		results = append(results, r)
	}
	return results, rows.Err()
}

// Companies returns company metadata rows with financial reports.
func (s *pgSource) Companies(ctx context.Context) ([]companyRow, error) {
	rows, err := s.q.Query(ctx, companiesSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []companyRow
	for rows.Next() {
		var r companyRow
		if err := rows.Scan(&r.StockCode, &r.CompanyName, &r.FinancialReports, &r.MarketCapKM, &r.MarketCapCol); err != nil {
			return nil, err
		}
		results = append(results, r)
	}
	return results, rows.Err()
}

// ExtractionStates returns the state of extractions by URL. attempts flag controls
// whether to select the extraction_attempts column.
func (s *pgSource) ExtractionStates(ctx context.Context, urls []string, attempts bool) (map[string]extractionState, error) {
	if len(urls) == 0 {
		return map[string]extractionState{}, nil
	}

	rows, err := s.q.Query(ctx, fmt.Sprintf(extractionStatesSQL, optional(attempts, "extraction_attempts", "1")), urls)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make(map[string]extractionState)
	for rows.Next() {
		var url string
		var state extractionState
		if err := rows.Scan(&url, &state.Parsed, &state.RawTextLength, &state.Attempts, &state.ExtractedAt); err != nil {
			return nil, err
		}
		results[url] = state
	}
	return results, rows.Err()
}

// NoticeOutcomes returns dividend notice outcome counts. versioned flag controls
// whether to select the parser_version column.
func (s *pgSource) NoticeOutcomes(ctx context.Context, since time.Time, versioned bool) ([]outcomeCount, error) {
	rows, err := s.q.Query(ctx, fmt.Sprintf(noticeOutcomesSQL, optional(versioned, "parser_version", "1")), since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []outcomeCount
	for rows.Next() {
		var r outcomeCount
		if err := rows.Scan(&r.Outcome, &r.ParserVersion, &r.Total, &r.Recent); err != nil {
			return nil, err
		}
		results = append(results, r)
	}
	return results, rows.Err()
}

// NoticeFailures returns failed dividend notice attempts in the window.
// versioned flag controls whether to select the parser_version column.
func (s *pgSource) NoticeFailures(ctx context.Context, since time.Time, versioned bool) ([]noticeFailure, error) {
	rows, err := s.q.Query(ctx, fmt.Sprintf(noticeFailuresSQL, optional(versioned, "parser_version", "1")), since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []noticeFailure
	for rows.Next() {
		var r noticeFailure
		if err := rows.Scan(&r.StockCode, &r.Outcome, &r.Detail, &r.URL, &r.AttemptedAt, &r.ParserVersion, &r.Superseded); err != nil {
			return nil, err
		}
		results = append(results, r)
	}
	return results, rows.Err()
}
