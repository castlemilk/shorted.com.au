package main

import (
	"context"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5/pgxpool"
)

// storeAsNewsArticles inserts ASX announcements into the news_articles table
func storeAsNewsArticles(ctx context.Context, db *pgxpool.Pool, code string, announcements []ASXAnnouncement) (int, error) {
	stored := 0
	for _, ann := range announcements {
		// Determine sentiment heuristic from headline
		sentiment := classifySentiment(ann.Headline)

		// Determine relevance score based on price sensitivity
		relevanceScore := 0.5
		if ann.IsPriceSens {
			relevanceScore = 0.9
		}

		query := fmt.Sprintf(
			`INSERT INTO news_articles (stock_code, source, headline, url, published_at, sentiment, relevance_score, is_price_sensitive, summary)
			 VALUES ('%s', 'asx', '%s', '%s', '%s'::timestamptz, '%s', %f, %t, '%s')
			 ON CONFLICT (url) DO NOTHING`,
			escapeSQLString(code),
			escapeSQLString(ann.Headline),
			escapeSQLString(ann.PDFURL),
			escapeSQLString(ann.Date+"T00:00:00+10:00"), // AEST timezone
			escapeSQLString(sentiment),
			relevanceScore,
			ann.IsPriceSens,
			escapeSQLString(classifyAnnouncementType(ann.Headline)+" announcement"), // Basic summary
		)

		tag, err := db.Exec(ctx, query)
		if err != nil {
			if *flagVerbose {
				log.Printf("    WARN: failed to insert news article for %s: %v", code, err)
			}
			continue
		}
		if tag.RowsAffected() > 0 {
			stored++
		}
	}
	return stored, nil
}

// classifySentiment does a simple keyword-based sentiment classification
// This will be enhanced with Gemini Flash in the news aggregator service
func classifySentiment(headline string) string {
	lower := headline
	// Simple heuristic — the news aggregator service will do proper Gemini classification
	positiveKeywords := []string{
		"profit", "earnings", "growth", "upgrade", "acquisition",
		"dividend", "record", "strong", "increase", "positive",
	}
	negativeKeywords := []string{
		"loss", "decline", "downgrade", "impairment", "suspension",
		"halt", "warning", "default", "breach", "negative",
	}

	for _, kw := range positiveKeywords {
		if contains(lower, kw) {
			return "positive"
		}
	}
	for _, kw := range negativeKeywords {
		if contains(lower, kw) {
			return "negative"
		}
	}
	return "neutral"
}

// contains is a case-insensitive contains helper
func contains(s, substr string) bool {
	return len(s) >= len(substr) && containsLower(toLower(s), toLower(substr))
}

func toLower(s string) string {
	b := make([]byte, len(s))
	for i := range s {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		b[i] = c
	}
	return string(b)
}

func containsLower(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
