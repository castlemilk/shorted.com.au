package news

import (
	"context"
	"encoding/xml"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// RSSFetcher fetches and parses RSS/Atom feeds using stealth HTTP
type RSSFetcher struct {
	client  *stealthhttp.Client
	verbose bool
}

// NewRSSFetcher creates a new RSS fetcher backed by stealth HTTP.
//
// The standalone binary called log.Fatalf here; inside the shared binary that
// would skip every deferred cleanup (pool close, otel flush), so the failure is
// returned instead.
func NewRSSFetcher(verbose bool) (*RSSFetcher, error) {
	// Use native engine for RSS — Chromium overrides Accept header to prefer HTML,
	// causing RSS feeds to return HTML pages instead of XML.
	client, err := stealthhttp.New(
		stealthhttp.WithTimeout(30*time.Second),
		stealthhttp.WithMaxRedirects(5),
	)
	if err != nil {
		return nil, fmt.Errorf("create stealth HTTP client: %w", err)
	}
	return &RSSFetcher{
		client:  client,
		verbose: verbose,
	}, nil
}

// Close releases stealth engine resources
func (f *RSSFetcher) Close() error {
	if f.client != nil {
		return f.client.Close()
	}
	return nil
}

// NewsArticleRaw represents a raw article parsed from an RSS feed
type NewsArticleRaw struct {
	StockCode        string
	Source           string
	Headline         string
	URL              string
	PublishedAt      string
	Summary          string
	ImageURL         string
	IsPriceSensitive bool
}

// rssFeed represents a generic RSS 2.0 feed (with optional media:* namespace).
type rssFeed struct {
	XMLName xml.Name   `xml:"rss"`
	Channel rssChannel `xml:"channel"`
}

type rssChannel struct {
	Items []rssItem `xml:"item"`
}

type rssItem struct {
	Title          string         `xml:"title"`
	Link           string         `xml:"link"`
	Description    string         `xml:"description"`
	PubDate        string         `xml:"pubDate"`
	Category       string         `xml:"category"`
	Enclosure      rssEnclosure   `xml:"enclosure"`
	MediaContent   []rssMediaItem `xml:"http://search.yahoo.com/mrss/ content"`
	MediaThumbnail []rssMediaItem `xml:"http://search.yahoo.com/mrss/ thumbnail"`
}

type rssEnclosure struct {
	URL  string `xml:"url,attr"`
	Type string `xml:"type,attr"`
}

type rssMediaItem struct {
	URL    string `xml:"url,attr"`
	Medium string `xml:"medium,attr"`
}

// atomFeed represents an Atom feed
type atomFeed struct {
	XMLName xml.Name    `xml:"feed"`
	Entries []atomEntry `xml:"entry"`
}

type atomEntry struct {
	Title     string     `xml:"title"`
	Links     []atomLink `xml:"link"`
	Summary   string     `xml:"summary"`
	Published string     `xml:"published"`
	Updated   string     `xml:"updated"`
}

type atomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
	Type string `xml:"type,attr"`
}

// Fetch retrieves articles from an RSS source using stealth HTTP
func (f *RSSFetcher) Fetch(ctx context.Context, source NewsSource, limit int) ([]*NewsArticleRaw, error) {
	acceptHeader := "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
	body, _, err := f.client.FetchBytes(ctx, source.URL, acceptHeader)
	if err != nil {
		return nil, fmt.Errorf("fetch RSS: %w", err)
	}

	// Try RSS 2.0 first, then Atom
	articles, err := f.parseRSS(body, source)
	if err != nil {
		articles, err = f.parseAtom(body, source)
		if err != nil {
			return nil, fmt.Errorf("parse feed: %w", err)
		}
	}

	// Apply limit
	if limit > 0 && len(articles) > limit {
		articles = articles[:limit]
	}

	return articles, nil
}

