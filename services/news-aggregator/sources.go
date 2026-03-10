package main

// NewsSource represents an RSS/Atom feed source configuration
type NewsSource struct {
	Name         string
	URL          string
	SourceID     string // Identifier used in news_articles.source
	StockCodeFn  func(title string) string // Optional: extract stock code from title
	IsTrusted    bool   // Trusted sources get higher relevance scores
}

// GetDefaultSources returns the configured RSS feed sources for Australian market news.
// All feeds verified working with native stealth engine (Mar 2026).
// Chromium engine must NOT be used — it overrides Accept headers and returns HTML.
func GetDefaultSources() []NewsSource {
	return []NewsSource{
		{
			Name:      "Stockhead",
			URL:       "https://stockhead.com.au/feed/",
			SourceID:  "stockhead",
			IsTrusted: true,
		},
		{
			Name:      "Small Caps",
			URL:       "https://smallcaps.com.au/feed/",
			SourceID:  "smallcaps",
			IsTrusted: false,
		},
		{
			Name:      "Motley Fool AU",
			URL:       "https://www.fool.com.au/feed/",
			SourceID:  "motleyfool",
			IsTrusted: true,
		},
		{
			Name:      "Kalkine Media",
			URL:       "https://kalkinemedia.com/au/feed",
			SourceID:  "kalkine",
			IsTrusted: false,
		},
		{
			Name:      "Google News ASX",
			URL:       "https://news.google.com/rss/search?q=ASX+stocks&hl=en-AU&gl=AU&ceid=AU:en",
			SourceID:  "googlenews",
			IsTrusted: true,
		},
	}
}
