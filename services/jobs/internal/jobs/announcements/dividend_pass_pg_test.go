package announcements

// The parser 6 statements against a real Postgres: the evidence an estimate's
// confirmation reads (EstimateEvidence), the confirmed-estimate upsert's guard
// and the re-read trigger. A string check cannot tell ">= $3::date" from ">",
// or notice a dropped "a.pdf_url <> $1"; running them can.
//
// Skipped unless ANNOUNCEMENTS_TEST_DATABASE_URL is set (CI has no database
// for this package). A local database only, never prod: this creates and
// drops a schema.
//
//	docker run -d --rm --name announcements-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:5499:5432 postgres:16-alpine
//	ANNOUNCEMENTS_TEST_DATABASE_URL='postgres://postgres:pw@127.0.0.1:5499/postgres?sslmode=disable' \
//	  GOWORK=off go test ./internal/jobs/announcements/ -run AgainstPostgres
//
// The schema is built from the migrations that shape these tables (000017,
// 000025, 000045, 000133, 000134), plus 000132's document_meta column and the
// two "company-metadata" columns the documents query reads. The pool is the
// job's own (platform.Connect: the simple protocol prod's pooler needs).

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
)

func dividendTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("ANNOUNCEMENTS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set ANNOUNCEMENTS_TEST_DATABASE_URL (a local database, never prod) to run the dividend notice SQL against Postgres")
	}
	for _, banned := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(dsn, banned) {
			t.Fatalf("ANNOUNCEMENTS_TEST_DATABASE_URL looks like a shared database (%q): this test creates and drops a schema", banned)
		}
	}
	ctx := context.Background()
	schema := fmt.Sprintf("dividend_notices_test_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))
	admin, err := platform.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("schema %s left behind: %v", schema, err)
		}
		admin.Close()
	})
	pool, err := platform.Connect(ctx, dsn, platform.PoolOption(func(cfg *pgxpool.Config) {
		cfg.ConnConfig.RuntimeParams["search_path"] = schema
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	for _, name := range []string{
		"000017_add_asx_announcements.up.sql",
		"000025_add_dividend_history.up.sql",
		"000045_formalize_financial_report_extractions.up.sql",
		"000133_add_dividend_notices.up.sql",
		"000134_dividend_notice_parser_version.up.sql",
	} {
		b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, string(b)); err != nil {
			t.Fatalf("applying %s: %v", name, err)
		}
	}
	if _, err := pool.Exec(ctx, `
		ALTER TABLE financial_report_extractions ADD COLUMN IF NOT EXISTS document_meta JSONB;
		CREATE TABLE "company-metadata" (stock_code VARCHAR(50) UNIQUE, company_name TEXT);`); err != nil {
		t.Fatal(err)
	}
	return pool
}

// dividendTestExec runs each statement, failing the test on the first error.
func dividendTestExec(t *testing.T, pool *pgxpool.Pool, statements ...string) {
	t.Helper()
	for _, s := range statements {
		if _, err := pool.Exec(context.Background(), s); err != nil {
			t.Fatalf("%v\n%s", err, s)
		}
	}
}

// PCI's September 2026 distribution, as prod holds its notices: an estimate
// (03143304) and an update that is still an estimate (03143500), both lodged
// 2026-09-24, ex 2026-09-29, for the month ending 2026-09-30; around them, the
// notices EstimateEvidence must and must not return.
func TestEstimateEvidenceAgainstPostgres(t *testing.T) {
	pool := dividendTestDB(t)
	ctx := context.Background()
	url := func(ids string) string { return asxAnnouncement + ids }
	listed := func(code, day, headline, ids string) string {
		return fmt.Sprintf(`INSERT INTO asx_announcements (stock_code, announcement_date, headline, pdf_url) VALUES ('%s', '%s', '%s', '%s')`,
			code, day, headline, url(ids))
	}
	attempt := func(ids, outcome, detail string) string {
		return fmt.Sprintf(`INSERT INTO dividend_notice_attempts (announcement_url, stock_code, outcome, detail, parser_version) VALUES ('%s', 'PCI', '%s', '%s', 6)`,
			url(ids), outcome, detail)
	}
	row := func(code, exDate, periodEnd, typ, ids string) string {
		return fmt.Sprintf(`INSERT INTO dividend_history (stock_code, ex_date, period_end, amount_per_share, dividend_type, announcement_url, announced_on)
			VALUES ('%s', '%s', NULLIF('%s', '')::date, 0.0075, '%s', '%s', '2026-09-01')`, code, exDate, periodEnd, typ, url(ids))
	}
	dividendTestExec(t, pool,
		listed("PCI", "2026-09-24", "Dividend/Distribution - PCI", "03143304"),                // the estimate: never its own later notice
		listed("PCI", "2026-09-24", "Update - Dividend/Distribution - PCI", "03143500"),       // the same day: returned, lodgedAfter orders it
		listed("PCI", "2026-09-24", "Cancellation - Dividend/Distribution - PCI", "03143200"), // the same day, an earlier idsId: returned too
		listed("PCI", "2026-08-20", "Dividend/Distribution - PCI", "03129669"),                // the day before: never
		listed("PCI", "2026-09-25", "Dividend/Distribution - PCIHA", "03144000"),              // listed under PCI, its row under PCIHA: not PCI's dividend
		listed("PCI", "2026-09-28", "Update - Dividend/Distribution - PCI", "03145000"),       // stored the dividend under its ex-date
		listed("PCI", "2026-10-01", "Update - Dividend/Distribution - PCI", "03147347"),       // stored it under a moved ex-date
		listed("PCIHA", "2026-10-03", "Update - Dividend/Distribution - PCIHA", "03147347"),
		listed("PCI", "2026-10-02", "Dividend/Distribution - PCI", "03147400"),     // stored the month's special
		listed("PCI", "2026-10-20", "Dividend/Distribution - PCI", "03150000"),     // stored October's
		listed("PCI", "2026-10-21", "Dividend/Distribution - PCI", "03150100"),     // stored a special under October's ex-date
		listed("PCIHA", "2026-10-01", "Dividend/Distribution - PCIHA", "03147500"), // a code that shares PCI's first three characters
		listed("PCX", "2026-10-01", "Dividend/Distribution - PCX", "03147600"),     // another issuer
		listed("PCI", "2026-10-01", "Monthly Report", "03147700"),                  // not a dividend notice
		listed("PCI", "2026-09-10", "Dividend/Distribution - PCI", "03140000"),     // an earlier confirmed estimate's notice
		attempt("03143304", "estimated_only", "ex 2026-09-29; actual amount due 2026-10-15"),
		attempt("03143500", "estimated_only", "ex 2026-09-29; actual amount due 2026-10-15"),
		attempt("03144000", "parsed", "1 rows"),
		attempt("03145000", "parsed", "1 rows"),
		attempt("03147347", "parsed", "1 rows"),
		attempt("03147400", "parsed", "1 rows"),
		attempt("03150000", "parsed", "1 rows"),
		attempt("03150100", "parsed", "1 rows"),
		attempt("03140000", "parsed", "1 rows; estimate confirmed by "+url("03130000")+"; actual amount due 2026-09-15"),
		row("PCI", "2026-09-29", "", "ordinary", "03145000"),
		row("PCIHA", "2026-09-29", "2026-09-30", "ordinary", "03144000"),
		row("PCI", "2026-09-29", "2026-09-30", "special", "03140000"),
		row("PCI", "2026-10-01", "2026-09-30", "ordinary", "03147347"),
		row("PCI", "2026-10-02", "2026-09-30", "special", "03147400"),
		row("PCI", "2026-10-29", "2026-10-31", "ordinary", "03150000"),
		row("PCI", "2026-10-29", "", "special", "03150100"),
		row("PCX", "2026-09-29", "2026-09-30", "ordinary", "03147600"),
		`INSERT INTO "company-metadata" (stock_code, company_name) VALUES ('PCI', 'Perpetual Credit Income Trust')`,
		`INSERT INTO financial_report_extractions (stock_code, report_url, report_title, report_date, metrics, document_meta) VALUES
			('PCI', 'https://example.com/pci-4d.pdf', 'Half Year Report', '2026-08-20',
			 '{"dividend": [{"unit": "cents", "consensus": "agree", "source_text": "Distribution for June 2026 0.75", "value_cents": "0.75"}]}',
			 '{"period_end": "2026-06-30", "period_type": "half"}'),
			('PCI', 'https://example.com/pci-results.pdf', 'Results', '2026-08-20', '{"revenue": {}}', NULL),
			('PCIHA', 'https://example.com/pciha-4d.pdf', 'Half Year Report', '2026-08-20',
			 '{"dividend": [{"unit": "cents", "consensus": "agree", "source_text": "Distribution 1.5", "value_cents": "1.5"}]}', NULL)`,
	)

	n := DividendNotice{SecurityCode: "PCI", ExDate: "2026-09-29", PeriodEnd: "2026-09-30", Parts: []DividendPart{{Type: "ordinary"}}}
	p := pendingNotice{StockCode: "PCI", AnnouncementDate: "2026-09-24", URL: url("03143304")}
	ev, err := (&postgresDividendNoticeStore{db: pool}).EstimateEvidence(ctx, n, p)
	if err != nil {
		t.Fatal(err)
	}

	// Every other dividend notice of a PCI code from the estimate's day on,
	// the same day's included, with its latest announcement date; whether it
	// stored the dividend for PCI (never another code's row) under the
	// ex-date, or for the period with the estimate's type.
	wantLater := []laterNotice{
		{URL: url("03143200"), AnnouncedOn: "2026-09-24"},
		{URL: url("03143500"), AnnouncedOn: "2026-09-24", Outcome: "estimated_only", Detail: "ex 2026-09-29; actual amount due 2026-10-15"},
		{URL: url("03144000"), AnnouncedOn: "2026-09-25", Outcome: "parsed", Detail: "1 rows"},
		{URL: url("03145000"), AnnouncedOn: "2026-09-28", Outcome: "parsed", Detail: "1 rows", StoredDividend: true},
		{URL: url("03147347"), AnnouncedOn: "2026-10-03", Outcome: "parsed", Detail: "1 rows", StoredDividend: true},
		{URL: url("03147400"), AnnouncedOn: "2026-10-02", Outcome: "parsed", Detail: "1 rows"},
		{URL: url("03147500"), AnnouncedOn: "2026-10-01"},
		{URL: url("03150000"), AnnouncedOn: "2026-10-20", Outcome: "parsed", Detail: "1 rows"},
		{URL: url("03150100"), AnnouncedOn: "2026-10-21", Outcome: "parsed", Detail: "1 rows"},
	}
	if !reflect.DeepEqual(ev.Later, wantLater) {
		t.Errorf("later notices\n got %+v\nwant %+v", ev.Later, wantLater)
	}

	// A row under the ex-date stores the dividend whatever its type: an
	// ex-date is one dividend's, while a period end two distributions may
	// share. PCI's October estimate, and a later notice that stored only a
	// special under its ex-date.
	october := DividendNotice{SecurityCode: "PCI", ExDate: "2026-10-29", PeriodEnd: "2026-10-31", Parts: []DividendPart{{Type: "ordinary"}}}
	evOctober, err := (&postgresDividendNoticeStore{db: pool}).EstimateEvidence(ctx, october,
		pendingNotice{StockCode: "PCI", AnnouncementDate: "2026-10-15", URL: url("03149000")})
	if err != nil {
		t.Fatal(err)
	}
	wantOctober := []laterNotice{
		{URL: url("03150000"), AnnouncedOn: "2026-10-20", Outcome: "parsed", Detail: "1 rows", StoredDividend: true},
		{URL: url("03150100"), AnnouncedOn: "2026-10-21", Outcome: "parsed", Detail: "1 rows", StoredDividend: true},
	}
	if !reflect.DeepEqual(evOctober.Later, wantOctober) {
		t.Errorf("October's later notices\n got %+v\nwant %+v", evOctober.Later, wantOctober)
	}

	// The rows for PCI under the ex-date, or for the period under another;
	// never another period's, nor another code's.
	wantStored := []storedDividend{
		{Type: "ordinary", ExDate: "2026-09-29", AnnouncementURL: url("03145000"), AnnouncedOn: "2026-09-01"},
		{Type: "special", ExDate: "2026-09-29", AnnouncementURL: url("03140000"), AnnouncedOn: "2026-09-01", ConfirmedEstimate: true},
		{Type: "ordinary", ExDate: "2026-10-01", AnnouncementURL: url("03147347"), AnnouncedOn: "2026-09-01"},
		{Type: "special", ExDate: "2026-10-02", AnnouncementURL: url("03147400"), AnnouncedOn: "2026-09-01"},
	}
	if !reflect.DeepEqual(ev.Stored, wantStored) {
		t.Errorf("stored rows\n got %+v\nwant %+v", ev.Stored, wantStored)
	}

	// PCI's own extractions with a dividend class, as stored.
	if len(ev.Documents) != 1 {
		t.Fatalf("documents %+v, want PCI's one with a dividend", ev.Documents)
	}
	d := ev.Documents[0]
	var meta, dividend any
	if err := json.Unmarshal(d.DocumentMeta, &meta); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(d.Dividend, &dividend); err != nil {
		t.Fatal(err)
	}
	wantMeta := map[string]any{"period_end": "2026-06-30", "period_type": "half"}
	wantDividend := []any{map[string]any{"unit": "cents", "consensus": "agree", "source_text": "Distribution for June 2026 0.75", "value_cents": "0.75"}}
	if d.StockCode != "PCI" || d.URL != "https://example.com/pci-4d.pdf" || d.Title != "Half Year Report" || d.ReportDate != "2026-08-20" ||
		d.CompanyName != "Perpetual Credit Income Trust" || !reflect.DeepEqual(meta, wantMeta) || !reflect.DeepEqual(dividend, wantDividend) {
		t.Errorf("document %+v (meta %v, dividend %v)", d, meta, dividend)
	}

	// What the pass makes of it: the estimate waits on its same-day update,
	// and the update on the notice that stored the dividend after it.
	if _, _, why := confirmEstimatedNotice(withFranking(n), p, ev); why != "later notice 03143500 is estimated_only for the same ex-date" {
		t.Errorf("the estimate: %q", why)
	}
	p.URL = url("03143500")
	evUpdate, err := (&postgresDividendNoticeStore{db: pool}).EstimateEvidence(ctx, n, p)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, why := confirmEstimatedNotice(withFranking(n), p, evUpdate); why != "later notice 03145000 stored the same dividend" {
		t.Errorf("the update: %q", why)
	}
}

// withFranking is n as an estimate the confirmation reads: AUD, unfranked,
// its actual amount due 2026-10-15.
func withFranking(n DividendNotice) DividendNotice {
	zero := 0.0
	n.Currency, n.ActualDue = "AUD", "2026-10-15"
	n.Parts = []DividendPart{{Type: "ordinary", Amount: 0.0075, Estimated: true, FrankedPct: &zero}}
	return n
}

// The confirmed-estimate upsert replaces the notice's own row or a confirmed
// estimate from an earlier day, and nothing else; the declared upsert
// replaces a confirmed estimate with an update of the same day or later.
func TestConfirmedEstimateUpsertAgainstPostgres(t *testing.T) {
	pool := dividendTestDB(t)
	ctx := context.Background()
	store := &postgresDividendNoticeStore{db: pool}
	zero := 0.0
	gmgRow := func(exDate, ids, announcedOn string) dividendRow {
		return dividendRow{StockCode: "GMG", ExDate: exDate, PeriodEnd: "2026-06-30", AmountAUD: 0.15, FrankedPct: &zero, Type: "ordinary",
			DeclaredCurrency: "AUD", DeclaredAmount: 0.15, AnnouncementURL: asxAnnouncement + ids, AnnouncedOn: announcedOn}
	}
	confirmed := func(ids string) string {
		return fmt.Sprintf(`INSERT INTO dividend_notice_attempts (announcement_url, stock_code, outcome, detail, parser_version)
			VALUES ('%s', 'GMG', 'parsed', '1 rows; estimate confirmed by %s; actual amount due 2026-08-20', 6)`, asxAnnouncement+ids, asxAnnouncement+"03127287")
	}
	declared := func(ids string) string {
		return fmt.Sprintf(`INSERT INTO dividend_notice_attempts (announcement_url, stock_code, outcome, detail, parser_version)
			VALUES ('%s', 'GMG', 'parsed', '1 rows', 6)`, asxAnnouncement+ids)
	}
	for _, tc := range []struct {
		name     string
		existing *dividendRow // stored first, through UpsertDividends
		attempt  func(string) string
		upsert   func(context.Context, []dividendRow) (int, error)
		row      dividendRow
		want     int
	}{
		{"no row yet", nil, nil, store.UpsertConfirmedEstimates, gmgRow("2026-06-29", "03104557", "2026-06-16"), 1},
		{"its own row", new(gmgRow("2026-07-29", "03104557", "2026-06-16")), confirmed, store.UpsertConfirmedEstimates, gmgRow("2026-07-29", "03104557", "2026-06-16"), 1},
		{"a confirmed estimate of an earlier day", new(gmgRow("2026-08-29", "03100001", "2026-06-01")), confirmed, store.UpsertConfirmedEstimates, gmgRow("2026-08-29", "03104557", "2026-06-16"), 1},
		{"a confirmed estimate of the same day", new(gmgRow("2026-09-29", "03100002", "2026-06-16")), confirmed, store.UpsertConfirmedEstimates, gmgRow("2026-09-29", "03104557", "2026-06-16"), 0},
		{"a declared row of an earlier day", new(gmgRow("2026-10-29", "03100003", "2026-06-01")), declared, store.UpsertConfirmedEstimates, gmgRow("2026-10-29", "03104557", "2026-06-16"), 0},
		{"a declared row with no announced_on", new(gmgRow("2026-11-29", "03100004", "")), declared, store.UpsertConfirmedEstimates, gmgRow("2026-11-29", "03104557", "2026-06-16"), 0},
		{"a declared row of a later day", new(gmgRow("2026-12-29", "03100005", "2026-07-01")), declared, store.UpsertConfirmedEstimates, gmgRow("2026-12-29", "03104557", "2026-06-16"), 0},
		{"an update of the same day replaces a confirmed estimate", new(gmgRow("2027-01-29", "03100006", "2026-06-16")), confirmed, store.UpsertDividends, gmgRow("2027-01-29", "03104558", "2026-06-16"), 1},
		{"an update of an earlier day does not", new(gmgRow("2027-02-26", "03100007", "2026-06-16")), confirmed, store.UpsertDividends, gmgRow("2027-02-26", "03100000", "2026-06-01"), 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.existing != nil {
				if _, err := store.UpsertDividends(ctx, []dividendRow{*tc.existing}); err != nil {
					t.Fatal(err)
				}
				if tc.attempt != nil && tc.existing.AnnouncementURL != tc.row.AnnouncementURL {
					dividendTestExec(t, pool, tc.attempt(strings.TrimPrefix(tc.existing.AnnouncementURL, asxAnnouncement)))
				}
			}
			got, err := tc.upsert(ctx, []dividendRow{tc.row})
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Errorf("rows written %d, want %d", got, tc.want)
			}
			var stored string
			if err := pool.QueryRow(ctx, `SELECT announcement_url FROM dividend_history WHERE stock_code = 'GMG' AND ex_date = $1::date AND dividend_type = 'ordinary'`,
				tc.row.ExDate).Scan(&stored); err != nil {
				t.Fatal(err)
			}
			want := tc.row.AnnouncementURL
			if tc.want == 0 {
				want = tc.existing.AnnouncementURL // kept
			}
			if stored != want {
				t.Errorf("row now from %s, want %s", stored, want)
			}
		})
	}
}

