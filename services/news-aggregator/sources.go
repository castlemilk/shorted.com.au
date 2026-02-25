package main

// NewsSource represents an RSS/Atom feed source configuration
type NewsSource struct {
	Name         string
	URL          string
	SourceID     string // Identifier used in news_articles.source
	StockCodeFn  func(title string) string // Optional: extract stock code from title
	IsTrusted    bool   // Trusted sources get higher relevance scores
}

// GetDefaultSources returns the configured RSS feed sources for Australian market news
func GetDefaultSources() []NewsSource {
	return []NewsSource{
		{
			Name:      "Stockhead",
			URL:       "https://stockhead.com.au/feed/",
			SourceID:  "stockhead",
			IsTrusted: true,
		},
		{
			Name:      "Livewire Markets",
			URL:       "https://www.livewiremarkets.com/rss",
			SourceID:  "livewire",
			IsTrusted: true,
		},
		{
			Name:      "Market Index News",
			URL:       "https://www.marketindex.com.au/news/rss",
			SourceID:  "marketindex",
			IsTrusted: false,
		},
		{
			Name:      "Small Caps",
			URL:       "https://smallcaps.com.au/feed/",
			SourceID:  "smallcaps",
			IsTrusted: false,
		},
	}
}
