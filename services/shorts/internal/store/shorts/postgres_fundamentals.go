package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/jackc/pgx/v5/pgconn"
)

// Fundamentals coverage read path (docs/plans/fundamentals-coverage.md §5.3).
//
// Everything here reads objects migration 000132 creates or extends: the
// columns appended to mv_fundamentals_growth, mv_fundamentals_quality, the
// new stock_fundamentals / stock_fundamentals_sync columns and
// financial_report_extractions.document_meta. Prod does not run `migrate up`,
// so the API can be deployed against a database that lacks any of them. Every
// read treats SQLSTATE 42P01 (undefined table) and 42703 (undefined column)
// alike as "absent": it logs once per method and degrades (nil extras, nil
// quality, coverage status "", no document meta), never a 500. Any other
// error is returned: a timeout on a sick view must not masquerade as "no
// data".

// isUndefinedColumn reports a Postgres undefined_column (42703) error.
func isUndefinedColumn(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42703"
}

// isMissingSchema reports 42P01 or 42703: an object a newer migration adds is
// not there yet.
func isMissingSchema(err error) bool {
	return isUndefinedTable(err) || isUndefinedColumn(err)
}

// missingSchemaLog logs an absent 000132 object once per method.
var missingSchemaLog sync.Map // method name -> *sync.Once

func logMissingSchemaOnce(method string, err error) {
	once, _ := missingSchemaLog.LoadOrStore(method, &sync.Once{})
	once.(*sync.Once).Do(func() {
		log.Warnf("%s: a fundamentals-coverage object is missing (migration 000132 not applied?); degrading to the older read: %v", method, err)
	})
}

// knownFieldSourceKeys are the stock_fundamentals value columns: the only
// keys field_sources may carry through the API.
var knownFieldSourceKeys = func() map[string]bool {
	m := map[string]bool{}
	for _, c := range fundamentalsBaseValueColumns {
		m[c.name] = true
	}
	for _, c := range fundamentalsExtendedColumns {
		m[c.name] = true
	}
	return m
}()

// maxFieldSourceLen bounds one provenance value ("derived:fcf-minus-capex"
// is the longest the contract names).
const maxFieldSourceLen = 64

// parseFieldSources decodes stock_fundamentals.field_sources. Only keys that
// name a value column and non-empty string values of a sane length survive;
// anything else (a malformed document, a stray key) is dropped. nil when
// nothing survives.
func parseFieldSources(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "{}" || raw == "null" {
		return nil
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil
	}
	var out map[string]string
	for k, v := range decoded {
		s, ok := v.(string)
		s = strings.TrimSpace(s)
		if !ok || s == "" || len(s) > maxFieldSourceLen || !knownFieldSourceKeys[k] {
			continue
		}
		if out == nil {
			out = map[string]string{}
		}
		out[k] = s
	}
	return out
}

// ---------------------------------------------------------------- extras

// FundamentalsExtras is the 000132 extras of one stock, read by pgsource.
type FundamentalsExtras = pgsource.FundamentalsExtras

// GetFundamentalsExtras returns the 000132 extras of one stock (the stock
// page's GetStockFundamentals). nil (and no error) when 000132 is absent.
func (s *postgresStore) GetFundamentalsExtras(ctx context.Context, code string) (*FundamentalsExtras, error) {
	return pgsource.GetExtras(ctx, s.db, code)
}

// getFundamentalsExtras is GetFundamentalsExtras over any fundamentalsDB.
func getFundamentalsExtras(ctx context.Context, db fundamentalsDB, code string) (*FundamentalsExtras, error) {
	return pgsource.GetExtras(ctx, db, code)
}

// ---------------------------------------------------------------- coverage

// FundamentalsCoverageRow is what we know about collecting a stock's
// fundamentals: the sources of the rows held and its stock_fundamentals_sync
// row.
type FundamentalsCoverageRow struct {
	Sources       []string // sources of the rows held, sorted
	HasSyncRow    bool     // the job has attempted the code at least once
	LastAttemptAt *time.Time
	LastSuccessAt *time.Time
	LastOutcome   string // "loaded" | "empty" | "failed"; "" when NULL
	// OutcomeKnown is false when stock_fundamentals_sync.last_outcome does
	// not exist (a database without 000132): the status is then unknown.
	OutcomeKnown bool
}

