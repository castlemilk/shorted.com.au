package influence

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

type DownloadLink struct {
	Href string
	Text string
}

func fetchDownloadLinks(ctx context.Context, pageURL string) ([]DownloadLink, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", influenceUA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return nil, fmt.Errorf("fetch %s: HTTP %d", pageURL, resp.StatusCode)
	}

	doc, err := goquery.NewDocumentFromReader(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", pageURL, err)
	}
	base, err := url.Parse(pageURL)
	if err != nil {
		return nil, err
	}

	var links []DownloadLink
	doc.Find("a[href]").Each(func(_ int, sel *goquery.Selection) {
		href, ok := sel.Attr("href")
		if !ok {
			return
		}
		resolved, err := base.Parse(strings.TrimSpace(href))
		if err != nil {
			return
		}
		text := strings.Join(strings.Fields(sel.Text()), " ")
		links = append(links, DownloadLink{
			Href: resolved.String(),
			Text: text,
		})
	})
	return links, nil
}

func findDownloadLink(links []DownloadLink, required ...string) (DownloadLink, bool) {
	for _, link := range links {
		haystack := strings.ToLower(link.Text + " " + link.Href)
		matches := true
		for _, term := range required {
			if !strings.Contains(haystack, strings.ToLower(term)) {
				matches = false
				break
			}
		}
		if matches {
			return link, true
		}
	}
	return DownloadLink{}, false
}
