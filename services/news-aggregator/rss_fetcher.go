package main

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// RSSFetcher fetches and parses RSS/Atom feeds
type RSSFetcher struct {
	client  *http.Client
	verbose bool
}

// NewRSSFetcher creates a new RSS fetcher
func NewRSSFetcher(verbose bool) *RSSFetcher {
	return &RSSFetcher{
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		verbose: verbose,
	}
}

// NewsArticleRaw represents a raw article parsed from an RSS feed
type NewsArticleRaw struct {
	StockCode        string
	Source           string
	Headline         string
	URL              string
	PublishedAt      string
	Summary          string
	IsPriceSensitive bool
}

// rssFeed represents a generic RSS 2.0 feed
type rssFeed struct {
	XMLName xml.Name   `xml:"rss"`
	Channel rssChannel `xml:"channel"`
}

type rssChannel struct {
	Items []rssItem `xml:"item"`
}

type rssItem struct {
	Title       string `xml:"title"`
	Link        string `xml:"link"`
	Description string `xml:"description"`
	PubDate     string `xml:"pubDate"`
	Category    string `xml:"category"`
}

// atomFeed represents an Atom feed
type atomFeed struct {
	XMLName xml.Name    `xml:"feed"`
	Entries []atomEntry `xml:"entry"`
}

type atomEntry struct {
	Title     string   `xml:"title"`
	Link      atomLink `xml:"link"`
	Summary   string   `xml:"summary"`
	Published string   `xml:"published"`
	Updated   string   `xml:"updated"`
}

type atomLink struct {
	Href string `xml:"href,attr"`
}

// Fetch retrieves articles from an RSS source
func (f *RSSFetcher) Fetch(ctx context.Context, source NewsSource, limit int) ([]*NewsArticleRaw, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", source.URL, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("User-Agent", "ShortedNewsAggregator/1.0 (+https://shorted.com.au)")
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml")

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch RSS: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("RSS returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
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
			URL:         strings.TrimSpace(entry.Link.Href),
			PublishedAt: publishedAt,
			Summary:     truncateSummary(stripHTML(entry.Summary), 500),
		})
	}

	return articles, nil
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
