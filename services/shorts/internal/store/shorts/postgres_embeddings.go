package shorts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// GetRelatedNews returns news articles semantically nearest to an anchor article,
// ranked by cosine distance over the embeddings table.
//
// If articleID is empty, the stock's latest cluster-primary article is used as the
// anchor. Results exclude the anchor itself and prefer cluster-primary rows.
//
// By design, results are NOT scoped to stockCode — the rail surfaces semantically
// related coverage across the market (the caller may render the foreign ticker).
// stockCode is used only to resolve the anchor when articleID is empty.
//
// Contract: if the anchor article has no embedding row yet (backfill lag), this
// returns (nil, nil). Callers should treat an empty result as "not ready yet",
// not "no related news exists".
//
// The anchor embedding is fetched and passed back as a $N::vector LITERAL (not a
// correlated subquery / CROSS JOIN) so the planner uses the pgvector HNSW index;
// an exact KNN over the full table would otherwise time out at scale.
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
			if errors.Is(err, pgx.ErrNoRows) {
				// No news for this stock yet → no related news (not an error to the caller).
				return nil, nil
			}
			return nil, fmt.Errorf("failed to resolve anchor article: %w", err)
		}
	}

	// Fetch the anchor's embedding as a pgvector text literal ('[v1,v2,...]'). Passing
	// it back as a $1::vector literal lets the planner use the HNSW index; a correlated
	// CROSS JOIN / subquery forces an exact full-scan KNN that times out at scale.
	var anchorEmbedding string
	if err := s.db.QueryRow(ctx, `
		SELECT embedding::text
		FROM embeddings
		WHERE object_type = 'news_article' AND object_id = $1
		LIMIT 1`, articleID).Scan(&anchorEmbedding); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Anchor not embedded yet (backfill lag) → "not ready", not an error.
			return nil, nil
		}
		return nil, fmt.Errorf("failed to fetch anchor embedding: %w", err)
	}

	query := `
		SELECT n.id, n.stock_code, n.source, n.headline, n.url, n.published_at,
		       n.sentiment, n.relevance_score, n.is_price_sensitive, n.summary, n.tags, n.image_url
		FROM embeddings e
		JOIN news_articles n ON n.id = e.object_id::uuid
		WHERE e.object_type = 'news_article'
		  AND e.object_id <> $2
		  AND (n.cluster_id IS NULL OR n.cluster_is_primary = TRUE)
		ORDER BY e.embedding <=> $1::vector
		LIMIT $3`

	rows, err := s.db.Query(ctx, query, anchorEmbedding, articleID, limit)
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
