package shorts

import (
	"context"
	"fmt"
	"time"
)

// GetRelatedNews returns news articles semantically nearest to an anchor article.
// If articleID is empty, the stock's latest primary article is used as the anchor.
// Results exclude the anchor itself and prefer cluster-primary rows.
func (s *postgresStore) GetRelatedNews(stockCode, articleID string, limit int32) ([]*NewsArticle, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 6
	}

	// Resolve the anchor article if not supplied.
	if articleID == "" {
		err := s.db.QueryRow(ctx, `
			SELECT id::text
			FROM news_articles
			WHERE stock_code = $1
			  AND (cluster_id IS NULL OR cluster_is_primary = TRUE)
			ORDER BY published_at DESC
			LIMIT 1`, stockCode).Scan(&articleID)
		if err != nil {
			// No news for this stock yet → no related news (not an error to the caller).
			return nil, nil
		}
	}

	query := `
		WITH anchor AS (
			SELECT embedding
			FROM embeddings
			WHERE object_type = 'news_article' AND object_id = $1
			LIMIT 1
		)
		SELECT n.id, n.stock_code, n.source, n.headline, n.url, n.published_at,
		       n.sentiment, n.relevance_score, n.is_price_sensitive, n.summary, n.tags, n.image_url
		FROM embeddings e
		JOIN news_articles n ON n.id = e.object_id::uuid
		CROSS JOIN anchor a
		WHERE e.object_type = 'news_article'
		  AND e.object_id <> $1
		  AND (n.cluster_id IS NULL OR n.cluster_is_primary = TRUE)
		ORDER BY e.embedding <=> a.embedding
		LIMIT $2`

	rows, err := s.db.Query(ctx, query, articleID, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query related news: %w", err)
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
		); err != nil {
			return nil, fmt.Errorf("failed to scan related news: %w", err)
		}
		a.Tags = tags
		a.SyndicationCount = 1 // related rail does not aggregate clusters
		articles = append(articles, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating related news rows: %w", err)
	}
	return articles, nil
}
