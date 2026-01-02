package shorts

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/PuerkitoBio/goquery"
)

type crawlQueueItem struct {
	u     string
	depth int
}

//go:generate mockgen -source=report_crawler.go -destination=mocks/mock_report_crawler.go -package=mocks
type FinancialReportCrawler interface {
	CrawlFinancialReports(ctx context.Context, website string) ([]*stocksv1alpha1.FinancialReport, error)
}

type ReportCrawler struct {
	httpClient *http.Client
}

func NewReportCrawler() *ReportCrawler {
	return &ReportCrawler{
		httpClient: &http.Client{
			Timeout: 25 * time.Second,
		},
	}
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

	for len(queue) > 0 && pagesCrawled < maxPages {
		item := queue[0]
		queue = queue[1:]

		normalized := normalizeURL(item.u)
		if _, ok := visited[normalized]; ok {
			continue
		}
		visited[normalized] = struct{}{}
		pagesCrawled++

		doc, base, err := c.fetchHTML(ctx, item.u)
		if err != nil || doc == nil || base == nil {
			continue
		}

		doc.Find("a[href]").Each(func(_ int, sel *goquery.Selection) {
			href, _ := sel.Attr("href")
			href = strings.TrimSpace(href)
			if href == "" {
				return
			}
			text := strings.TrimSpace(sel.Text())

			abs := resolveURL(base, href)
			if abs == "" {
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
			if !sameHost(rootURL, abs) {
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

func (c *ReportCrawler) fetchHTML(ctx context.Context, pageURL string) (*goquery.Document, *url.URL, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	doc, err := goquery.NewDocumentFromReader(resp.Body)
	if err != nil {
		return nil, nil, err
	}

	base, err := url.Parse(pageURL)
	if err != nil {
		return nil, nil, err
	}
	return doc, base, nil
}

func normalizeWebsiteURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("website is empty")
	}

	// Add scheme if missing.
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid website URL: %w", err)
	}
	if u.Scheme == "" {
		u.Scheme = "https"
	}
	u.Fragment = ""
	return u, nil
}

func buildSeedURLs(root *url.URL) []string {
	base := *root
	base.Path = strings.TrimRight(base.Path, "/")

	paths := []string{
		"",
		"/investors",
		"/investor",
		"/investor-centre",
		"/investor-centre/",
		"/investor-relations",
		"/investors/investor-centre",
		"/reports",
		"/annual-reports",
		"/asx-announcements",
		"/news",
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

func resolveURL(base *url.URL, href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	abs := base.ResolveReference(u)
	abs.Fragment = ""
	return abs.String()
}

func normalizeURL(u string) string {
	u = strings.TrimSpace(u)
	u = strings.Split(u, "#")[0]
	u = strings.Split(u, "?")[0]
	u = strings.TrimRight(u, "/")
	return strings.ToLower(u)
}

func sameHost(root *url.URL, candidate string) bool {
	u, err := url.Parse(candidate)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Hostname(), root.Hostname())
}

func isPDFLink(href string, linkText string) bool {
	h := strings.ToLower(href)
	t := strings.ToLower(linkText)
	if strings.Contains(h, "facebook") || strings.Contains(h, "twitter") || strings.Contains(h, "linkedin") {
		return false
	}
	if strings.HasSuffix(h, ".pdf") || strings.Contains(h, ".pdf?") {
		return true
	}
	// Some sites use download endpoints without .pdf suffix, but label indicates PDF.
	if strings.Contains(t, "pdf") && (strings.Contains(t, "download") || strings.Contains(t, "report")) {
		return true
	}
	return false
}

func extractYear(text string) string {
	re := regexp.MustCompile(`20(2[0-5]|1[0-9])`)
	m := re.FindString(text)
	return m
}

func buildReport(href string, linkText string) *stocksv1alpha1.FinancialReport {
	year := extractYear(href + " " + linkText)
	date := ""
	if year != "" {
		date = year + "-12-31"
	}
	reportType := "financial_report"
	if strings.Contains(strings.ToLower(linkText), "annual") {
		reportType = "annual_report"
	}
	title := strings.TrimSpace(linkText)
	if title == "" {
		title = "Financial Report"
	}

	return &stocksv1alpha1.FinancialReport{
		Url:    href,
		Title:  title,
		Type:   reportType,
		Date:   date,
		Source: "crawler",
	}
}

func linkPriority(href, text string) int {
	combined := strings.ToLower(text + " " + href)
	avoid := []string{"facebook", "twitter", "linkedin", "youtube", "instagram", "news", "media"}
	for _, a := range avoid {
		if strings.Contains(combined, a) {
			return 0
		}
	}

	score := 0
	high := []string{"annual report", "annual-reports", "financial report", "investor", "investors", "results", "reports", "presentations", "asx"}
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
		if r == nil || strings.TrimSpace(r.Url) == "" {
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


