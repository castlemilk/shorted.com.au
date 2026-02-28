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

	stored := 0
	for _, a := range articles {
		if a.URL == "" || a.Headline == "" {
			continue
		}

		// Default stock code for market-wide news
		stockCode := a.StockCode
		if stockCode == "" {
			stockCode = "MARKET" // General market news
		}

		// Classify sentiment (use analyzer if available, otherwise simple heuristic)
		sentiment := s.classifySentiment(ctx, a.Headline)

		relevanceScore := 0.5
		if a.IsPriceSensitive {
			relevanceScore = 0.9
		}

		tag, err := s.db.Exec(ctx,
			`INSERT INTO news_articles (stock_code, source, headline, url, published_at, sentiment, relevance_score, is_price_sensitive, summary)
			 VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9)
			 ON CONFLICT (url) DO NOTHING`,
			stockCode,
			a.Source,
			a.Headline,
			a.URL,
			a.PublishedAt,
			sentiment,
			relevanceScore,
			a.IsPriceSensitive,
			truncateStr(a.Summary, 1000),
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

// classifySentiment uses the AI analyzer if available, falling back to keyword heuristic
func (s *NewsStore) classifySentiment(ctx context.Context, headline string) string {
	if s.analyzer != nil {
		results, err := s.analyzer.AnalyzeBatch(ctx, []string{headline})
		if err == nil && len(results) > 0 {
			return results[0]
		}
	}
	return classifySimpleSentiment(headline)
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