const fundamentalsCoverageSelect = `
	SELECT
		COALESCE((SELECT array_agg(DISTINCT f.source::text ORDER BY f.source::text)
		          FROM stock_fundamentals f WHERE f.stock_code = $1), '{}'::text[]),
		(s.stock_code IS NOT NULL),
		s.last_attempt_at::timestamptz,
		s.last_success_at::timestamptz,
		%s
	FROM (SELECT 1) AS one
	LEFT JOIN stock_fundamentals_sync s ON s.stock_code = $1
`

var (
	fundamentalsCoverageQuery       = fmt.Sprintf(fundamentalsCoverageSelect, `COALESCE(s.last_outcome::text, '')`)
	fundamentalsCoverageLegacyQuery = fmt.Sprintf(fundamentalsCoverageSelect, `''::text`)
)

// GetFundamentalsCoverage returns the coverage facts for one stock. nil (and
// no error) when the tables are absent; OutcomeKnown false when only the
// 000132 column is.
func (s *postgresStore) GetFundamentalsCoverage(ctx context.Context, code string) (*FundamentalsCoverageRow, error) {
	return getFundamentalsCoverage(ctx, s.db, code)
}

func getFundamentalsCoverage(ctx context.Context, db fundamentalsDB, code string) (*FundamentalsCoverageRow, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	scan := func(query string) (*FundamentalsCoverageRow, error) {
		var r FundamentalsCoverageRow
		if err := db.QueryRow(ctx, query, code).Scan(&r.Sources, &r.HasSyncRow, &r.LastAttemptAt, &r.LastSuccessAt, &r.LastOutcome); err != nil {
			return nil, err
		}
		sort.Strings(r.Sources)
		return &r, nil
	}
	r, err := scan(fundamentalsCoverageQuery)
	if err == nil {
		r.OutcomeKnown = true
		return r, nil
	}
	if isUndefinedColumn(err) {
		logMissingSchemaOnce("GetFundamentalsCoverage", err)
		r, err = scan(fundamentalsCoverageLegacyQuery)
		if err == nil {
			return r, nil
		}
	}
	if isMissingSchema(err) {
		logMissingSchemaOnce("GetFundamentalsCoverage", err)
		return nil, nil
	}
	return nil, fmt.Errorf("failed to query fundamentals coverage: %w", err)
}

// ---------------------------------------------------------------- latest filing

// FilingCandidateRow is one extraction that could be the stock's latest
// filing summary (plan §5.1): newest first, digest_confidence >= 0.6 and a
// digest present already enforced by the query.
type FilingCandidateRow struct {
	ReportURL        string
	Title            string
	ReportDate       *time.Time
	Digest           string
	DigestConfidence *float64
	// DocumentMeta is the parsed document_meta (the zero value when absent,
	// malformed or before 000132).
	DocumentMeta extractiontrust.DocumentMeta
	// FewShotEcho: some entry of the row's metrics quotes the extractor's
	// few-shot example (extractiontrust.IsFewShotText on its source_text).
	// The digest was written from those metrics (the old digest prompt told
	// the model to prefer them), so it may repeat the example's invented
	// figures; the funnel drops the entries, but not prose built from them.
	FewShotEcho bool
}

// LatestFilingInputs is everything the latest-filing selection reads.
type LatestFilingInputs struct {
	// NewestFlowPeriodEnd is the end of the newest annual, half or TTM row
	// carrying a flow figure: the period the summary must describe.
	NewestFlowPeriodEnd *time.Time
	// LatestAnnualPeriodEnd places the company's balance date (the own-period
	// resolver of plan §4.2 gate 4).
	LatestAnnualPeriodEnd *time.Time
	// CompanyName is "company-metadata".company_name, for the entity check.
	CompanyName string
	Candidates  []FilingCandidateRow
}

const latestFilingContextQuery = `
	SELECT
		(SELECT max(f.period_end)::date FROM stock_fundamentals f
		 WHERE f.stock_code = $1 AND f.period_type IN ('annual', 'half', 'ttm')
		   AND (f.revenue IS NOT NULL OR f.net_income IS NOT NULL OR f.eps_basic IS NOT NULL
		        OR f.eps_diluted IS NOT NULL OR f.operating_cash_flow IS NOT NULL OR f.free_cash_flow IS NOT NULL)),
		(SELECT max(f.period_end)::date FROM stock_fundamentals f
		 WHERE f.stock_code = $1 AND f.period_type = 'annual'),
		COALESCE((SELECT cm.company_name::text FROM "company-metadata" cm WHERE cm.stock_code = $1 LIMIT 1), '')
`

// latestFilingCandidatesLimit bounds how far back the selection looks: a
// company files a handful of extracted documents per period.
const latestFilingCandidatesLimit = 20

