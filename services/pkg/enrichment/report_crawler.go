package enrichment

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/PuerkitoBio/goquery"
	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

type crawlQueueItem struct {
	u     string
	depth int
}

// FinancialReportCrawler interface for crawling financial reports
type FinancialReportCrawler interface {
	CrawlFinancialReports(ctx context.Context, website string) ([]*stocksv1alpha1.FinancialReport, error)
}

type ReportCrawler struct {
	client *stealthhttp.Client
}

// NewReportCrawler creates a ReportCrawler with a default stealth client (25s timeout).
func NewReportCrawler() *ReportCrawler {
	client, err := stealthhttp.New(stealthhttp.WithTimeout(25 * time.Second))
	if err != nil {
		panic(fmt.Sprintf("stealthhttp: failed to create native client: %v", err))
	}
	return &ReportCrawler{client: client}
}

// NewReportCrawlerWithClient creates a ReportCrawler with a provided stealth client.
func NewReportCrawlerWithClient(client *stealthhttp.Client) *ReportCrawler {
	return &ReportCrawler{client: client}
}

func (c *ReportCrawler) CrawlFinancialReports(ctx context.Context, website string) ([]*stocksv1alpha1.FinancialReport, error) {
	website = strings.TrimSpace(website)
	if website == "" {
		return nil, nil
	}

	rootURL, err := normalizeWebsiteURL(website)
	if err != nil {
		return nil, err
	}

	seedURLs := buildSeedURLs(rootURL)
	visited := make(map[string]struct{}, 64)
	queue := make([]crawlQueueItem, 0, len(seedURLs))
	for _, u := range seedURLs {
		queue = append(queue, crawlQueueItem{u: u, depth: 0})
	}

	const (
		maxPages = 15
		maxDepth = 2
	)

	var reports []*stocksv1alpha1.FinancialReport
	pagesCrawled := 0
	pagesFailed := 0

	for len(queue) > 0 && pagesCrawled < maxPages {
		item := queue[0]
		queue = queue[1:]

		normalized := normalizeURL(item.u)
		if _, ok := visited[normalized]; ok {
			continue
		}
		visited[normalized] = struct{}{}
		pagesCrawled++

		doc, base, err := fetchHTML(ctx, c.client, item.u)
		if err != nil || doc == nil || base == nil {
			pagesFailed++
			if err != nil {
				slog.Debug("report_crawler: failed to fetch page", "url", item.u, "error", err)
			}
			continue
		}

		doc.Find("a[href]").Each(func(_ int, sel *goquery.Selection) {
			href, _ := sel.Attr("href")
			href = strings.TrimSpace(href)
			if href == "" || strings.HasPrefix(href, "#") || strings.HasPrefix(href, "javascript:") || strings.HasPrefix(href, "mailto:") {
				return
			}
			text := strings.TrimSpace(sel.Text())

			abs := resolveURL(base, href)
			if abs == "" || !isValidReportURL(abs) {
				return
			}

			if isPDFLink(abs, text) {
				reports = append(reports, buildReport(abs, text))
				return
			}

			// Follow relevant internal links.
			if item.depth >= maxDepth {
				return
			}
			if !sameHostOrSubdomain(rootURL, abs) {
				return
			}
			if linkPriority(abs, text) <= 0 {
				return
			}
			queue = append(queue, crawlQueueItem{u: abs, depth: item.depth + 1})
		})

		// Be polite (and reduce risk of being blocked).
		select {
		case <-time.After(300 * time.Millisecond):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	if pagesFailed > 0 {
		slog.Info("report_crawler: crawl complete", "website", website, "pages_crawled", pagesCrawled, "pages_failed", pagesFailed, "reports_found", len(reports))
	}

	// Deduplicate and sort.
	unique := dedupeReports(reports)
	sort.SliceStable(unique, func(i, j int) bool {
		di := unique[i].Date
		dj := unique[j].Date
		return di > dj
	})

	if len(unique) > 10 {
		unique = unique[:10]
	}
	return unique, nil
}

func buildSeedURLs(root *url.URL) []string {
	base := *root
	base.Path = strings.TrimRight(base.Path, "/")

	paths := []string{
		"",
		"/investors",
		"/investor",
		"/investor-centre",
		"/investor-center",
		"/investor-relations",
		"/investors/investor-centre",
		"/reports",
		"/annual-reports",
		"/asx-announcements",
		"/financial-reports",
	}

	seen := make(map[string]struct{}, len(paths))
	var out []string
	for _, p := range paths {
		u := base
		u.Path = p
		u.RawQuery = ""
		s := u.String()
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// isValidReportURL checks that a URL is absolute with an http(s) scheme.
func isValidReportURL(u string) bool {
	return strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")
}

func isPDFLink(href string, linkText string) bool {
	h := strings.ToLower(href)
	// Exclude social media links.
	for _, social := range []string{"facebook.com", "twitter.com", "linkedin.com", "youtube.com", "instagram.com"} {
		if strings.Contains(h, social) {
			return false
		}
	}
	// Direct PDF file link.
	if strings.HasSuffix(h, ".pdf") || strings.Contains(h, ".pdf?") {
		return true
	}
	// Some sites use download endpoints without .pdf suffix.
	// Require the URL itself to look like a download/document endpoint.
	t := strings.ToLower(linkText)
	if (strings.Contains(h, "/download") || strings.Contains(h, "/document")) &&
		(strings.Contains(t, "report") || strings.Contains(t, "annual") || strings.Contains(t, "results")) {
		return true
	}
	return false
}

var yearRegexp = regexp.MustCompile(`20[0-3]\d`)

func extractYear(text string) string {
	m := yearRegexp.FindString(text)
	return m
}

func buildReport(href string, linkText string) *stocksv1alpha1.FinancialReport {
	year := extractYear(href + " " + linkText)
	date := ""
	if year != "" {
		date = year + "-12-31"
	}

	reportType := classifyReportType(linkText)

	title := strings.TrimSpace(linkText)
	// Collapse excessive whitespace from HTML text extraction.
	title = strings.Join(strings.Fields(title), " ")
	if title == "" {
		title = "Financial Report"
	}
	// Truncate excessively long titles (some anchor text includes surrounding content).
	if len(title) > 200 {
		title = title[:200]
	}

	return &stocksv1alpha1.FinancialReport{
		Url:    href,
		Title:  title,
		Type:   reportType,
		Date:   date,
		Source: "crawler",
	}
}

func classifyReportType(linkText string) string {
	t := strings.ToLower(linkText)
	switch {
	case strings.Contains(t, "annual"):
		return "annual_report"
	case strings.Contains(t, "half") || strings.Contains(t, "half-year") || strings.Contains(t, "interim"):
		return "half_year_report"
	case strings.Contains(t, "quarterly") || strings.Contains(t, "quarter"):
		return "quarterly_report"
	default:
		return "financial_report"
	}
}

func linkPriority(href, text string) int {
	hrefLower := strings.ToLower(href)
	textLower := strings.ToLower(text)
	combined := textLower + " " + hrefLower

	// Avoid social media links by domain.
	for _, social := range []string{"facebook.com", "twitter.com", "linkedin.com", "youtube.com", "instagram.com"} {
		if strings.Contains(hrefLower, social) {
			return 0
		}
	}

	score := 0
	high := []string{"annual report", "annual-reports", "financial report", "financial-reports", "investor", "investors", "results", "reports", "presentations", "asx"}
	medium := []string{"download", "pdf", "announcement", "shareholder"}

	for _, kw := range high {
		if strings.Contains(combined, kw) {
			score += 10
		}
	}
	for _, kw := range medium {
		if strings.Contains(combined, kw) {
			score += 5
		}
	}

	return score
}

func dedupeReports(in []*stocksv1alpha1.FinancialReport) []*stocksv1alpha1.FinancialReport {
	seen := make(map[string]struct{}, len(in))
	out := make([]*stocksv1alpha1.FinancialReport, 0, len(in))
	for _, r := range in {
		if r == nil || strings.TrimSpace(r.Url) == "" || !isValidReportURL(r.Url) {
			continue
		}
		key := normalizeURL(r.Url)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, r)
	}
	return out
}