// An estimated_only notice is read again once its due date has passed and an
// extraction of its listing code with a dividend and a period end has been
// made since its attempt; a detail with no due date never is. GMG's: its
// attempt (2026-10-12 11:29 UTC) is later than its 4E's extraction
// (2026-10-11 14:12 UTC), so only the bump re-reads it.
func TestEstimatedOnlyNoticesAreReadAgainAgainstPostgres(t *testing.T) {
	pool := dividendTestDB(t)
	ctx := context.Background()
	store := &postgresDividendNoticeStore{db: pool}
	dividendTestExec(t, pool,
		`INSERT INTO asx_announcements (stock_code, announcement_date, headline, pdf_url) VALUES
			('GMG', '2026-06-16', 'Dividend/Distribution - GMG', '`+asxAnnouncement+`03104557'),
			('GMG', '2025-06-24', 'Dividend/Distribution - GMG', '`+asxAnnouncement+`02960000')`,
		`INSERT INTO dividend_notice_attempts (announcement_url, stock_code, outcome, detail, parser_version, attempted_at) VALUES
			('`+asxAnnouncement+`03104557', 'GMG', 'estimated_only', 'ex 2026-06-29; actual amount due 2026-08-20', 6, '2026-10-12 11:29:00+00'),
			('`+asxAnnouncement+`02960000', 'GMG', 'estimated_only', 'ex 2025-06-27', 6, '2025-07-01 00:00:00+00')`,
		`INSERT INTO financial_report_extractions (stock_code, report_url, report_date, metrics, document_meta, extracted_at) VALUES
			('GMG', '`+asxAnnouncement+`03127287', '2026-08-20', '{"dividend": []}', '{"period_end": "2026-06-30"}', '2026-10-11 14:12:00+00')`,
	)
	pending := func(version int) []string {
		t.Helper()
		got, err := store.PendingDividendNotices(ctx, 10, version)
		if err != nil {
			t.Fatal(err)
		}
		var urls []string
		for _, p := range got {
			urls = append(urls, strings.TrimPrefix(p.URL, asxAnnouncement))
		}
		return urls
	}
	if got := pending(6); len(got) != 0 {
		t.Errorf("at version 6 with no newer extraction: %v, want none", got)
	}
	if got := pending(7); !reflect.DeepEqual(got, []string{"03104557", "02960000"}) {
		t.Errorf("at version 7: %v, want both (a bump re-reads every failure)", got)
	}
	// A newer extraction of another code, one that shares GMG's first three
	// characters, with a dividend and a period end: not GMG's.
	dividendTestExec(t, pool, `INSERT INTO financial_report_extractions (stock_code, report_url, report_date, metrics, document_meta, extracted_at) VALUES
		('GMGO', 'https://example.com/gmgo-4e.pdf', '2026-08-20', '{"dividend": []}', '{"period_end": "2026-06-30"}', '2026-10-12 12:00:00+00')`)
	if got := pending(6); len(got) != 0 {
		t.Errorf("at version 6 after another code's newer extraction: %v, want none", got)
	}
	// GMG extractions that confirm nothing new: one made the moment of the
	// attempt, a newer one with no dividend, a newer one with no period end.
	// And an estimate of GMG's whose actual amount is due today, not before.
	for _, tc := range []struct{ name, statement string }{
		{"an extraction as old as the attempt", `INSERT INTO financial_report_extractions (stock_code, report_url, report_date, metrics, document_meta, extracted_at) VALUES
			('GMG', 'https://example.com/gmg-same-time.pdf', '2026-08-20', '{"dividend": []}', '{"period_end": "2026-06-30"}', '2026-10-12 11:29:00+00')`},
		{"a newer extraction with no dividend", `INSERT INTO financial_report_extractions (stock_code, report_url, report_date, metrics, document_meta, extracted_at) VALUES
			('GMG', 'https://example.com/gmg-no-dividend.pdf', '2026-08-20', '{"revenue": {}}', '{"period_end": "2026-06-30"}', '2026-10-12 12:00:00+00')`},
		{"a newer extraction with no period end", `INSERT INTO financial_report_extractions (stock_code, report_url, report_date, metrics, document_meta, extracted_at) VALUES
			('GMG', 'https://example.com/gmg-no-period.pdf', '2026-08-20', '{"dividend": []}', '{"period_type": "annual"}', '2026-10-12 12:00:00+00')`},
	} {
		dividendTestExec(t, pool, tc.statement)
		if got := pending(6); len(got) != 0 {
			t.Errorf("at version 6 after %s: %v, want none", tc.name, got)
		}
	}
	dividendTestExec(t, pool,
		`INSERT INTO asx_announcements (stock_code, announcement_date, headline, pdf_url) VALUES
			('GMG', '2026-09-30', 'Dividend/Distribution - GMG', '`+asxAnnouncement+`03144444')`,
		`INSERT INTO dividend_notice_attempts (announcement_url, stock_code, outcome, detail, parser_version, attempted_at) VALUES
			('`+asxAnnouncement+`03144444', 'GMG', 'estimated_only', 'ex 2026-12-30; actual amount due ' || to_char(current_date, 'YYYY-MM-DD'), 6, '2026-10-12 11:29:00+00')`)
	// A newer extraction of GMG with a dividend and a period end.
	dividendTestExec(t, pool, `INSERT INTO financial_report_extractions (stock_code, report_url, report_date, metrics, document_meta, extracted_at) VALUES
		('GMG', 'https://example.com/gmg-annual-report.pdf', '2026-09-16', '{"dividend": []}', '{"period_end": "2026-06-30"}', '2026-10-12 12:00:00+00')`)
	if got := pending(6); !reflect.DeepEqual(got, []string{"03104557"}) {
		t.Errorf("at version 6 after a newer extraction: %v, want GMG's 2026 estimate only (one has no due date, one is due today)", got)
	}
}
