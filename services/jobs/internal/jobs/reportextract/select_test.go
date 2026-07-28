package reportextract

import (
	"reflect"
	"strings"
	"testing"
)

// §6.3(a) The noise filter decides what the paid Gemini pipeline is spent on, so
// every pattern family (and the keep-override that beats them) is pinned.
func TestIsFinancialReportTitle(t *testing.T) {
	keep := []string{
		"",
		"   ",
		"Appendix 4E Full Year Results",
		"Appendix 4D Half Year Report",
		"Preliminary Final Report",
		"Annual Report 2025",
		"Half Year Financial Report",
		"Interim Financial Statements",
		"Financial Report for the year ended 30 June 2025",
		"Results Announcement",
		"FY25 Results Presentation",
		"Investor Presentation",
		// Keep-override beats a noise substring in the same headline.
		"Appendix 4E Full Year Results — Media Release",
		"Annual Report and Chairman's Letter",
	}
	for _, title := range keep {
		if !isFinancialReportTitle(title) {
			t.Errorf("want KEEP, got drop: %q", title)
		}
	}

	drop := []string{
		"Half Year Results Media Release",
		"FY25 Media Announcement",
		"Letter to Shareholders",
		"Letter to Securityholders",
		"Letter to Security Holders",
		"Chairman's Letter",
		"Chairperson Letter",
		"CEO's Letter",
		"Letter from the Chair",
		"Chairman's Address",
		"CEO Address to the AGM",
		"Address to Shareholders",
		"AGM Address",
		"Notice of Annual General Meeting",
		"Notice of Meeting",
		"Notice of AGM",
		"Proxy Form",
		"Cleansing Notice",
		"Cleansing Statement",
		"Trading Halt",
		"Suspension from Quotation",
		"Suspension of Trading",
		"Appendix 3Y - Change of Director's Interest Notice",
		"Appendix 3X Initial Director's Interest Notice",
		"Appendix 3Z Final Director's Interest Notice",
		"Change of Director's Interest Notice",
		"Change in Directors Interest",
		"Directors Interest Notice",
		"Becoming a substantial holder",
		"Ceasing to be a substantial holder",
		"Change in substantial holding",
		"Substantial Holder Notice",
		"On-Market Buy-Back",
		"Buy-Back Booklet",
		"Buyback Notice",
	}
	// NOTE: `on-?market buy-?back` needs a hyphen or nothing between the words,
	// so a SPACE-separated "On market buyback" is kept — same as Python. Pinned
	// below so the gap is a known one, not an accident.
	for _, title := range drop {
		if isFinancialReportTitle(title) {
			t.Errorf("want DROP, got keep: %q", title)
		}
	}
}

// "Results" alone must NOT be a keep-override, or the override would readmit
// every "… Results Media Release".
func TestKeepOverrideDoesNotReadmitNoise(t *testing.T) {
	if isFinancialReportTitle("Full Year Results Media Release") {
		t.Error("bare \"results\" must not override the media-release noise pattern")
	}
}

// Known Python gaps, pinned so a "helpful" regex fix is a deliberate decision
// rather than a silent behaviour change vs the deployed job.
func TestKnownNoisePatternGapsMatchPython(t *testing.T) {
	for _, title := range []string{
		"On market buyback",         // `on-?market` requires hyphen-or-nothing, not a space
		"Buy back notice",           // same: `buy-?back`
		"Notice of General Meeting", // only "annual general"/bare "meeting" forms are listed
	} {
		if !isFinancialReportTitle(title) {
			t.Errorf("%q is KEPT by the Python patterns; the Go port must agree", title)
		}
	}
}

func TestParseReportRowsFiltersSourceTypeAndTitle(t *testing.T) {
	rows := []reportRow{{
		StockCode: "BHP",
		FinancialReports: `[
			{"source":"asx_announcements","type":"annual_report","title":"Annual Report 2025","url":"u1","date":"2025-09-01"},
			{"source":"asx_announcements","type":"half_year_results","title":"Half Year Results Media Release","url":"u2","date":"2025-02-01"},
			{"source":"asx_announcements","type":"quarterly_report","title":"Quarterly Activities Report","url":"u3","date":"2025-04-01"},
			{"source":"company_website","type":"annual_report","title":"Annual Report 2024","url":"u4","date":"2024-09-01"},
			{"source":"asx_announcements","type":"financial_report","title":"","url":"u5","date":"2025-08-01"}
		]`,
	}, {
		StockCode:        "CBA",
		FinancialReports: `not json`,
	}}

	got := parseReportRows(rows)
	var urls []string
	for _, r := range got {
		urls = append(urls, r.URL)
	}
	want := []string{"u1", "u5"}
	if !reflect.DeepEqual(urls, want) {
		t.Errorf("got %v, want %v (u2=noise title, u3=excluded type, u4=wrong source, CBA=bad JSON)", urls, want)
	}
	if got[0].StockCode != "BHP" || got[0].Type != "annual_report" || got[0].Date != "2025-09-01" {
		t.Errorf("field mapping lost: %+v", got[0])
	}
}

