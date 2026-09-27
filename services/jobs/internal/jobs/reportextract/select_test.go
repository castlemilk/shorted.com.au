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

// Statutory-filing targeting (a deliberate divergence from extract.py): the
// weekly Gemini budget goes to Appendix 4D/4E first and never to presentations,
// notices, dividend admin or quarterlies. Headlines are real asx_announcements
// shapes (several carried over from results-watch.test.ts).
func TestIsExtractionTarget(t *testing.T) {
	accept := []string{
		"",
		"Appendix 4D and Half Year Report",
		"Appendix 4E & Financial Report for year ended 30 June 2026",
		"FY26 Appendix 4E and Annual Report",
		"Appendix 4E - Preliminary Final Report",
		"Appendix4E and Annual Report", // no space
		"Half Year Financial Report",
		"Half Yearly Report and Accounts",
		"Preliminary Final Report",
		"Annual Financial Report 2026",
		"Annual Report 2025",
		"Telix HY26 Results Announcement",
		"FY26 Results Release",
		"FY26 Financial Results Release and Webinar", // strong marker beats the webinar exclusion
		"FY26 Financial Results and Dividend",        // results language beats the dividend exclusion
		"Half Year Results and Interim Dividend",
		"Financial Report for the half year ended 31 December 2025",
		"1H25 Results Surging Revenue and Profitability",
		"Appendix 4E Full Year Results and Investor Presentation", // statutory beats presentation
		"Interim Financial Statements",
		"Results Summary - Full Year Ended 30 June 2026",
	}
	for _, h := range accept {
		if !isExtractionTarget(h) {
			t.Errorf("want TARGET, got excluded: %q", h)
		}
	}
	reject := []string{
		"FY25 Results Presentation",
		"Investor Presentation",
		"Half Year Results Presentation",
		"PolyNovo FY26 Results Presentation - Registration Details",
		"Advanced Braking Technology FY26 Results Webinar",
		"AMX to present FY26 Results at Coffee Microcaps Webinar",
		"FY26 Results Date and Market Briefing",
		"Notice of FY26 Results Market Briefing",
		"Notice of General Meeting", // kept by the Python noise filter, excluded here
		"Notice of Annual General Meeting/Proxy Form",
		"Results of Meeting",
		"Results of 2025 Annual General Meeting",
		"Results of General Meeting - Share Issue Approvals",
		"Dividend/Distribution - AMA",
		"Update - Dividend/Distribution - ALK",
		"Confirmation of Final Dividend Payment Date",
		"Final Dividend Declaration",
		"Dividend Reinvestment Plan Pricing",
		"Quarterly Activities Report",
		"Quarterly Activities/Appendix 4C Cash Flow Report",
		"Quarterly Activity Report and Appendix 4C",
		"1Q26 4C Results - Investor Presentation",
		"Q3 FY26 Results Announcement", // a quarter, even with release language
		"March 2026 Activities Report",
		"Half Year Results Conference Call Details",
		"FY26 Results Briefing Transcript",
	}
	for _, h := range reject {
		if isExtractionTarget(h) {
			t.Errorf("want EXCLUDED, got target: %q", h)
		}
	}
}

func TestFilingPriority(t *testing.T) {
	cases := map[string]int{
		"Appendix 4D and Half Year Report":            0,
		"Appendix 4E - Preliminary Final Report":      0,
		"Telix HY26 Results Announcement":             0,
		"Half Yearly Report and Accounts":             0,
		"Annual Financial Report 2026":                0,
		"Financial Report for the year ended 30 June": 0,
		"Annual Report 2025":                          1, // no "financial": not first tier
		"FY2025 Full year results":                    1,
		"Interim Financial Statements":                1,
		"":                                            2,
		"Operational Update":                          2,
	}
	for title, want := range cases {
		if got := filingPriority(title); got != want {
			t.Errorf("filingPriority(%q) = %d, want %d", title, got, want)
		}
	}
}

// Statutory filings are the primary key; most-shorted breaks ties within a
// tier; newest breaks the rest. The old order (most-shorted alone) spent the
// cap on a heavily shorted company's documents ahead of anyone's 4D.
func TestPrioritiseForExtraction(t *testing.T) {
	reports := []report{
		{StockCode: "AAA", Title: "Annual Report 2025", Date: "2025-09-01", URL: "a-ar"},
		{StockCode: "BBB", Title: "Appendix 4D and Half Year Report", Date: "2026-02-20", URL: "b-4d"},
		{StockCode: "CCC", Title: "Appendix 4E - Preliminary Final Report", Date: "2025-08-20", URL: "c-4e"},
		{StockCode: "AAA", Title: "Appendix 4D", Date: "2026-02-25", URL: "a-4d"},
		{StockCode: "ZZZ", Title: "Appendix 4D", Date: "2026-02-27", URL: "z-4d"},
		{StockCode: "YYY", Title: "Company Update", Date: "2026-03-01", URL: "y-other"},
	}
	prioritiseForExtraction(reports, map[string]float64{"AAA": 12.5, "CCC": 3.1})
	var got []string
	for _, r := range reports {
		got = append(got, r.URL)
	}
	// Tier 0: AAA (12.5%), CCC (3.1%), then the unranked newest first (ZZZ, BBB).
	want := []string{"a-4d", "c-4e", "z-4d", "b-4d", "a-ar", "y-other"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}

	// Without the short ranking: statutory first, newest first.
	prioritiseForExtraction(reports, nil)
	got = got[:0]
	for _, r := range reports {
		got = append(got, r.URL)
	}
	want = []string{"z-4d", "a-4d", "b-4d", "c-4e", "a-ar", "y-other"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("no ranking: got %v, want %v", got, want)
	}
}

func TestParseReportRowsDropsNonTargets(t *testing.T) {
	rows := []reportRow{{
		StockCode: "BHP",
		FinancialReports: `[
			{"source":"asx_announcements","type":"half_year_results","title":"Appendix 4D and Half Year Report","url":"keep","date":"2026-02-17"},
			{"source":"asx_announcements","type":"half_year_results","title":"Half Year Results Presentation","url":"pres","date":"2026-02-17"},
			{"source":"asx_announcements","type":"annual_results","title":"Results of Meeting","url":"agm","date":"2025-11-01"},
			{"source":"asx_announcements","type":"financial_report","title":"FY26 Results Webinar","url":"web","date":"2026-08-01"}
		]`,
	}}
	got := parseReportRows(rows)
	if len(got) != 1 || got[0].URL != "keep" {
		t.Errorf("want only the 4D, got %+v", got)
	}
}

// Same code, same date: the statutory filing wins the per-company cap.
func TestSortReportsDescPrefersTheFilingOnTheSameDay(t *testing.T) {
	reports := []report{
		{StockCode: "AAA", Date: "2026-02-20", Title: "Half year update", URL: "update"},
		{StockCode: "AAA", Date: "2026-02-20", Title: "Appendix 4D", URL: "4d"},
	}
	sortReportsDesc(reports)
	if reports[0].URL != "4d" {
		t.Errorf("want the 4D first, got %v", reports)
	}
}
