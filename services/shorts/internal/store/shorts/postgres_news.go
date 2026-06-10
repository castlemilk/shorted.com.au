package shorts

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// GetStockNews retrieves news articles for a specific stock
func (s *postgresStore) GetStockNews(stockCode string, limit int32, source, sentiment string) ([]*NewsArticle, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `SELECT n.id, n.stock_code, n.source, n.headline, n.url, n.published_at,
		       n.sentiment, n.relevance_score, n.is_price_sensitive, n.summary, n.tags, n.image_url,
		       COALESCE(c.cnt, 1) AS syndication_count,
		       COALESCE(c.sources, '{}')::text[] AS syndicated_sources
		FROM news_articles n
		LEFT JOIN LATERAL (
		    SELECT COUNT(*) AS cnt,
		           ARRAY_AGG(DISTINCT m.source) FILTER (WHERE m.id <> n.id) AS sources
		    FROM news_articles m
		    WHERE m.cluster_id = n.cluster_id
		) c ON n.cluster_id IS NOT NULL
		WHERE (n.cluster_id IS NULL OR n.cluster_is_primary = TRUE)
		AND n.stock_code = $1`
	args := []interface{}{stockCode}
	argIdx := 2

	if source != "" {
		query += fmt.Sprintf(" AND n.source = $%d", argIdx)
		args = append(args, source)
		argIdx++
	}
	if sentiment != "" {
		query += fmt.Sprintf(" AND n.sentiment = $%d", argIdx)
		args = append(args, sentiment)
		argIdx++
	}

	query += " ORDER BY n.published_at DESC"

	if limit > 0 {
		query += fmt.Sprintf(" LIMIT $%d", argIdx)
		args = append(args, limit)
	}

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query stock news: %w", err)
	}
	defer rows.Close()

	var articles []*NewsArticle
	for rows.Next() {
		a := &NewsArticle{}
		var tags []byte
		if err := rows.Scan(
			&a.ID, &a.StockCode, &a.Source, &a.Headline, &a.URL,
			&a.PublishedAt, &a.Sentiment, &a.RelevanceScore,
			&a.IsPriceSensitive, &a.Summary, &tags, &a.ImageURL,
			&a.SyndicationCount, &a.SyndicatedSources,
		); err != nil {
			return nil, 0, fmt.Errorf("failed to scan news article: %w", err)
		}
		a.Tags = tags
		articles = append(articles, a)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating news rows: %w", err)
	}

	return articles, len(articles), nil
}

// GetMarketNews retrieves market-wide news articles
func (s *postgresStore) GetMarketNews(limit int32, source string, priceSensitiveOnly bool) ([]*NewsArticle, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	query := `SELECT n.id, n.stock_code, n.source, n.headline, n.url, n.published_at,
		       n.sentiment, n.relevance_score, n.is_price_sensitive, n.summary, n.tags, n.image_url,
		       COALESCE(c.cnt, 1) AS syndication_count,
		       COALESCE(c.sources, '{}')::text[] AS syndicated_sources
		FROM news_articles n
		LEFT JOIN LATERAL (
		    SELECT COUNT(*) AS cnt,
		           ARRAY_AGG(DISTINCT m.source) FILTER (WHERE m.id <> n.id) AS sources
		    FROM news_articles m
		    WHERE m.cluster_id = n.cluster_id
		) c ON n.cluster_id IS NOT NULL
		WHERE (n.cluster_id IS NULL OR n.cluster_is_primary = TRUE)`
	args := []interface{}{}
	argIdx := 1

	if source != "" {
		query += fmt.Sprintf(" AND n.source = $%d", argIdx)
		args = append(args, source)
		argIdx++
	}
	if priceSensitiveOnly {
		// boolean inlined — no argIdx increment needed
		query += " AND n.is_price_sensitive = TRUE"
	}

	query += " ORDER BY n.published_at DESC"

	if limit > 0 {
		query += fmt.Sprintf(" LIMIT $%d", argIdx)
		args = append(args, limit)
	}

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query market news: %w", err)
	}
	defer rows.Close()

	var articles []*NewsArticle
	for rows.Next() {
		a := &NewsArticle{}
		var tags []byte
		if err := rows.Scan(
			&a.ID, &a.StockCode, &a.Source, &a.Headline, &a.URL,
			&a.PublishedAt, &a.Sentiment, &a.RelevanceScore,
			&a.IsPriceSensitive, &a.Summary, &tags, &a.ImageURL,
			&a.SyndicationCount, &a.SyndicatedSources,
		); err != nil {
			return nil, 0, fmt.Errorf("failed to scan news article: %w", err)
		}
		a.Tags = tags
		articles = append(articles, a)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("error iterating market news rows: %w", err)
	}

	return articles, len(articles), nil
}

// NewsArticleToTags converts raw JSON tags to string slice
func NewsArticleToTags(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	var tags []string
	if err := json.Unmarshal(raw, &tags); err != nil {
		return nil
	}
	return tags
}
