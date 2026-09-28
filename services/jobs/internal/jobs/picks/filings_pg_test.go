package picks

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
)

// Real-Postgres tests for the filing rebuild (plan fundamentals-coverage.md
// §2.2, §4.3). Skipped unless PICKS_TEST_DATABASE_URL is set (CI has no
// database for this package):
//
//	PICKS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5499/picks?sslmode=disable \
//	  GOWORK=off go test ./internal/jobs/picks/ -run AgainstPostgres
//
// Each test builds a FRESH schema (f132_<random>), applies migrations 000002,
// 000045, 000117, 000129, 000130 and 000131 to it, then migration 000132 when
// its file is present in services/migrations, else the 000132 columns this
// stream writes, added ad hoc (000132 lands from the data stream; after that
// merge the real file is applied here instead). The schema is dropped at the
// end. A pooler or Supabase DSN is refused: this creates and drops schemas.

const f132MigrationsDir = "../../../../migrations"

func f132DSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("PICKS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("PICKS_TEST_DATABASE_URL not set")
	}
	for _, banned := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(dsn, banned) {
			t.Fatalf("PICKS_TEST_DATABASE_URL looks like a shared database (%q): refusing to create schemas there", banned)
		}
	}
	return dsn
}

// f132Schema creates a fresh schema with the migrations applied and returns a
// store whose pool is pinned to it (search_path), exactly as the job connects
// (platform.Connect: simple protocol). with132 false stops at 000131: the
// pre-000132 database the fallbacks are for.
func f132Schema(t *testing.T, with132 bool) (*pgStore, *pgxpool.Pool) {
	t.Helper()
	dsn := f132DSN(t)
	ctx := context.Background()
	schema := fmt.Sprintf("f132_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))

	admin, err := platform.Connect(ctx, dsn)
	require.NoError(t, err)
	_, err = admin.Exec(ctx, "CREATE SCHEMA "+schema)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})

	pool, err := platform.Connect(ctx, dsn, platform.PoolOption(func(cfg *pgxpool.Config) {
		cfg.ConnConfig.RuntimeParams["search_path"] = schema
	}))
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	for _, name := range []string{
		"000002_stock_prices.up.sql",
		"000045_formalize_financial_report_extractions.up.sql",
		"000117_add_index_prices.up.sql",
		"000129_add_stock_fundamentals.up.sql",
		"000130_add_price_features.up.sql",
		"000131_widen_stock_price_precision.up.sql",
	} {
		f132Apply(t, pool, filepath.Join(f132MigrationsDir, name))
	}
	if with132 {
		matches, _ := filepath.Glob(filepath.Join(f132MigrationsDir, "000132_*.up.sql"))
		if len(matches) == 1 {
			f132Apply(t, pool, matches[0])
		} else {
			f132AdHoc132(t, pool)
		}
	}
	_, err = pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS "company-metadata" (
		stock_code VARCHAR(50) UNIQUE, company_name TEXT, industry TEXT)`)
	require.NoError(t, err)
	return &pgStore{pool: pool, notices: &noticeLog{}}, pool
}

func f132Apply(t *testing.T, pool *pgxpool.Pool, path string) {
	t.Helper()
	b, err := os.ReadFile(path)
	require.NoError(t, err, path)
	_, err = pool.Exec(context.Background(), string(b))
	require.NoError(t, err, "applying %s", filepath.Base(path))
}

// f132AdHoc132 adds exactly the migration 000132 columns the filings stream
// reads and writes (plan §2.1, §2.5), with 000132's types and defaults.
func f132AdHoc132(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		ALTER TABLE stock_fundamentals
		    ADD COLUMN IF NOT EXISTS field_sources JSONB NOT NULL DEFAULT '{}'::jsonb,
		    ADD COLUMN IF NOT EXISTS source_document_url TEXT,
		    ADD COLUMN IF NOT EXISTS source_document_date DATE;
		ALTER TABLE financial_report_extractions
		    ADD COLUMN IF NOT EXISTS document_meta JSONB;`)
	require.NoError(t, err)
}

type f132Row struct {
	revenue, netIncome, epsBasic *float64
	currency, source             string
	fieldSources                 string
	docURL                       *string
	docDate                      *time.Time
	updatedAt                    time.Time
}

