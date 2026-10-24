package review

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/announcements"
	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

var now = time.Date(2026, 10, 11, 7, 40, 0, 0, time.UTC)

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestEmptyState(t *testing.T) {
	for _, tc := range []struct {
		name     string
		attempts int
		lastRead time.Time
		known    bool
		want     string
	}{
		{"first attempt over a week ago", 1, now.AddDate(0, 0, -8), true, "retry due"},
		{"exactly seven days", 2, now.AddDate(0, 0, -7), true, "retry due"},
		{"second attempt three days ago", 2, now.AddDate(0, 0, -3), true, "next retry from 2026-10-15"},
		{"both retries used", 3, now.AddDate(0, 0, -30), true, "gave up after 3 attempts"},
		{"no attempts column", 1, now.AddDate(0, 0, -30), false, "attempt count unknown (migration 000136 not applied)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := emptyState(tc.attempts, tc.lastRead, now, tc.known); got != tc.want {
				t.Errorf("emptyState = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestEmptyAndUnreadable(t *testing.T) {
	for _, tc := range []struct {
		name              string
		row               extractionRow
		empty, unreadable bool
	}{
		{"no metrics or digest from a document with text", extractionRow{Metrics: []byte("{}"), RawTextLength: new(9997)}, true, false},
		{"text length unknown", extractionRow{Metrics: []byte("{}")}, true, false},
		{"no text layer", extractionRow{Metrics: []byte("{}"), RawTextLength: new(40)}, false, true},
		{"a digest with no confidence", extractionRow{Metrics: []byte("{}"), HasDigest: true, RawTextLength: new(9997)}, true, false},
		{"metrics", extractionRow{Metrics: []byte(`{"revenue": {"source_text": "x"}}`), RawTextLength: new(9997)}, false, false},
		{"a short document with a digest", extractionRow{Metrics: []byte("{}"), HasDigest: true, RawTextLength: new(40)}, false, false},
		{"no metrics and a digest too unsure to use", extractionRow{Metrics: []byte("{}"), HasDigest: true, DigestConfidence: new(0.2), RawTextLength: new(11661)}, true, false},
		{"no metrics and a digest under the latest-filing gate", extractionRow{Metrics: []byte("{}"), HasDigest: true, DigestConfidence: new(0.45), RawTextLength: new(11661)}, true, false},
		{"no metrics and a digest the latest filing shows", extractionRow{Metrics: []byte("{}"), HasDigest: true, DigestConfidence: new(0.6), RawTextLength: new(11661)}, false, false},
		{"a short document with a weak digest", extractionRow{Metrics: []byte("{}"), HasDigest: true, DigestConfidence: new(0.2), RawTextLength: new(40)}, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isEmpty(tc.row); got != tc.empty {
				t.Errorf("isEmpty = %v, want %v", got, tc.empty)
			}
			if got := isUnreadable(tc.row); got != tc.unreadable {
				t.Errorf("isUnreadable = %v, want %v", got, tc.unreadable)
			}
		})
	}
}

func TestWithheldReasons(t *testing.T) {
	grounded := map[string]any{"source_text": "Revenue rose 12% to $1.2bn", "alignment": "match_exact", "value_millions": "1200"}
	echo := map[string]any{"source_text": extractiontrust.NewFewShotTexts[0], "alignment": "match_exact"}
	unaligned := map[string]any{"source_text": "Net profit of $40m", "alignment": "unaligned"}
	results := "Appendix 4D and Half Year Report"
	clean := func() extractionRow {
		return extractionRow{
			Title: results, CompanyName: "DroneShield Limited", HasDigest: true, DigestConfidence: new(0.9),
			Metrics:      mustJSON(t, map[string]any{"revenue": grounded}),
			DocumentMeta: []byte(`{"entity": "DroneShield Limited"}`),
		}
	}
	for _, tc := range []struct {
		name string
		edit func(*extractionRow)
		want []string
	}{
		{"clean", func(*extractionRow) {}, nil},
		{"one few-shot echo in a list", func(r *extractionRow) {
			r.Metrics = mustJSON(t, map[string]any{"revenue": []any{grounded, echo}})
		}, []string{"metrics: 1 of 2 entries dropped by the trust funnel (1 few-shot echo)"}},
		{"every entry ungrounded", func(r *extractionRow) {
			r.Metrics = mustJSON(t, map[string]any{"net_profit": unaligned})
		}, []string{"metrics: 1 of 1 entries dropped by the trust funnel (0 few-shot echo) — none left"}},
		{"digest under the API's gate", func(r *extractionRow) { r.DigestConfidence = new(0.45) },
			[]string{"digest confidence 0.45 is under 0.6: the latest-filing summary skips it"}},
		{"digest under the picks gate too", func(r *extractionRow) { r.DigestConfidence = new(0.2) },
			[]string{"digest confidence 0.20: the latest-filing summary (0.6) and the picks filings (0.3) skip it"}},
		{"another entity's document", func(r *extractionRow) {
			r.DocumentMeta = []byte(`{"entity": "Northern Star Resources Ltd"}`)
		}, []string{`document names "Northern Star Resources Ltd", not DroneShield Limited`}},
		{"not a results document, with no document_meta", func(r *extractionRow) {
			r.Title, r.DocumentMeta = "Investor Presentation", nil
		}, []string{"not a results document to the API (title / report_kind)"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := clean()
			tc.edit(&r)
			got := withheldReasons(r)
			if strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
				t.Errorf("withheldReasons = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNewestResultsDocument(t *testing.T) {
	entry := func(source, typ, title, url, date string) map[string]any {
		return map[string]any{"source": source, "type": typ, "title": title, "url": url, "date": date}
	}
	reports := string(mustJSON(t, []any{
		entry("company_website", "annual_results", "Appendix 4E and Annual Report", "web", "2026-08-20"),
		entry("asx_announcements", "investor_presentation", "Appendix 4E and Annual Report", "type", "2026-08-22"),
		entry("asx_announcements", "annual_results", "FY26 Results Presentation", "pres", "2026-08-21"),
		entry("asx_announcements", "annual_results", "Appendix 4E and Annual Report", "", "2026-08-23"),
		entry("asx_announcements", "half_year_results", "Appendix 4D and Half Year Report", "h1", "2026-02-18"),
		entry("asx_announcements", "annual_results", "Appendix 4E and Annual Report", "fy", "2026-08-19T00:00:00"),
		entry("asx_announcements", "annual_results", "Appendix 4E and Annual Report", "undated", ""),
	}))
	d, ok := newestResultsDocument(reports)
	if !ok || d.URL != "fy" {
		t.Fatalf("newestResultsDocument = %+v, %v; want the 2026-08-19 full year", d, ok)
	}
	for _, bad := range []string{"", "not json", "[]", `{"url": "x"}`} {
		if d, ok := newestResultsDocument(bad); ok {
			t.Errorf("newestResultsDocument(%q) = %+v, want none", bad, d)
		}
	}
}

func TestParseMarketCap(t *testing.T) {
	for _, tc := range []struct {
		in   []string
		want float64
		ok   bool
	}{
		{[]string{""}, 0, false},
		{[]string{"abc"}, 0, false},
		{[]string{"1,234,567"}, 1234567, true},
		{[]string{" 42 "}, 42, true},
		{[]string{"0"}, 0, false},
		{[]string{"-5"}, 0, false},
		{[]string{"NaN"}, 0, false},
		{[]string{"Inf"}, 0, false},
		{[]string{"", "2e11"}, 2e11, true},
	} {
		if got, ok := parseMarketCap(tc.in...); got != tc.want || ok != tc.ok {
			t.Errorf("parseMarketCap(%q) = %v, %v; want %v, %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func company(code, filed, kmCap, colCap string) companyRow {
	return companyRow{
		StockCode: code, CompanyName: code + " Ltd", MarketCapKM: kmCap, MarketCapCol: colCap,
		FinancialReports: `[{"source": "asx_announcements", "type": "annual_results", "title": "Appendix 4E and Annual Report", "url": "` +
			code + `-fy", "date": "` + filed + `"}]`,
	}
}

func TestUnreadResults(t *testing.T) {
	companies := []companyRow{
		company("NOCAP", "2026-08-15", "", ""),
		company("EMPTY", "2026-08-26", "", "3000000000"),
		company("BIG", "2026-08-12", "2.2e11", ""),
		company("PARSED", "2026-08-20", "1e11", ""),
		company("SCAN", "2026-08-20", "5e10", ""),
		company("FRESH", "2026-10-08", "9e11", ""),
		company("OLD", "2026-06-01", "9e11", ""),
	}
	states := map[string]extractionState{
		"PARSED-fy": {Parsed: true, Attempts: 1},
		"SCAN-fy":   {RawTextLength: new(40), Attempts: 1},
		"EMPTY-fy":  {RawTextLength: new(9997), Attempts: 1, ExtractedAt: now.AddDate(0, 0, -30)},
		"OLD-fy":    {},
	}
	var got []string
	for _, g := range unreadResults(companies, states, now, 90, true) {
		got = append(got, g.StockCode+": "+g.State)
	}
	want := []string{"BIG: never read", "SCAN: unreadable (no text layer)", "EMPTY: retry due", "NOCAP: never read"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("unreadResults =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// fakeSource serves fixed rows and records nothing; the SQL is pinned
// separately (TestQueriesAreReadOnly) and run against prod by hand.
type fakeSource struct {
	attempts   bool
	rows       []extractionRow
	companies  []companyRow
	states     map[string]extractionState
	outcomes   []outcomeCount
	failures   []noticeFailure
	statesURLs []string
	estimates  []confirmedEstimateRow
	documents  []announcements.ResultsDocument
	docCodes   []string
}

func (f *fakeSource) ColumnExists(_ context.Context, table, column string) (bool, error) {
	if column == "extraction_attempts" {
		return f.attempts, nil
	}
	return true, nil
}

func (f *fakeSource) Extractions(_ context.Context, _ time.Time, attempts, _ bool) ([]extractionRow, error) {
	rows := append([]extractionRow(nil), f.rows...)
	if !attempts {
		for i := range rows {
			rows[i].Attempts = 1
		}
	}
	return rows, nil
}

func (f *fakeSource) Companies(context.Context) ([]companyRow, error) { return f.companies, nil }

func (f *fakeSource) ExtractionStates(_ context.Context, urls []string, _ bool) (map[string]extractionState, error) {
	f.statesURLs = urls
	return f.states, nil
}

func (f *fakeSource) NoticeOutcomes(context.Context, time.Time, bool) ([]outcomeCount, error) {
	return f.outcomes, nil
}

func (f *fakeSource) NoticeFailures(context.Context, time.Time, bool) ([]noticeFailure, error) {
	return f.failures, nil
}

func (f *fakeSource) ConfirmedEstimates(context.Context) ([]confirmedEstimateRow, error) {
	return f.estimates, nil
}

func (f *fakeSource) EstimateDocuments(_ context.Context, codes []string, _ bool) ([]announcements.ResultsDocument, error) {
	f.docCodes = codes
	return f.documents, nil
}

func fixture() *fakeSource {
	grounded := map[string]any{"source_text": "Revenue rose 12% to $1.2bn", "alignment": "match_exact"}
	metrics, _ := json.Marshal(map[string]any{"revenue": grounded})
	return &fakeSource{
		attempts: true,
		rows: []extractionRow{
			{StockCode: "DRO", URL: "dro-h1", Title: "Appendix 4D and Half Year Report", Metrics: []byte("{}"),
				RawTextLength: new(9997), Attempts: 1, ExtractedAt: now.AddDate(0, 0, -42), ReportDate: new(now.AddDate(0, 0, -46))},
			{StockCode: "SCN", URL: "scn-fy", Title: "Annual Report", Metrics: []byte("{}"), RawTextLength: new(12), Attempts: 1, ExtractedAt: now},
			{StockCode: "FPH", URL: "fph-date", Title: "FPH to announce half year results on 26 November 2026", Metrics: []byte("{}"),
				HasDigest: true, DigestConfidence: new(0.2), RawTextLength: new(1944), Attempts: 1, ExtractedAt: now.AddDate(0, 0, -30)},
			{StockCode: "LOW", URL: "low-fy", Title: "Appendix 4E and Annual Report", Metrics: metrics, HasDigest: true,
				DigestConfidence: new(0.45), RawTextLength: new(30000), Attempts: 1, ExtractedAt: now},
			{StockCode: "OK", URL: "ok-fy", Title: "Appendix 4E and Annual Report", Metrics: metrics, HasDigest: true,
				DigestConfidence: new(0.9), RawTextLength: new(30000), Attempts: 1, ExtractedAt: now},
		},
		companies: []companyRow{company("CBA", "2026-08-12", "", "180000000000"), company("OK", "2026-08-20", "", "")},
		states:    map[string]extractionState{"OK-fy": {Parsed: true, Attempts: 1}},
		outcomes:  []outcomeCount{{Outcome: "parsed", ParserVersion: 1, Total: 158, Recent: 158}, {Outcome: "inconsistent", ParserVersion: 1, Total: 13, Recent: 13}},
		failures: []noticeFailure{
			{StockCode: "MCY", Outcome: "inconsistent", Detail: "parts sum 0.17 != total 0.2", URL: "mcy.pdf", AttemptedAt: now, ParserVersion: 1},
			{StockCode: "DN1", Outcome: "estimated_only", Detail: "ex 2026-10-12; actual amount due 2026-10-19", URL: "dn1.pdf", AttemptedAt: now, ParserVersion: 3},
			{StockCode: "STW", Outcome: "estimated_only", Detail: "ex 2026-09-29; actual amount due 2026-10-08", URL: "stw.pdf", AttemptedAt: now, ParserVersion: 3, Superseded: true},
			{StockCode: "GNE", Outcome: "awaiting_aud_equivalent", Detail: "ex 2026-09-10; AUD equivalent due 2026-10-09", URL: "gne.pdf", AttemptedAt: now.Add(-time.Hour), ParserVersion: 3},
			{StockCode: "SST", Outcome: "awaiting_aud_equivalent", URL: "sst.pdf", AttemptedAt: now, ParserVersion: 2},
		},
	}
}

func TestCollect(t *testing.T) {
	src := fixture()
	rep, err := collect(context.Background(), src, config{days: 90, limit: 25}, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Empty) != 2 || rep.Empty[0].StockCode != "DRO" || rep.Empty[0].State != "retry due" ||
		rep.Empty[1].StockCode != "FPH" || rep.Empty[1].State != notResultsTitle {
		t.Errorf("Empty = %+v", rep.Empty)
	}
	if len(rep.Unreadable) != 1 || rep.Unreadable[0].StockCode != "SCN" {
		t.Errorf("Unreadable = %+v", rep.Unreadable)
	}
	if len(rep.Withheld) != 1 || rep.Withheld[0].StockCode != "LOW" {
		t.Errorf("Withheld = %+v", rep.Withheld)
	}
	if len(rep.Unread) != 1 || rep.Unread[0].StockCode != "CBA" || rep.Unread[0].State != "never read" {
		t.Errorf("Unread = %+v", rep.Unread)
	}
	if strings.Join(src.statesURLs, ",") != "CBA-fy,OK-fy" {
		t.Errorf("states asked for %v, want each company's newest document", src.statesURLs)
	}
	var order []string
	for _, f := range rep.Failures {
		order = append(order, f.StockCode+": "+f.State)
	}
	// Overdue first (GNE, though tried an hour earlier), then the other
	// failures, then a waiting notice recorded before parser 3, then the one
	// still due, then the one another notice stored.
	if want := []string{"GNE: overdue since 2026-10-09", "MCY: ", "SST: no date recorded", "DN1: due 2026-10-19", "STW: stored from a later notice"}; !slices.Equal(order, want) {
		t.Errorf("failures = %q, want %q", order, want)
	}
	if len(rep.Outcomes) != 2 {
		t.Errorf("Outcomes = %+v", rep.Outcomes)
	}

	src.attempts = false
	rep, err = collect(context.Background(), src, config{days: 90, limit: 25}, now)
	if err != nil {
		t.Fatal(err)
	}
	if rep.AttemptsKnown || rep.Empty[0].State != "attempt count unknown (migration 000136 not applied)" {
		t.Errorf("without the attempts column: AttemptsKnown %v, state %q", rep.AttemptsKnown, rep.Empty[0].State)
	}
}

func TestRender(t *testing.T) {
	rep, err := collect(context.Background(), fixture(), config{days: 90, limit: 1}, now)
	if err != nil {
		t.Fatal(err)
	}
	// A second empty extraction: one row past the limit, with no report date
	// and a title that would break the table.
	rep.Empty = append(rep.Empty, emptyRow{extractionRow{StockCode: "XYZ", URL: "xyz", Title: "Half | year\nreport",
		Metrics: []byte("{}"), Attempts: 3, ExtractedAt: now}, "gave up after 3 attempts"})
	rep.Unreadable = nil
	got := render(rep)
	for _, want := range []string{
		"Window: the last 90 days. Each list shows at most 1 rows",
		"### Newest results document not read (1 companies)",
		"| CBA | CBA Ltd | A$180.0bn | 2026-08-12 | [Appendix 4E and Annual Report](CBA-fy) | never read |",
		"### Empty extractions (3: 1 retry due, 0 waiting, 1 gave up, 1 not results documents)",
		"_… 2 more not shown (raise -limit)._",
		"### Unreadable documents (0)\n\nNo text layer (a scanned PDF): never retried.\n\nNone.",
		"digest confidence 0.45 is under 0.6: the latest-filing summary skips it",
		"| parsed | 1 | 158 | 158 |",
		"| Outcome | Parser | All time | Last 90 days |",
		"### Failures in the window (5: 3 to look at, 1 stored from a later notice, 1 waiting for their update)",
		"past that date it needs a look (1 now)",
		"| GNE | awaiting_aud_equivalent | overdue since 2026-10-09 | ex 2026-09-10; AUD equivalent due 2026-10-09 | [notice](gne.pdf) |",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("render output lacks %q\n%s", want, got)
		}
	}

	rep.Limit = 5
	if got := render(rep); !strings.Contains(got, `| XYZ | — | [Half \| year report](xyz) |`) {
		t.Errorf("a NULL report date or a title with | and a newline is not rendered safely:\n%s", got)
	}
}

func TestCellsAndLinks(t *testing.T) {
	if got := cell(" a|b\r\nc "); got != `a\|b c` {
		t.Errorf("cell = %q", got)
	}
	if got := link("", "u"); got != "[untitled](u)" {
		t.Errorf("link with no title = %q", got)
	}
	if got := link("[Draft] "+strings.Repeat("x", 80), "u"); got != "[(Draft) "+strings.Repeat("x", 51)+"…](u)" {
		t.Errorf("link with a long bracketed title = %q", got)
	}
}

// The review states the gates other code enforces. Read those numbers out of
// that code rather than trusting this package's copies.
func TestGatesMatchTheCodeTheyMirror(t *testing.T) {
	for _, tc := range []struct{ file, line string }{
		{"../../../../shorts/internal/services/shorts/latest_filing.go", "latestFilingMinConfidence = " + strconv.FormatFloat(apiMinDigestConfidence, 'f', -1, 64)},
		{"../picks/filings_ingest.go", "const minDigestConfidence = " + strconv.FormatFloat(picksMinDigestConfidence, 'f', -1, 64)},
		{"../../../../report-extractor/extract.py", "MIN_PDF_TEXT_CHARS = " + strconv.Itoa(minTextChars)},
		{"../../../../report-extractor/extract.py", "EMPTY_RETRY_LIMIT = " + strconv.Itoa(emptyRetryLimit)},
		{"../../../../report-extractor/extract.py", "EMPTY_RETRY_MIN_DAYS = " + strconv.Itoa(emptyRetryMinDays)},
		{"../../../../report-extractor/extract.py", "EMPTY_RETRY_MAX_PAGES = " + strconv.Itoa(emptyRetryMaxPages)},
		{"../../../../report-extractor/extract.py", "USABLE_DIGEST_MIN_CONFIDENCE = " + strconv.FormatFloat(apiMinDigestConfidence, 'f', -1, 64)},
		// The outcomes the pass never reads again, no_text aside (it has its
		// own 7-day retry), are the ones the review does not list as failures.
		{"../announcements/dividend_pass.go", "t.outcome NOT IN ('parsed', 'cancellation', 'scrip_only', 'no_text')"},
		{"source.go", "a.outcome NOT IN ('parsed', 'cancellation', 'scrip_only')"},
	} {
		b, err := os.ReadFile(tc.file)
		if err != nil {
			t.Fatalf("read %s: %v", tc.file, err)
		}
		if !strings.Contains(string(b), tc.line) {
			t.Errorf("%s no longer says %q: update the review's copy", tc.file, tc.line)
		}
	}
}

func TestQueriesAreReadOnly(t *testing.T) {
	write := regexp.MustCompile(`\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|TRUNCATE|GRANT|COPY|CALL)\b`)
	if len(queries) != 8 {
		t.Fatalf("queries lists %d statements; add every new one", len(queries))
	}
	for _, q := range queries {
		if m := write.FindString(strings.ToUpper(q)); m != "" {
			t.Errorf("a review query uses %s:\n%s", m, q)
		}
	}
}

func TestNoticeState(t *testing.T) {
	waiting := func(outcome, detail string) noticeFailure { return noticeFailure{Outcome: outcome, Detail: detail} }
	for _, tc := range []struct {
		name string
		f    noticeFailure
		want string
	}{
		{"stored by its update", noticeFailure{Outcome: "estimated_only", Detail: "ex 2026-09-29; actual amount due 2026-10-08", Superseded: true}, "stored from a later notice"},
		{"due later", waiting("estimated_only", "ex 2026-10-12; actual amount due 2026-10-19"), "due 2026-10-19"},
		{"due today is not overdue", waiting("awaiting_aud_equivalent", "ex 2026-10-01; AUD equivalent due 2026-10-11"), "due 2026-10-11"},
		{"past its date", waiting("awaiting_aud_equivalent", "ex 2026-09-10; AUD equivalent due 2026-10-10"), "overdue since 2026-10-10"},
		{"before parser 3", waiting("estimated_only", ""), "no date recorded"},
		{"a notice with no date", waiting("estimated_only", "ex 2026-10-12"), "no date recorded"},
		{"any other failure", waiting("code_mismatch", "notice is for AMI, listed under YTC"), ""},
	} {
		if got := noticeState(tc.f, now); got != tc.want {
			t.Errorf("%s: noticeState = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// gmgEstimate is GMG's notice of 2026-06-16 as parser 6 stored it: AUD 0.15,
// unfranked, confirmed by its Appendix 4E 03127287.
func gmgEstimate() confirmedEstimateRow {
	return confirmedEstimateRow{
		AttemptCode: "GMG", URL: gmgNotice, AttemptedAt: now,
		Detail:    "1 rows; estimate confirmed by " + gmgFourE + "; actual amount due 2026-08-20",
		StockCode: "GMG", ExDate: "2026-06-29", PeriodEnd: "2026-06-30", RecordDate: "2026-06-30", PayDate: "2026-08-26",
		Type: "ordinary", Currency: "AUD", Amount: new(0.15), FrankedPct: new(0.0), AnnouncedOn: "2026-06-16",
	}
}

const (
	gmgNotice = "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03104557"
	gmgFourE  = "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03127287"
)

// gmgDocument is GMG's 4E as prod stores it (the announcements pass's fixture).
func gmgDocument(t *testing.T) announcements.ResultsDocument {
	t.Helper()
	b, err := os.ReadFile("../announcements/testdata/results_documents/gmg_03127287.json")
	if err != nil {
		t.Fatal(err)
	}
	var d announcements.ResultsDocument
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

// A stored estimate is listed with the document and the quote that confirm
// it, checked again with the pass's rule; one whose documents no longer
// confirm it says why, and one a later notice replaced says so.
func TestEstimateStates(t *testing.T) {
	doc := gmgDocument(t)
	withdrawn := doc
	withdrawn.Dividend = json.RawMessage(`[{"unit": "cents", "consensus": "agree", "source_text": "Interim distribution per GMG security (cents)\n15.0", "value_cents": "15"}]`)
	replaced := gmgEstimate()
	replaced.URL = "https://notice/replaced"
	replaced.StockCode, replaced.ExDate, replaced.Amount, replaced.FrankedPct = "", "", nil, nil
	garbled := gmgEstimate()
	garbled.URL, garbled.Detail = "https://notice/garbled", "1 rows; estimate confirmed by"

	for _, tc := range []struct {
		name   string
		rows   []confirmedEstimateRow
		docs   []announcements.ResultsDocument
		state  string
		quotes []string
		docsAt []string
	}{
		{"GMG, confirmed by its 4E", []confirmedEstimateRow{gmgEstimate()}, []announcements.ResultsDocument{doc}, "confirmed",
			[]string{"Final dividend and distribution proposed per GMG security (cents)\n15.0"}, []string{gmgFourE}},
		{"its 4E re-extracted without the final", []confirmedEstimateRow{gmgEstimate()}, []announcements.ResultsDocument{withdrawn},
			"no longer confirmed: no agreed entry in a results document names the ordinary distribution for the period ending 2026-06-30", nil, []string{gmgFourE}},
		{"its 4E gone", []confirmedEstimateRow{gmgEstimate()}, nil,
			"no longer confirmed: no document of GMG states period end 2026-06-30 and was filed from 2026-08-20 to 2026-10-31", nil, []string{gmgFourE}},
		{"its row replaced by a later notice", []confirmedEstimateRow{replaced}, []announcements.ResultsDocument{doc}, "replaced by a later notice", nil, []string{gmgFourE}},
		{"a detail the review cannot read", []confirmedEstimateRow{garbled}, []announcements.ResultsDocument{doc},
			"no longer confirmed: its detail names no document and no due date", nil, nil},
	} {
		got := estimateStates(tc.rows, tc.docs)
		if len(got) != 1 {
			t.Fatalf("%s: %d estimates, want 1", tc.name, len(got))
		}
		if e := got[0]; e.State != tc.state || !slices.Equal(e.Quotes, tc.quotes) || !slices.Equal(e.Documents, tc.docsAt) {
			t.Errorf("%s: state %q, quotes %q, documents %q\nwant %q, %q, %q", tc.name, e.State, e.Quotes, e.Documents, tc.state, tc.quotes, tc.docsAt)
		}
	}
}

func TestCollectAndRenderStoredEstimates(t *testing.T) {
	src := fixture()
	replaced := gmgEstimate()
	replaced.URL, replaced.AttemptCode = "https://notice/replaced", "LRT"
	replaced.StockCode, replaced.ExDate, replaced.Amount, replaced.FrankedPct = "", "", nil, nil
	// A row its 4E no longer confirms: stored at 0.16, the 4E states 15.0c.
	stale := gmgEstimate()
	stale.URL, stale.Amount = "https://notice/stale", new(0.16)
	src.estimates = []confirmedEstimateRow{gmgEstimate(), replaced, stale}
	src.documents = []announcements.ResultsDocument{gmgDocument(t)}
	rep, err := collect(context.Background(), src, config{days: 90, limit: 25}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(src.docCodes, []string{"GMG"}) {
		t.Errorf("documents asked for %q, want the stored rows' codes", src.docCodes)
	}
	if len(rep.Estimates) != 3 || rep.Estimates[0].State != "confirmed" || rep.Estimates[1].State != "replaced by a later notice" ||
		!strings.HasPrefix(rep.Estimates[2].State, "no longer confirmed: ") {
		t.Fatalf("estimates = %+v", rep.Estimates)
	}
	got := render(rep)
	for _, want := range []string{
		"### Estimates stored from a results document (3: 1 no longer confirmed, 1 replaced by a later notice)",
		"| Code | Ex-date | Amount | Notice | Document | Quote | State |",
		"| GMG | 2026-06-29 | AUD 0.15 ordinary, 0% franked | [notice](" + gmgNotice + ") | [document](" + gmgFourE +
			") | Final dividend and distribution proposed per GMG security (cents) 15.0 | confirmed |",
		"| LRT | — |  | [notice](https://notice/replaced) | [document](" + gmgFourE + ") |  | replaced by a later notice |",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("render output lacks %q\n%s", want, got)
		}
	}
}
