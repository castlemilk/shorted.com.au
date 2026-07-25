package reports

import (
	"reflect"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

func groupSub(t *testing.T, j runner.Job) *runner.Registry {
	t.Helper()
	g, ok := j.(*runner.Group)
	if !ok {
		t.Fatalf("reports.Group() is %T, want *runner.Group", j)
	}
	return g.Sub()
}

// TestClassifyURLType locks the deduped classifier against the behaviour of
// BOTH originals (report-coverage's strings.Contains switch and report-linker's
// regexp switch).
func TestClassifyURLType(t *testing.T) {
	cases := []struct {
		url  string
		want string
	}{
		// annual_results wins over annual_report (first switch arm).
		{"https://x.com/appendix-4e-2024.pdf", "annual_results"},
		{"https://x.com/appendix_4e_2024.pdf", "annual_results"},
		{"https://x.com/preliminary-final-report.pdf", "annual_results"},
		{"https://x.com/preliminary_final.pdf", "annual_results"},
		{"https://x.com/2024-annual-report.pdf", "annual_report"},
		{"https://x.com/2024_annual_report.pdf", "annual_report"},
		{"https://x.com/annualreport2024.pdf", "annual_report"},
		{"https://x.com/half-year-results.pdf", "half_year_results"},
		{"https://x.com/halfyear.pdf", "half_year_results"},
		{"https://x.com/interim-report.pdf", "half_year_results"},
		{"https://x.com/appendix-4d.pdf", "half_year_results"},
		{"https://x.com/quarterly-activities.pdf", "quarterly_report"},
		{"https://x.com/appendix_4c.pdf", "quarterly_report"},
		{"https://x.com/full-year-results.pdf", "full_year_results"},
		{"https://x.com/full_year.pdf", "full_year_results"},
		{"https://x.com/investor-presentation.pdf", "investor_presentation"},
		{"https://x.com/results-presentation.pdf", "investor_presentation"},
		{"https://x.com/analyst-briefing.pdf", "investor_presentation"},
		{"https://x.com/distribution-notice.pdf", "distribution_notice"},
		{"https://x.com/agm-address.pdf", "agm_address"},
		{"https://x.com/annual-general-meeting.pdf", "agm_address"},
		{"https://x.com/some-other-doc.pdf", "financial_report"},
	}
	for _, c := range cases {
		if got := ClassifyURLType(c.url); got != c.want {
			t.Errorf("ClassifyURLType(%q) = %q, want %q", c.url, got, c.want)
		}
	}
}

func TestExtractDateFromURL(t *testing.T) {
	if got := ExtractDateFromURL("https://x.com/annual-report-2023.pdf"); got != "2023-12-31" {
		t.Errorf("got %q", got)
	}
	if got := ExtractDateFromURL("https://x.com/annual-report.pdf"); got != "" {
		t.Errorf("want empty date, got %q", got)
	}
	// Out of the 2010–2029 window.
	if got := ExtractDateFromURL("https://x.com/report-2035.pdf"); got != "" {
		t.Errorf("want empty date, got %q", got)
	}
}

func TestTitleFromURL(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://x.com/reports/FY24-Annual_Report.pdf", "FY24 Annual Report"},
		{"https://x.com/reports/Half%20Year%20Results.PDF", "Half Year Results"},
		{"https://x.com/", "Financial Report"},
		{"://nope", "Financial Report"},
	}
	for _, c := range cases {
		if got := TitleFromURL(c.in); got != c.want {
			t.Errorf("TitleFromURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	long := "https://x.com/" + string(make([]byte, 0)) + repeat("a", 200) + ".pdf"
	if got := TitleFromURL(long); len(got) != 120 {
		t.Errorf("expected title capped at 120 chars, got %d", len(got))
	}
}

func repeat(s string, n int) string {
	out := make([]byte, 0, n*len(s))
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}

// TestSourcePriorityOrdering pins the merged ordering: every source either
// original tool produced keeps its relative rank.
func TestSourcePriorityOrdering(t *testing.T) {
	order := []string{"asx_announcements", "smart_crawler", "investor_crawl", "live_crawl", "links_import", "mystery"}
	for i := 1; i < len(order); i++ {
		if SourcePriority(order[i-1]) >= SourcePriority(order[i]) {
			t.Fatalf("%s should outrank %s", order[i-1], order[i])
		}
	}
	if SourcePriority("crawler") != SourcePriority("smart_crawler") {
		t.Error("crawler and smart_crawler must share a rank")
	}
}

func TestSortReportsBySourceThenDateDesc(t *testing.T) {
	in := []FinancialReport{
		{URL: "d", Source: "links_import", Date: "2024-12-31"},
		{URL: "b", Source: "asx_announcements", Date: "2022-12-31"},
		{URL: "a", Source: "asx_announcements", Date: "2024-12-31"},
		{URL: "c", Source: "live_crawl", Date: "2023-12-31"},
	}
	SortReports(in)
	var got []string
	for _, r := range in {
		got = append(got, r.URL)
	}
	if want := []string{"a", "b", "c", "d"}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestTypePriority(t *testing.T) {
	order := []string{"annual_results", "annual_report", "half_year_results", "full_year_results", "investor_presentation", "quarterly_report", "financial_report"}
	for i := 1; i < len(order); i++ {
		if TypePriority(order[i-1]) >= TypePriority(order[i]) {
			t.Fatalf("%s should outrank %s", order[i-1], order[i])
		}
	}
}

func TestIsFinancialURL(t *testing.T) {
	yes := []string{
		"https://x.com/2024-annual-report.pdf",
		"https://x.com/appendix-4c.pdf",
		"https://x.com/quarterly-cash-flow.pdf",
		"https://x.com/agm-address.pdf",
		"https://x.com/earnings-release.pdf",
	}
	for _, u := range yes {
		if !IsFinancialURL(u) {
			t.Errorf("expected %q to be a financial URL", u)
		}
	}
	no := []string{"https://x.com/privacy-policy.pdf", "https://x.com/careers.pdf"}
	for _, u := range no {
		if IsFinancialURL(u) {
			t.Errorf("expected %q NOT to be a financial URL", u)
		}
	}
}

func TestParseCodesAndCodeList(t *testing.T) {
	set := ParseCodes(" bhp , cba ,, ")
	if !set["BHP"] || !set["CBA"] || len(set) != 2 {
		t.Errorf("ParseCodes got %v", set)
	}
	list := CodeList(" bhp , cba ,, ")
	if !reflect.DeepEqual(list, []string{"BHP", "CBA"}) {
		t.Errorf("CodeList got %v", list)
	}
	if CodeList("") != nil {
		t.Errorf("empty -codes should produce a nil list")
	}
}

func TestBuildReportFromURL(t *testing.T) {
	got := BuildReportFromURL("https://x.com/reports/2023-Annual_Report.pdf", "links_import")
	want := FinancialReport{
		URL:    "https://x.com/reports/2023-Annual_Report.pdf",
		Date:   "2023-12-31",
		Type:   "annual_report",
		Title:  "2023 Annual Report",
		Source: "links_import",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestExtractFinancialReportsFromPythonStyleLinks(t *testing.T) {
	links := `['https://x.com/2024-annual-report.pdf', '/docs/half-year-results.pdf', 'https://x.com/privacy.pdf', 'https://x.com/2024-annual-report.pdf']`
	got := extractFinancialReports("x.com", links)
	if len(got) != 2 {
		t.Fatalf("want 2 reports (deduped, non-financial dropped), got %d: %+v", len(got), got)
	}
	// Relative link resolved against the website.
	var sawResolved bool
	for _, r := range got {
		if r.URL == "https://x.com/docs/half-year-results.pdf" {
			sawResolved = true
		}
		if r.Source != "links_import" {
			t.Errorf("unexpected source %q", r.Source)
		}
	}
	if !sawResolved {
		t.Errorf("relative URL not resolved: %+v", got)
	}
}

func TestResolveURL(t *testing.T) {
	cases := []struct{ website, link, want string }{
		{"x.com", "/a.pdf", "https://x.com/a.pdf"},
		{"https://x.com/ir", "b.pdf", "https://x.com/b.pdf"},
		{"", "/a.pdf", ""},
		{"x.com", "https://y.com/a.pdf", "https://y.com/a.pdf"},
		{"x.com", "   ", ""},
	}
	for _, c := range cases {
		if got := resolveURL(c.website, c.link); got != c.want {
			t.Errorf("resolveURL(%q,%q) = %q, want %q", c.website, c.link, got, c.want)
		}
	}
}

func TestBuildObjectPath(t *testing.T) {
	r := &FinancialReport{URL: "https://x.com/a.pdf", Type: "annual_report", Date: "2024-12-31"}
	got := buildObjectPath("BHP", r)
	if len(got) == 0 || got[:len("reports/BHP/annual_report_2024-12-31_")] != "reports/BHP/annual_report_2024-12-31_" {
		t.Fatalf("unexpected object path %q", got)
	}
	blank := &FinancialReport{URL: "https://x.com/a.pdf"}
	if got := buildObjectPath("BHP", blank); got[:len("reports/BHP/financial_report_unknown_")] != "reports/BHP/financial_report_unknown_" {
		t.Fatalf("blank type/date fallback broken: %q", got)
	}
}

func TestGroupExposesThreeJobs(t *testing.T) {
	names := []string{}
	for _, n := range []string{"coverage", "link", "sync"} {
		names = append(names, n)
	}
	g := Group()
	if g.Name() != "reports" {
		t.Fatalf("group name %q", g.Name())
	}
	for _, n := range names {
		if _, ok := groupSub(t, g).Lookup(n); !ok {
			t.Errorf("missing sub-job %q", n)
		}
	}
}
