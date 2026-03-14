package enrichment

import (
	"net/url"
	"strings"
	"testing"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

func TestExtractYear(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"Annual Report 2024", "2024"},
		{"annual-report-2025.pdf", "2025"},
		{"2026-annual-report", "2026"},
		{"FY2019 Results", "2019"},
		{"report_2035.pdf", "2035"},
		{"no year here", ""},
		{"year 1999 too old", ""},
		{"year 2099 too far", ""},
	}

	for _, tt := range tests {
		got := extractYear(tt.input)
		if got != tt.want {
			t.Errorf("extractYear(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestIsPDFLink(t *testing.T) {
	tests := []struct {
		href string
		text string
		want bool
	}{
		{"https://example.com/report.pdf", "Annual Report", true},
		{"https://example.com/report.pdf?v=1", "Report", true},
		{"https://example.com/page", "Click here", false},
		{"https://example.com/download/report", "Annual Report 2024", true},
		{"https://example.com/document/123", "Half Year Results", true},
		// Social media should be excluded.
		{"https://facebook.com/share.pdf", "Share", false},
		{"https://twitter.com/post.pdf", "Tweet", false},
		// Text heuristic should NOT fire on generic pages.
		{"https://example.com/about", "Download PDF report overview", false},
	}

	for _, tt := range tests {
		got := isPDFLink(tt.href, tt.text)
		if got != tt.want {
			t.Errorf("isPDFLink(%q, %q) = %v, want %v", tt.href, tt.text, got, tt.want)
		}
	}
}

func TestClassifyReportType(t *testing.T) {
	tests := []struct {
		text string
		want string
	}{
		{"Annual Report 2024", "annual_report"},
		{"Half Year Results", "half_year_report"},
		{"Interim Report", "half_year_report"},
		{"Quarterly Update Q3", "quarterly_report"},
		{"Financial Summary", "financial_report"},
	}

	for _, tt := range tests {
		got := classifyReportType(tt.text)
		if got != tt.want {
			t.Errorf("classifyReportType(%q) = %q, want %q", tt.text, got, tt.want)
		}
	}
}

func TestBuildReport(t *testing.T) {
	r := buildReport("https://example.com/annual-2024.pdf", "Annual Report 2024")
	if r.Url != "https://example.com/annual-2024.pdf" {
		t.Errorf("URL = %q", r.Url)
	}
	if r.Date != "2024-12-31" {
		t.Errorf("Date = %q, want 2024-12-31", r.Date)
	}
	if r.Type != "annual_report" {
		t.Errorf("Type = %q, want annual_report", r.Type)
	}
	if r.Source != "crawler" {
		t.Errorf("Source = %q, want crawler", r.Source)
	}

	// Long title should be truncated.
	longText := strings.Repeat("a", 300)
	r2 := buildReport("https://example.com/report.pdf", longText)
	if len(r2.Title) > 200 {
		t.Errorf("Title length = %d, want <= 200", len(r2.Title))
	}

	// Empty link text should default.
	r3 := buildReport("https://example.com/report.pdf", "")
	if r3.Title != "Financial Report" {
		t.Errorf("Title = %q, want 'Financial Report'", r3.Title)
	}
}

func TestIsValidReportURL(t *testing.T) {
	tests := []struct {
		url  string
		want bool
	}{
		{"https://example.com/report.pdf", true},
		{"http://example.com/report.pdf", true},
		{"ftp://example.com/file", false},
		{"", false},
		{"/relative/path.pdf", false},
		{"javascript:void(0)", false},
	}

	for _, tt := range tests {
		got := isValidReportURL(tt.url)
		if got != tt.want {
			t.Errorf("isValidReportURL(%q) = %v, want %v", tt.url, got, tt.want)
		}
	}
}

func TestSameHostOrSubdomain(t *testing.T) {
	root, _ := url.Parse("https://bhp.com")
	tests := []struct {
		candidate string
		want      bool
	}{
		{"https://bhp.com/investors", true},
		{"https://www.bhp.com/investors", true},
		{"https://investor.bhp.com/reports", true},
		{"https://google.com", false},
		{"https://notbhp.com", false},
	}

	for _, tt := range tests {
		got := sameHostOrSubdomain(root, tt.candidate)
		if got != tt.want {
			t.Errorf("sameHostOrSubdomain(bhp.com, %q) = %v, want %v", tt.candidate, got, tt.want)
		}
	}
}

func TestLinkPriority(t *testing.T) {
	tests := []struct {
		href string
		text string
		pos  bool // true = should be positive score
	}{
		{"https://example.com/investors", "Investor Centre", true},
		{"https://example.com/annual-reports", "Reports", true},
		{"https://example.com/about", "About Us", false},
		// Social media links should score 0.
		{"https://facebook.com/company", "Follow us", false},
		{"https://youtube.com/channel", "Watch videos", false},
		// News in URL should NOT be blocked anymore.
		{"https://example.com/news/annual-report-2024", "Annual Report", true},
	}

	for _, tt := range tests {
		got := linkPriority(tt.href, tt.text)
		if tt.pos && got <= 0 {
			t.Errorf("linkPriority(%q, %q) = %d, want > 0", tt.href, tt.text, got)
		}
		if !tt.pos && got > 0 {
			t.Errorf("linkPriority(%q, %q) = %d, want <= 0", tt.href, tt.text, got)
		}
	}
}

func TestDedupeReports(t *testing.T) {
	reports := dedupeReports(nil)
	if len(reports) != 0 {
		t.Errorf("nil input: got %d reports", len(reports))
	}

	// Empty and invalid URLs should be filtered out.
	reports = dedupeReports([]*stocksv1alpha1.FinancialReport{
		{Url: ""},
		{Url: "/relative/path.pdf"},
		{Url: "https://example.com/report.pdf", Title: "Report 1"},
		{Url: "https://example.com/report.pdf", Title: "Report 1 Dup"},
		{Url: "https://example.com/other.pdf", Title: "Report 2"},
	})
	if len(reports) != 2 {
		t.Errorf("deduplication: got %d reports, want 2", len(reports))
	}
}

func TestBuildSeedURLs(t *testing.T) {
	root, _ := url.Parse("https://bhp.com")
	urls := buildSeedURLs(root)
	if len(urls) == 0 {
		t.Fatal("buildSeedURLs returned no URLs")
	}
	// Should include the root.
	found := false
	for _, u := range urls {
		if u == "https://bhp.com" {
			found = true
		}
	}
	if !found {
		t.Error("seed URLs should include root URL")
	}
	// Should not have duplicates.
	seen := make(map[string]bool)
	for _, u := range urls {
		if seen[u] {
			t.Errorf("duplicate seed URL: %s", u)
		}
		seen[u] = true
	}
}
