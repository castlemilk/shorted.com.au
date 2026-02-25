package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewsStore handles inserting news articles into PostgreSQL
type NewsStore struct {
	db      *pgxpool.Pool
	verbose bool
}

// NewNewsStore creates a new news store
func NewNewsStore(db *pgxpool.Pool, verbose bool) *NewsStore {
	return &NewsStore{db: db, verbose: verbose}
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

		// Simple sentiment heuristic (to be replaced by Gemini Flash)
		sentiment := classifySimpleSentiment(a.Headline)

		relevanceScore := 0.5
		if a.IsPriceSensitive {
			relevanceScore = 0.9
		}

		query := fmt.Sprintf(
			`INSERT INTO news_articles (stock_code, source, headline, url, published_at, sentiment, relevance_score, is_price_sensitive, summary)
			 VALUES ('%s', '%s', '%s', '%s', '%s'::timestamptz, '%s', %f, %t, '%s')
			 ON CONFLICT (url) DO NOTHING`,
			escapeSQLStr(stockCode),
			escapeSQLStr(a.Source),
			escapeSQLStr(a.Headline),
			escapeSQLStr(a.URL),
			escapeSQLStr(a.PublishedAt),
			escapeSQLStr(sentiment),
			relevanceScore,
			a.IsPriceSensitive,
			escapeSQLStr(truncateStr(a.Summary, 1000)),
		)

		tag, err := s.db.Exec(ctx, query)
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

// escapeSQLStr escapes single quotes for safe SQL string literals
func escapeSQLStr(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

// truncateStr truncates a string to the given max length
func truncateStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