func f132Read(t *testing.T, pool *pgxpool.Pool, code, typ, end string) (f132Row, bool) {
	t.Helper()
	var r f132Row
	err := pool.QueryRow(context.Background(), `
		SELECT revenue, net_income, eps_basic, currency, source, field_sources::text,
		       source_document_url, source_document_date, updated_at
		FROM stock_fundamentals WHERE stock_code = $1 AND period_type = $2 AND period_end = $3::date`,
		code, typ, end).
		Scan(&r.revenue, &r.netIncome, &r.epsBasic, &r.currency, &r.source, &r.fieldSources, &r.docURL, &r.docDate, &r.updatedAt)
	if err != nil {
		return f132Row{}, false
	}
	return r, true
}

func f132Exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	_, err := pool.Exec(context.Background(), sql, args...)
	require.NoError(t, err, sql)
}

func f132Seed(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	// ZZA: a vendor row with a NULL net income (the filing fills it), and an
	// older vendor row whose net income a PREVIOUS run filled from a filing
	// this run no longer reproduces (nulled, marker and document cleared).
	f132Exec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, source)
		VALUES ('ZZA', 'annual', '2025-06-30', 'AUD', 100e6, 'yahoo-timeseries')`)
	f132Exec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, net_income, source,
		field_sources, source_document_url, source_document_date)
		VALUES ('ZZA', 'annual', '2024-06-30', 'AUD', 90e6, 5e6, 'yahoo-timeseries',
		'{"net_income": "asx-filing-extraction"}', 'u-old-4e', '2024-08-20')`)
	// ZZA: a stale filing half this run replaces.
	f132Exec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, net_income, source)
		VALUES ('ZZA', 'half', '2025-12-31', 'AUD', 59e6, 1e6, 'asx-filing-extraction')`)
	// ZZB: a USD vendor row an AUD filing must never fill.
	f132Exec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, source)
		VALUES ('ZZB', 'annual', '2025-06-30', 'USD', 50e6, 'yahoo-timeseries')`)
	// ZZC: a VENDOR TAKEOVER (plan §2.2 rule 5): Yahoo took a filing row
	// over, supplying revenue and keeping the filing's net income, marked.
	f132Exec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, net_income, source,
		field_sources, source_document_url, source_document_date)
		VALUES ('ZZC', 'annual', '2024-06-30', 'AUD', 10.2e6, 1e6, 'yahoo-timeseries',
		'{"net_income": "asx-filing-extraction"}', 'u-4e-24', '2024-08-22')`)
	// ZZE: the echo row (the old few-shot example's revenue as a half).
	f132Exec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, net_income, eps_basic, source)
		VALUES ('ZZE', 'half', '2024-12-31', 'AUD', 5142e6, 1823e6, 0.942, 'asx-filing-extraction')`)
}

func f132Rows() map[string][]PeriodRow {
	fy25, fy26, fy24 := int16(2025), int16(2026), int16(2024)
	d := func(s string) *time.Time { x := date(s); return &x }
	return map[string][]PeriodRow{
		"ZZA": {
			{PeriodType: periodHalf, PeriodEnd: date("2024-12-31"), FiscalYear: &fy25, Currency: "AUD", Revenue: f64(45e6), Source: sourceFiling,
				SourceDocumentURL: "u-4d-25", SourceDocumentDate: d("2025-02-20")},
			{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), FiscalYear: &fy25, Currency: "AUD", Revenue: f64(999e6), NetIncome: f64(7e6), Source: sourceFiling,
				SourceDocumentURL: "u-4e-25", SourceDocumentDate: d("2025-08-20")},
			{PeriodType: periodHalf, PeriodEnd: date("2025-12-31"), FiscalYear: &fy26, Currency: "AUD", Revenue: f64(60e6), EPSBasic: f64(0.03), Source: sourceFiling,
				SourceDocumentURL: "u-4d-26", SourceDocumentDate: d("2026-02-20")},
		},
		"ZZB": {
			{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), FiscalYear: &fy25, Currency: "AUD", NetIncome: f64(7e6), Source: sourceFiling,
				SourceDocumentURL: "u-zzb", SourceDocumentDate: d("2025-08-20")},
		},
		"ZZC": {
			{PeriodType: periodAnnual, PeriodEnd: date("2024-06-30"), FiscalYear: &fy24, Currency: "AUD", NetIncome: f64(1.1e6), Source: sourceFiling,
				SourceDocumentURL: "u-4e-24b", SourceDocumentDate: d("2024-08-23")},
		},
	}
}