// The candidates read every metrics entry's source_text, not the whole
// metrics document: the page needs only the quotes, to test them against the
// few-shot denylist. An entry is a class value or an element of a class's
// list (the shapes extractiontrust.TrustedEntries reads); lax mode also
// reaches a list nested in a list, which only errs towards withholding a
// digest, and skips anything that is not an object carrying the key.
const latestFilingCandidatesSelect = `
	SELECT
		e.report_url::text,
		COALESCE(e.report_title::text, ''),
		e.report_date::date,
		COALESCE(e.digest::text, ''),
		e.digest_confidence::float8,
		COALESCE(jsonb_path_query_array(e.metrics::jsonb, 'lax $.*[*].source_text')::text, '[]'),
		%s
	FROM financial_report_extractions e
	WHERE e.stock_code = $1
	  AND e.report_date IS NOT NULL
	  AND e.digest_confidence >= 0.6
	  AND COALESCE(btrim(e.digest), '') <> ''
	ORDER BY e.report_date DESC, e.extracted_at DESC
	LIMIT %d
`

var (
	latestFilingCandidatesQuery       = fmt.Sprintf(latestFilingCandidatesSelect, `COALESCE(e.document_meta::text, '')`, latestFilingCandidatesLimit)
	latestFilingCandidatesLegacyQuery = fmt.Sprintf(latestFilingCandidatesSelect, `''::text`, latestFilingCandidatesLimit)
)

// GetLatestFilingInputs reads what the latest-filing selection needs.
// document_meta is read with 42703 tolerance (the zero meta before 000132);
// a missing table yields no candidates. nil (and no error) only when
// stock_fundamentals itself is absent.
func (s *postgresStore) GetLatestFilingInputs(ctx context.Context, code string) (*LatestFilingInputs, error) {
	return getLatestFilingInputs(ctx, s.db, code)
}

func getLatestFilingInputs(ctx context.Context, db fundamentalsDB, code string) (*LatestFilingInputs, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	var in LatestFilingInputs
	if err := db.QueryRow(ctx, latestFilingContextQuery, code).Scan(&in.NewestFlowPeriodEnd, &in.LatestAnnualPeriodEnd, &in.CompanyName); err != nil {
		if isMissingSchema(err) {
			logMissingRelationOnce("GetLatestFilingInputs", err)
			return nil, nil
		}
		return nil, fmt.Errorf("failed to query latest filing context: %w", err)
	}
	if in.NewestFlowPeriodEnd == nil {
		return &in, nil // nothing to describe: no need to read the filings
	}

	cands, err := readFilingCandidates(ctx, db, latestFilingCandidatesQuery, code)
	if err != nil && isUndefinedColumn(err) {
		logMissingSchemaOnce("GetLatestFilingInputs", err)
		cands, err = readFilingCandidates(ctx, db, latestFilingCandidatesLegacyQuery, code)
	}
	if err != nil {
		if isMissingSchema(err) {
			logMissingSchemaOnce("GetLatestFilingInputs.extractions", err)
			return &in, nil
		}
		return nil, fmt.Errorf("failed to query latest filing candidates: %w", err)
	}
	in.Candidates = cands
	return &in, nil
}

func readFilingCandidates(ctx context.Context, db fundamentalsDB, query, code string) ([]FilingCandidateRow, error) {
	rows, err := db.Query(ctx, query, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FilingCandidateRow
	for rows.Next() {
		var (
			r       FilingCandidateRow
			sources string
			meta    string
		)
		if err := rows.Scan(&r.ReportURL, &r.Title, &r.ReportDate, &r.Digest, &r.DigestConfidence, &sources, &meta); err != nil {
			return nil, err
		}
		r.DigestConfidence = finite(r.DigestConfidence)
		r.FewShotEcho = quotesFewShotExample(sources)
		if parsed, err := extractiontrust.ParseDocumentMeta([]byte(meta)); err == nil {
			r.DocumentMeta = parsed
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// quotesFewShotExample reports whether any quote in a JSON array of metrics
// source_text values is a few-shot example text (extractiontrust.IsFewShotText,
// the funnel's own denylist). A value that is not a string quotes nothing, as
// in the funnel; an array that does not parse is no evidence either way.
func quotesFewShotExample(sourcesJSON string) bool {
	var quotes []any
	if err := json.Unmarshal([]byte(sourcesJSON), &quotes); err != nil {
		return false
	}
	for _, q := range quotes {
		if text, ok := q.(string); ok && extractiontrust.IsFewShotText(text) {
			return true
		}
	}
	return false
}
