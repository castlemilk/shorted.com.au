package main

import (
	"context"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5/pgxpool"
)

// fetchExistingNewsURLs loads the article URLs already stored for a stock code.
// news_articles dedups on UNIQUE(url), so one indexed read per stock
// (idx_news_articles_stock_code_published) lets us skip the announcements that
// are already mirrored instead of firing a no-op INSERT for each one.
func fetchExistingNewsURLs(ctx context.Context, db *pgxpool.Pool, code string) (map[string]struct{}, error) {
	rows, err := db.Query(ctx, `SELECT url FROM news_articles WHERE stock_code = $1`, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	existing := make(map[string]struct{})
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			continue
		}
		existing[url] = struct{}{}
	}
	return existing, rows.Err()
}

// storeAsNewsArticles inserts ASX announcements into the news_articles table,
// pre-filtering on the already-stored URLs and batching the remainder into
// multi-row parameterized INSERTs.
func storeAsNewsArticles(ctx context.Context, db *pgxpool.Pool, code string, announcements []ASXAnnouncement) (storeCounts, error) {
	counts := storeCounts{scanned: len(announcements)}

	existing, err := fetchExistingNewsURLs(ctx, db, code)
	if err != nil {
		return counts, fmt.Errorf("fetch existing news urls: %w", err)
	}

	fresh := filterNewNewsArticles(announcements, existing)
	counts.skipped = counts.scanned - len(fresh)
	if len(fresh) == 0 {
		return counts, nil
	}

	for _, batch := range chunkAnnouncements(fresh, maxInsertRowsPerStatement) {
		query, args := buildNewsArticleInsert(code, batch)
		tag, err := db.Exec(ctx, query, args...)
		if err != nil {
			if *flagVerbose {
				log.Printf("    WARN: failed to insert %d news articles for %s: %v", len(batch), code, err)
			}
			continue
		}
		counts.inserted += int(tag.RowsAffected())
	}
	return counts, nil
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