func TestFilingRebuildAgainstPostgres(t *testing.T) {
	st, pool := f132Schema(t, true)
	ctx := context.Background()
	f132Seed(t, pool)
	rows := f132Rows()

	stored, err := st.StoredFilingState(ctx)
	require.NoError(t, err)
	wantPurge, wantNull := planPurge(stored, rows)

	res, err := st.RebuildFilings(ctx, filingRebuild{Rows: rows, FetchedAt: time.Now()})
	require.NoError(t, err)
	assert.False(t, res.Legacy)
	sort.Slice(res.Purged, func(i, j int) bool { return res.Purged[i].less(res.Purged[j]) })
	assert.Equal(t, wantPurge, res.Purged, "the transaction deletes exactly what planPurge says")
	assert.Equal(t, wantNull, res.Nulled, "and nulls exactly what planPurge says")
	assert.Equal(t, []filingRowKey{{"ZZE", periodHalf, date("2024-12-31")}}, res.Purged, "the echo row goes")
	assert.Equal(t, []filingFieldKey{{filingRowKey{"ZZA", periodAnnual, date("2024-06-30")}, "net_income"}}, res.Nulled)
	assert.Equal(t, 1, res.DocsCleared)

	// The echo row is gone.
	_, ok := f132Read(t, pool, "ZZE", periodHalf, "2024-12-31")
	assert.False(t, ok)

	// A previous run's fill that nothing reproduces: nulled, unmarked, and
	// the row no longer names a filing. The vendor's own revenue stays.
	old, ok := f132Read(t, pool, "ZZA", periodAnnual, "2024-06-30")
	require.True(t, ok)
	assert.Nil(t, old.netIncome)
	assert.Equal(t, 90e6, *old.revenue)
	assert.JSONEq(t, `{}`, old.fieldSources)
	assert.Nil(t, old.docURL)
	assert.Nil(t, old.docDate)

	// Fill a vendor NULL: marked, documented; the vendor's value untouched.
	a, ok := f132Read(t, pool, "ZZA", periodAnnual, "2025-06-30")
	require.True(t, ok)
	assert.Equal(t, 100e6, *a.revenue, "a vendor's own value is never overwritten")
	require.NotNil(t, a.netIncome)
	assert.Equal(t, 7e6, *a.netIncome, "the vendor's NULL is filled")
	assert.Equal(t, sourceYahoo, a.source, "the row stays the vendor's")
	assert.JSONEq(t, `{"net_income": "asx-filing-extraction"}`, a.fieldSources)
	require.NotNil(t, a.docURL)
	assert.Equal(t, "u-4e-25", *a.docURL)
	assert.Equal(t, "2025-08-20", a.docDate.Format("2006-01-02"))

	// A filing row is replaced whole (the stale NPAT is gone), a half the
	// vendor lacks is inserted.
	h, ok := f132Read(t, pool, "ZZA", periodHalf, "2025-12-31")
	require.True(t, ok)
	assert.Equal(t, 60e6, *h.revenue)
	assert.Nil(t, h.netIncome, "full replace: no document supports the old NPAT")
	assert.Equal(t, 0.03, *h.epsBasic)
	assert.Equal(t, sourceFiling, h.source)
	assert.JSONEq(t, `{}`, h.fieldSources, "a filing row's own values carry no marker")
	assert.Equal(t, "u-4d-26", *h.docURL)
	h25, ok := f132Read(t, pool, "ZZA", periodHalf, "2024-12-31")
	require.True(t, ok)
	assert.Equal(t, 45e6, *h25.revenue)

	// Currencies must agree.
	b, _ := f132Read(t, pool, "ZZB", periodAnnual, "2025-06-30")
	assert.Nil(t, b.netIncome, "an AUD filing never fills a USD vendor row")
	assert.JSONEq(t, `{}`, b.fieldSources)
	assert.Nil(t, b.docURL)

	// Vendor takeover (plan §2.2 rule 5): the filing value the vendor kept,
	// marked, is REPLACED by this run's, still marked; the vendor's revenue
	// is untouched.
	c, ok := f132Read(t, pool, "ZZC", periodAnnual, "2024-06-30")
	require.True(t, ok)
	assert.Equal(t, sourceYahoo, c.source)
	assert.Equal(t, 10.2e6, *c.revenue)
	assert.Equal(t, 1.1e6, *c.netIncome)
	assert.JSONEq(t, `{"net_income": "asx-filing-extraction"}`, c.fieldSources)
	assert.Equal(t, "u-4e-24b", *c.docURL)

	// An identical rebuild is a no-op: nothing purged, nothing upserted,
	// updated_at unmoved.
	time.Sleep(20 * time.Millisecond)
	again, err := st.RebuildFilings(ctx, filingRebuild{Rows: rows, FetchedAt: time.Now()})
	require.NoError(t, err)
	assert.Empty(t, again.Purged)
	assert.Empty(t, again.Nulled)
	assert.Equal(t, 0, again.Upserted, "an identical rebuild changes nothing")
	h2, _ := f132Read(t, pool, "ZZA", periodHalf, "2025-12-31")
	assert.Equal(t, h.updatedAt, h2.updatedAt)
	a2, _ := f132Read(t, pool, "ZZA", periodAnnual, "2025-06-30")
	assert.Equal(t, a.updatedAt, a2.updatedAt)

	// The takeover's filing value stops being reproduced: nulled, unmarked,
	// undocumented; the vendor keeps its row and its revenue.
	delete(rows, "ZZC")
	res, err = st.RebuildFilings(ctx, filingRebuild{Rows: rows, FetchedAt: time.Now()})
	require.NoError(t, err)
	assert.Equal(t, []filingFieldKey{{filingRowKey{"ZZC", periodAnnual, date("2024-06-30")}, "net_income"}}, res.Nulled)
	c2, ok := f132Read(t, pool, "ZZC", periodAnnual, "2024-06-30")
	require.True(t, ok, "a vendor row is never deleted")
	assert.Nil(t, c2.netIncome)
	assert.Equal(t, 10.2e6, *c2.revenue)
	assert.JSONEq(t, `{}`, c2.fieldSources)
	assert.Nil(t, c2.docURL)

	// An empty rebuild (every code lost its vendor context) purges every
	// filing row and every filing-filled value, and nothing else.
	res, err = st.RebuildFilings(ctx, filingRebuild{Rows: map[string][]PeriodRow{}, FetchedAt: time.Now()})
	require.NoError(t, err)
	assert.Len(t, res.Purged, 2, "ZZA's two halves")
	assert.Equal(t, []filingFieldKey{{filingRowKey{"ZZA", periodAnnual, date("2025-06-30")}, "net_income"}}, res.Nulled)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM stock_fundamentals WHERE source = 'asx-filing-extraction'`).Scan(&n))
	assert.Zero(t, n)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM stock_fundamentals`).Scan(&n))
	assert.Equal(t, 4, n, "the four vendor rows survive")
}

