package enrichment

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// fetchHTML fetches HTML content from a URL.
func fetchHTML(ctx context.Context, httpClient *http.Client, pageURL string) (*goquery.Document, *url.URL, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := httpClient.Do(req)
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

