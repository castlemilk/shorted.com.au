package main

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewsStore handles inserting news articles into PostgreSQL
type NewsStore struct {
	db       *pgxpool.Pool
	verbose  bool
	analyzer *SentimentAnalyzer
}

// NewNewsStore creates a new news store
func NewNewsStore(db *pgxpool.Pool, verbose bool, analyzer *SentimentAnalyzer) *NewsStore {
	return &NewsStore{db: db, verbose: verbose, analyzer: analyzer}
}

// StoreArticles inserts articles into the news_articles table, deduplicating by URL
func (s *NewsStore) StoreArticles(ctx context.Context, articles []*NewsArticleRaw) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Filter valid articles first
	var valid []*NewsArticleRaw
	for _, a := range articles {
		if a.URL != "" && a.Headline != "" {
			valid = append(valid, a)
		}
	}
	if len(valid) == 0 {
		return 0, nil
	}

	// Pre-filter: skip URLs already stored. The aggregator re-sees the same RSS
	// items every run, so without this it re-attempted ~every article every run
	// (tens of millions of no-op INSERTs against the url unique index — the
	// single most-called statement in prod). Image backfill for existing rows is
	// handled separately by RUN_MODE=backfill-images. On error this degrades to
	// the previous "insert all" behaviour (no regression).
	urls := make([]string, len(valid))
	for i, a := range valid {
		urls[i] = a.URL
	}
	existing := make(map[string]struct{}, len(urls))
	if rows, err := s.db.Query(ctx, `SELECT url FROM news_articles WHERE url = ANY($1)`, urls); err != nil {
		if s.verbose {
			log.Printf("    WARN: pre-filter of existing urls failed, inserting all: %v", err)
		}
	} else {
		for rows.Next() {
			var u string
			if rows.Scan(&u) == nil {
				existing[u] = struct{}{}
			}
		}
		rows.Close()
	}

	var fresh []*NewsArticleRaw
	for _, a := range valid {
		if _, seen := existing[a.URL]; !seen {
			fresh = append(fresh, a)
		}
	}
	if len(fresh) == 0 {
		return 0, nil
	}

	// Sentiment analysis only for the new articles (also saves Gemini tokens).
	sentiments := s.classifySentimentBatch(ctx, fresh)

	stored := 0
	for i, a := range fresh {
		stockCode := a.StockCode
		if stockCode == "" {
			stockCode = "MARKET"
		}

		relevanceScore := 0.5
		if a.IsPriceSensitive {
			relevanceScore = 0.9
		}

		var imageURL interface{}
		var imagePulledAt interface{}
		if a.ImageURL != "" {
			imageURL = a.ImageURL
			imagePulledAt = time.Now()
		}

		tag, err := s.db.Exec(ctx,
			`INSERT INTO news_articles (stock_code, source, headline, url, published_at, sentiment, relevance_score, is_price_sensitive, summary, image_url, image_pulled_at)
			 VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11)
			 ON CONFLICT (url) DO NOTHING`,
			stockCode,
			a.Source,
			a.Headline,
			a.URL,
			a.PublishedAt,
			sentiments[i],
			relevanceScore,
			a.IsPriceSensitive,
			truncateStr(a.Summary, 1000),
			imageURL,
			imagePulledAt,
		)
		if err != nil {
			if s.verbose {
				log.Printf("    WARN: failed to insert article: %v", err)
			}
			continue
		}
		if tag.RowsAffected() > 0 {
			stored++
		}
	}

	return stored, nil
}

// classifySentimentBatch analyzes all article headlines in a single Gemini call.
// Falls back to keyword heuristic per-headline on error.
func (s *NewsStore) classifySentimentBatch(ctx context.Context, articles []*NewsArticleRaw) []string {
	sentiments := make([]string, len(articles))

	// Collect headlines for batch analysis
	headlines := make([]string, len(articles))
	for i, a := range articles {
		headlines[i] = a.Headline
	}

	// Try batch AI analysis (single Gemini call for all headlines)
	if s.analyzer != nil {
		results, err := s.analyzer.AnalyzeBatch(ctx, headlines)
		if err == nil && len(results) == len(headlines) {
			return results
		}
		// Partial or failed — fall through to heuristic
		if s.verbose && err != nil {
			log.Printf("    WARN: batch sentiment analysis failed: %v, using heuristic", err)
		}
	}

	// Fallback: keyword heuristic per headline
	for i, a := range articles {
		sentiments[i] = classifySimpleSentiment(a.Headline)
	}
	return sentiments
}

// classifySimpleSentiment does basic keyword-based sentiment analysis
func classifySimpleSentiment(headline string) string {
	lower := strings.ToLower(headline)

	positive := []string{"profit", "growth", "upgrade", "acquisition", "dividend", "record", "surge", "rally", "gain"}
	negative := []string{"loss", "decline", "downgrade", "impairment", "warning", "crash", "plunge", "slump", "risk"}

	for _, kw := range positive {
		if strings.Contains(lower, kw) {
			return "positive"
		}
	}
	for _, kw := range negative {
		if strings.Contains(lower, kw) {
			return "negative"
		}
	}
	return "neutral"
}

// truncateStr truncates a string to the given max length
func truncateStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
