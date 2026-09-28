package extractiontrust

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// titleCase is one row of testdata/results_titles.json, the fixture the Python
// extractor's port of IsResultsDocument is asserted against too.
type titleCase struct {
	Title      string `json:"title"`
	ReportKind string `json:"report_kind"`
	Want       bool   `json:"want"`
	Note       string `json:"note,omitempty"`
}

func loadTitleCases(t *testing.T) []titleCase {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "results_titles.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cases []titleCase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return cases
}

func TestIsResultsDocumentFixture(t *testing.T) {
	cases := loadTitleCases(t)
	if len(cases) < 30 {
		t.Fatalf("fixture must carry at least 30 titles, has %d", len(cases))
	}
	var trues, falses int
	seen := map[[2]string]bool{}
	for _, c := range cases {
		key := [2]string{c.Title, c.ReportKind}
		if seen[key] {
			t.Errorf("duplicate fixture row %q / %q", c.Title, c.ReportKind)
		}
		seen[key] = true
		if c.Want {
			trues++
		} else {
			falses++
		}
		if got := IsResultsDocument(c.Title, c.ReportKind); got != c.Want {
			t.Errorf("IsResultsDocument(%q, %q) = %v, want %v (%s)", c.Title, c.ReportKind, got, c.Want, c.Note)
		}
	}
	if trues < 10 || falses < 10 {
		t.Errorf("fixture is lopsided: %d true, %d false", trues, falses)
	}
}

// The titles the task and the contract name explicitly must be in the shared
// fixture, with these answers, so the Python port cannot pass without them.
func TestResultsFixtureCarriesTheNamedTitles(t *testing.T) {
	want := map[string]bool{
		"BHP Appendix 4E and 2026 Annual Report":       true,
		"Half Year Basel III Pillar 3 Disclosure":      false,
		"2026 US Annual Report (Form 20-F)":            false,
		"FY26 Results Presentation":                    false,
		"2025 Half Year Results Profit Announcement":   true,
		"Appendix 4D and Half Year Report":             true,
		"Items impacting the FY26 result":              false,
		"Webcast":                                      false,
		"Preliminary Final Report":                     true,
		"Annual Report 2025":                           true,
		"Winsome Resources Annual Report 30 June 2025": true,
	}
	got := map[string]bool{}
	for _, c := range loadTitleCases(t) {
		if c.ReportKind == "" {
			got[c.Title] = c.Want
		}
	}
	for title, w := range want {
		g, ok := got[title]
		if !ok {
			t.Errorf("fixture lacks %q (with report_kind \"\")", title)
			continue
		}
		if g != w {
			t.Errorf("fixture says %q -> %v, want %v", title, g, w)
		}
	}
}

func TestIsResultsDocumentReportKind(t *testing.T) {
	cases := []struct {
		title, kind string
		want        bool
	}{
		// "other" vetoes any title, in any case or spacing.
		{"Annual Report 2025", "other", false},
		{"Appendix 4E and Annual Report", " Other ", false},
		// A statutory kind stands in for a missing title only.
		{"", "appendix_4e", true},
		{"   ", "appendix_4d", true},
		{"", "annual_report", true},
		{"", "half_year_report", true},
		{"", "results_announcement", true},
		{"", "", false},
		{"", "other", false},
		{"", "half_year_results", false}, // the crawler's report_type is not the vocabulary
		// The title decides: a neutral title is not rescued by the kind.
		{"Company Update", "appendix_4e", false},
		// A positive title passes with an absent or statutory kind.
		{"Appendix 4E and Annual Report", "", true},
		{"Appendix 4E and Annual Report", "results_announcement", true},
		// Exclusions win over a statutory kind.
		{"FY26 Results Presentation", "appendix_4e", false},
	}
	for _, c := range cases {
		if got := IsResultsDocument(c.title, c.kind); got != c.want {
			t.Errorf("IsResultsDocument(%q, %q) = %v, want %v", c.title, c.kind, got, c.want)
		}
	}
}