// A failure anywhere in the rebuild rolls everything back: nothing deleted,
// nothing written.
func TestFilingRebuildRollsBackAgainstPostgres(t *testing.T) {
	st, pool := f132Schema(t, true)
	ctx := context.Background()
	f132Seed(t, pool)
	rows := f132Rows()
	// A value the table CHECK refuses fails the upsert, the LAST statement.
	rows["ZZA"][2].Revenue = f64(1e19)
	_, err := st.RebuildFilings(ctx, filingRebuild{Rows: rows, FetchedAt: time.Now()})
	require.Error(t, err)
	_, ok := f132Read(t, pool, "ZZE", periodHalf, "2024-12-31")
	assert.True(t, ok, "the purge rolled back with the failed upsert")
	old, _ := f132Read(t, pool, "ZZA", periodAnnual, "2024-06-30")
	require.NotNil(t, old.netIncome, "the per-field purge rolled back too")
}

// A database without migration 000132: every read falls back on 42703, the
// rebuild takes the legacy path (purge + fill, no markers).
func TestFilingPre132FallbackAgainstPostgres(t *testing.T) {
	st, pool := f132Schema(t, false)
	ctx := context.Background()
	f132Exec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, source)
		VALUES ('ZZA', 'annual', '2025-06-30', 'AUD', 100e6, 'yahoo-timeseries'),
		       ('ZZE', 'half', '2024-12-31', 'AUD', 5142e6, 'asx-filing-extraction')`)
	f132Exec(t, pool, `INSERT INTO financial_report_extractions (stock_code, report_url, report_title, report_date, metrics, digest_confidence)
		VALUES ('ZZA', 'u-4d', 'Appendix 4D', '2026-02-20', '{"revenue": {"source_text": "Revenue $60.0 million", "value_millions": "60", "period": "H1 FY2026"}}', 0.8)`)

	exts, err := st.FilingExtractions(ctx)
	require.NoError(t, err)
	require.Len(t, exts, 1)
	assert.Empty(t, exts[0].DocumentMeta, "no document_meta column: absent")
	require.NotNil(t, exts[0].DigestConfidence)
	assert.Equal(t, 0.8, *exts[0].DigestConfidence)

	vendor, err := st.VendorRows(ctx)
	require.NoError(t, err)
	require.Len(t, vendor["ZZA"], 1)
	assert.Nil(t, vendor["ZZA"][0].FieldSources)

	stored, err := st.StoredFilingState(ctx)
	require.NoError(t, err)
	assert.Len(t, stored, 1)

	profiles, err := st.CompanyProfiles(ctx)
	require.NoError(t, err)
	assert.Empty(t, profiles)

	stats, err := runFilings(ctx, st, false, func(string, ...any) {})
	require.NoError(t, err)
	assert.True(t, stats.Legacy)
	assert.Equal(t, 1, stats.Purged, "the echo row goes even without 000132")
	var rev float64
	var src string
	require.NoError(t, pool.QueryRow(ctx, `SELECT revenue, source FROM stock_fundamentals
		WHERE stock_code = 'ZZA' AND period_type = 'half' AND period_end = '2025-12-31'`).Scan(&rev, &src))
	assert.Equal(t, 60e6, rev)
	assert.Equal(t, sourceFiling, src)
}

// End to end through runFilings on a 000132 database: document_meta is read,
// gate 1 withholds a foreign document, the bare 4E table line is scaled by the
// document's units, and the row names its filing.
func TestRunFilingsAgainstPostgres(t *testing.T) {
	st, pool := f132Schema(t, true)
	ctx := context.Background()
	f132Exec(t, pool, `INSERT INTO "company-metadata" (stock_code, company_name, industry)
		VALUES ('ZZU', 'ZZU MINING GROUP LIMITED', 'Materials'), ('ZZF', 'ZZF HOLDINGS LIMITED', 'Materials')`)
	f132Exec(t, pool, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, net_income, shares_outstanding, source)
		VALUES ('ZZU', 'annual', '2025-06-30', 'USD', 55000e6, 9000e6, 5000e6, 'yahoo-timeseries'),
		       ('ZZF', 'annual', '2025-06-30', 'AUD', 100e6, 5e6, 100e6, 'yahoo-timeseries')`)
	f132Exec(t, pool, `INSERT INTO financial_report_extractions (stock_code, report_url, report_title, report_date, metrics, digest_confidence, document_meta)
		VALUES ('ZZU', 'u-zzu-4e', 'Appendix 4E and Annual Report', '2026-08-19',
		        '{"revenue": {"source_text": "Revenue from ordinary activities 51,262 down 8%", "value_millions": "51262", "period": "FY2026", "alignment": "match_exact", "char_start": "10", "char_end": "60"}}',
		        0.9,
		        '{"currency": "USD", "units": "millions", "units_evidence": "US$ Million", "entity": "ZZU Mining Group Limited", "period_end": "2026-06-30", "period_type": "annual", "report_kind": "appendix_4e"}'),
		       ('ZZF', 'u-zzf-4d', 'Appendix 4D', '2026-02-20',
		        '{"revenue": {"source_text": "Revenue from ordinary activities $60.0 million", "value_millions": "60", "period": "H1 FY2026"}}',
		        0.9,
		        '{"entity": "Winsome Resources Limited", "report_kind": "appendix_4d"}')`)

	stats, err := runFilings(ctx, st, false, func(string, ...any) {})
	require.NoError(t, err)
	assert.Equal(t, 1, stats.Gates[gateForeignEntity], "another company's document is withheld")
	var rev float64
	var cur, doc string
	require.NoError(t, pool.QueryRow(ctx, `SELECT revenue, currency, source_document_url FROM stock_fundamentals
		WHERE stock_code = 'ZZU' AND period_type = 'annual' AND period_end = '2026-06-30'`).Scan(&rev, &cur, &doc))
	assert.Equal(t, 51262e6, rev, "the bare table figure scaled by document_meta.units")
	assert.Equal(t, "USD", cur)
	assert.Equal(t, "u-zzu-4e", doc)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM stock_fundamentals WHERE stock_code = 'ZZF' AND source = 'asx-filing-extraction'`).Scan(&n))
	assert.Zero(t, n)
}