func (f *RSSFetcher) parseRSS(body []byte, source NewsSource) ([]*NewsArticleRaw, error) {
	var feed rssFeed
	if err := xml.Unmarshal(body, &feed); err != nil {
		return nil, err
	}

	if len(feed.Channel.Items) == 0 {
		return nil, fmt.Errorf("no items in RSS feed")
	}

	var articles []*NewsArticleRaw
	for _, item := range feed.Channel.Items {
		publishedAt := parseRSSDate(item.PubDate)

		articles = append(articles, &NewsArticleRaw{
			Source:      source.SourceID,
			Headline:    strings.TrimSpace(item.Title),
			URL:         strings.TrimSpace(item.Link),
			PublishedAt: publishedAt,
			Summary:     truncateSummary(stripHTML(item.Description), 500),
			ImageURL:    extractRSSImage(item),
		})
	}

	return articles, nil
}

func (f *RSSFetcher) parseAtom(body []byte, source NewsSource) ([]*NewsArticleRaw, error) {
	var feed atomFeed
	if err := xml.Unmarshal(body, &feed); err != nil {
		return nil, err
	}

	if len(feed.Entries) == 0 {
		return nil, fmt.Errorf("no entries in Atom feed")
	}

	var articles []*NewsArticleRaw
	for _, entry := range feed.Entries {
		publishedAt := entry.Published
		if publishedAt == "" {
			publishedAt = entry.Updated
		}

		articles = append(articles, &NewsArticleRaw{
			Source:      source.SourceID,
			Headline:    strings.TrimSpace(entry.Title),
			URL:         strings.TrimSpace(primaryAtomLink(entry.Links)),
			PublishedAt: publishedAt,
			Summary:     truncateSummary(stripHTML(entry.Summary), 500),
			ImageURL:    extractAtomImage(entry),
		})
	}

	return articles, nil
}

// extractRSSImage returns the best available image URL for an RSS item.
// Tries media:content (preferred), then media:thumbnail, then enclosure.
// Returns "" if no image candidate is present.
func extractRSSImage(item rssItem) string {
	for _, m := range item.MediaContent {
		if m.URL != "" && (m.Medium == "" || m.Medium == "image") {
			return m.URL
		}
	}
	for _, m := range item.MediaThumbnail {
		if m.URL != "" {
			return m.URL
		}
	}
	if item.Enclosure.URL != "" && strings.HasPrefix(item.Enclosure.Type, "image/") {
		return item.Enclosure.URL
	}
	return ""
}

// extractAtomImage returns the first enclosure-type link with an image MIME.
func extractAtomImage(entry atomEntry) string {
	for _, l := range entry.Links {
		if l.Rel == "enclosure" && strings.HasPrefix(l.Type, "image/") && l.Href != "" {
			return l.Href
		}
	}
	return ""
}

// primaryAtomLink returns the article URL from an Atom <link> list.
// Atom entries can have multiple links (alternate, enclosure, related);
// prefer rel="alternate" (or unset rel), fall back to the first link.
func primaryAtomLink(links []atomLink) string {
	for _, l := range links {
		if (l.Rel == "" || l.Rel == "alternate") && l.Href != "" {
			return l.Href
		}
	}
	if len(links) > 0 {
		return links[0].Href
	}
	return ""
}

// parseRSSDate tries multiple date formats commonly used in RSS feeds
func parseRSSDate(dateStr string) string {
	dateStr = strings.TrimSpace(dateStr)
	if dateStr == "" {
		return time.Now().Format(time.RFC3339)
	}

	formats := []string{
		time.RFC1123Z,
		time.RFC1123,
		time.RFC3339,
		"Mon, 02 Jan 2006 15:04:05 -0700",
		"Mon, 2 Jan 2006 15:04:05 -0700",
		"2006-01-02T15:04:05Z",
		"2006-01-02 15:04:05",
	}

	for _, format := range formats {
		if t, err := time.Parse(format, dateStr); err == nil {
			return t.Format(time.RFC3339)
		}
	}

	log.Printf("  WARN: could not parse date: %s", dateStr)
	return time.Now().Format(time.RFC3339)
}

// stripHTML removes HTML tags from a string
func stripHTML(s string) string {
	var result strings.Builder
	inTag := false
	for _, r := range s {
		if r == '<' {
			inTag = true
			continue
		}
		if r == '>' {
			inTag = false
			continue
		}
		if !inTag {
			result.WriteRune(r)
		}
	}
	return strings.TrimSpace(result.String())
}

// truncateSummary truncates a summary to the given max length
func truncateSummary(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
