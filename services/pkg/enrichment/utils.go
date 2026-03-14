package enrichment

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/PuerkitoBio/goquery"
	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// fetchHTML fetches HTML content from a URL using a stealth HTTP client.
func fetchHTML(ctx context.Context, client *stealthhttp.Client, pageURL string) (*goquery.Document, *url.URL, error) {
	return client.FetchHTML(ctx, pageURL)
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

// sameHostOrSubdomain returns true if the candidate URL is on the same domain
// or a subdomain of root. E.g., investor.bhp.com matches bhp.com.
func sameHostOrSubdomain(root *url.URL, candidate string) bool {
	u, err := url.Parse(candidate)
	if err != nil {
		return false
	}
	rootHost := strings.ToLower(root.Hostname())
	candHost := strings.ToLower(u.Hostname())
	if rootHost == candHost {
		return true
	}
	return strings.HasSuffix(candHost, "."+rootHost) || strings.HasSuffix(rootHost, "."+candHost)
}