// The (stock_code, date) DESC sort feeds the per-company `--recent` cap, so
// "latest N per company" depends on it exactly.
func TestSortReportsDescAndCapPerCompany(t *testing.T) {
	reports := []report{
		{StockCode: "AAA", Date: "2024-01-01", URL: "a-old"},
		{StockCode: "BBB", Date: "2025-06-01", URL: "b-new"},
		{StockCode: "AAA", Date: "2025-09-01", URL: "a-new"},
		{StockCode: "AAA", Date: "2025-03-01", URL: "a-mid"},
		{StockCode: "BBB", Date: "2023-01-01", URL: "b-old"},
	}
	sortReportsDesc(reports)

	var order []string
	for _, r := range reports {
		order = append(order, r.URL)
	}
	want := []string{"b-new", "b-old", "a-new", "a-mid", "a-old"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("sort order: got %v, want %v", order, want)
	}

	capped := capPerCompany(reports, 2)
	var got []string
	for _, r := range capped {
		got = append(got, r.URL)
	}
	if want := []string{"b-new", "b-old", "a-new", "a-mid"}; !reflect.DeepEqual(got, want) {
		t.Errorf("recent=2 cap: got %v, want %v", got, want)
	}
}

func TestApplyTopShortedOrderPutsUnrankedLast(t *testing.T) {
	reports := []report{
		{StockCode: "AAA", URL: "a"},
		{StockCode: "ZZZ", URL: "z"}, // unranked → -1
		{StockCode: "BBB", URL: "b"},
		{StockCode: "AAA", URL: "a2"}, // same rank as "a": stable, keeps order
	}
	applyTopShortedOrder(reports, map[string]float64{"AAA": 4.2, "BBB": 9.9})

	var got []string
	for _, r := range reports {
		got = append(got, r.URL)
	}
	if want := []string{"b", "a", "a2", "z"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

// The three selection queries are stored-behaviour contracts; a silent change to
// the mv_top_shorts join or the asx_announcements LIKE would change WHICH
// companies are extracted.
func TestSelectionQuery(t *testing.T) {
	sql, args := selectionQuery(modeCodes, []string{"BHP", "CBA"})
	if !strings.Contains(sql, "stock_code = ANY($1)") || len(args) != 1 {
		t.Errorf("codes query wrong: %q args=%v", sql, args)
	}

	sql, args = selectionQuery(modeTop50, nil)
	if !strings.Contains(sql, "mv_top_shorts") || !strings.Contains(sql, "ORDER BY current_percent DESC") ||
		!strings.Contains(sql, "LIMIT 50") || args != nil {
		t.Errorf("top50 query wrong: %q", sql)
	}

	sql, _ = selectionQuery(modeAll, nil)
	if !strings.Contains(sql, `LIKE '%asx_announcements%'`) || !strings.Contains(sql, "ORDER BY stock_code") {
		t.Errorf("all query wrong: %q", sql)
	}

	// An empty --codes list falls through to the "all" query, exactly as the
	// Python `if mode == "codes" and codes` guard did.
	if sql, _ := selectionQuery(modeCodes, nil); !strings.Contains(sql, "asx_announcements") {
		t.Errorf("empty codes should fall back to the all query, got %q", sql)
	}
}

func TestSelectSQLShapes(t *testing.T) {
	if !strings.Contains(selectDigestlessSQL, "WHERE digest IS NULL") {
		t.Error("digestless selection must filter on digest IS NULL")
	}
	if !strings.Contains(selectExistingExtractionsSQL, "report_url = ANY($1)") {
		t.Error("already-extracted filter must batch through ANY()")
	}
}