// Headlines from picks/filings_test.go and reportextract/select_test.go that
// both of those classifiers treat as NOT a results document must stay not a
// results document here: this classifier is only ever stricter.
func TestIsResultsDocumentAgreesOnExistingRejections(t *testing.T) {
	for _, title := range []string{
		"FY26 Results Date and Market Briefing",
		"AMX to present FY26 Results at Coffee Microcaps Webinar",
		"Advanced Braking Technology FY26 Results Webinar",
		"Dividend/Distribution - AMA",
		"Update - Dividend/Distribution - ALK",
		"Confirmation of Final Dividend Payment Date",
		"Trading Halt",
		"Change of Director's Interest Notice",
		"Quarterly Activities Report",
		"Notice of Annual General Meeting",
		"FY26 Dividend Declared and On-Market Share Buy-Back",
		"Neuren H1 2026 Financial Results Webinar on 26 August 2026",
		"Results of Meeting",
		"Results of 2025 Annual General Meeting",
		"Results of General Meeting - Share Issue Approvals",
		"Notice of FY26 Results Market Briefing",
		"PolyNovo FY26 Results Presentation - Registration Details",
		"Quarterly Activities/Appendix 4C Cash Flow Report",
		"Quarterly Activity Report and Appendix 4C",
		"1Q26 4C Results - Investor Presentation",
		"FY25 Results Presentation",
		"Investor Presentation",
		"Half Year Results Presentation",
	} {
		if IsResultsDocument(title, "") {
			t.Errorf("IsResultsDocument(%q) = true; the existing classifiers reject it", title)
		}
	}
}

// Statutory headlines the existing classifiers accept, which are results
// documents here too.
func TestIsResultsDocumentAgreesOnStatutoryHeadlines(t *testing.T) {
	for _, title := range []string{
		"Appendix 4E & Financial Report for year ended 30 June 2026",
		"FY26 Appendix 4E and Annual Report",
		"Appendix 4E & Annual Report for Year Ending 30 June 2026",
		"Annual Report to shareholders",
		"FY26 Financial Results and Dividend",
		"FY26 Results Release",
		"Media Release - Result for year ended 30 June 2026",
		"FY26 Financial Results Release and Webinar",
		"2026 GYG Full Year Report and Appendix 4E",
		"Telix HY26 Results Announcement",
		"Media Release - Full Year Results to 30 June 2026",
		"Half Yearly Report and Accounts",
		"1H25 Results Surging Revenue and Profitability",
		"2H26 Results",
		"Appendix 4E - Preliminary Final Report",
		"Appendix 4D and FY26 Half Year Report",
		"FY2025 Full year results",
		"Appendix4E and Annual Report",
		"Half Year Financial Report",
		"Annual Financial Report 2026",
		"Financial Report for the half year ended 31 December 2025",
		"Results Summary - Full Year Ended 30 June 2026",
		"Half Year Results and Interim Dividend",
	} {
		if !IsResultsDocument(title, "") {
			t.Errorf("IsResultsDocument(%q) = false; it is a statutory results document", title)
		}
	}
}

// Typographic punctuation is folded before matching: curly apostrophes and en
// or em dashes read as their ASCII forms.
func TestIsResultsDocumentNormalisesPunctuation(t *testing.T) {
	cases := []struct {
		title string
		want  bool
	}{
		{"Chairman\u2019s Address to Shareholders", false},
		{"CEO\u2019s AGM Speech", false},
		{"Appendix 4D \u2013 Half\u2011Year Report", true},
		{"Appendix 4E \u2014 Preliminary Final Report", true},
		{"Update \u2013 Dividend/Distribution \u2013 CBA", false},
		{"Annual\u00A0Report\u00A02025", true},
	}
	for _, c := range cases {
		if got := IsResultsDocument(c.title, ""); got != c.want {
			t.Errorf("IsResultsDocument(%q) = %v, want %v", c.title, got, c.want)
		}
	}
}
