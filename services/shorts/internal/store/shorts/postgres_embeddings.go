package shorts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// relatedNewsANNQuery is the cosine-ANN query behind GetRelatedNews. The anchor
// embedding is passed as the $1::vector LITERAL ($2 = anchor id to exclude, $3 =
// limit) so the planner can use the pgvector HNSW index (idx_embeddings_hnsw) —
// a correlated CROSS JOIN / subquery forces an exact full-scan KNN that times out
// at scale. Kept as a package constant so the integration test EXPLAINs the exact
// query and asserts the index is used.
const relatedNewsANNQuery = `
	SELECT n.id, n.stock_code, n.source, n.headline, n.url, n.published_at,
	       n.sentiment, n.relevance_score, n.is_price_sensitive, n.summary, n.tags, n.image_url
	FROM embeddings e
	JOIN news_articles n ON n.id = e.object_id::uuid
	WHERE e.object_type = 'news_article'
	  AND e.object_id <> $2
	  AND (n.cluster_id IS NULL OR n.cluster_is_primary = TRUE)
	ORDER BY e.embedding <=> $1::vector
	LIMIT $3`

// GetRelatedNews returns news articles semantically nearest to an anchor article,
// ranked by cosine distance over the embeddings table.
//
// If articleID is empty, the anchor is the stock's latest cluster-primary article
// that already has an embedding (not the absolute-latest, which is often a
// just-arrived, not-yet-embedded row). Results exclude the anchor and prefer
// cluster-primary rows.
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

	// Resolve the anchor + its embedding. The text-form embedding ('[v1,v2,...]') is
	// passed back as a $1::vector LITERAL so the planner uses the HNSW index (a
	// correlated CROSS JOIN / subquery forces an exact full-scan KNN that times out).
	var anchorEmbedding string
	if articleID == "" {
		// Anchor on the latest cluster-primary article for the stock that ALREADY has
		// an embedding. Anchoring on the absolute-latest article would frequently hit
		// a just-arrived, not-yet-embedded row (embed lag) and return an empty rail.
		if err := s.db.QueryRow(ctx, `
			SELECT n.id::text, e.embedding::text
			FROM news_articles n
			JOIN embeddings e ON e.object_type = 'news_article' AND e.object_id = n.id::text
			WHERE n.stock_code = $1 AND (n.cluster_id IS NULL OR n.cluster_is_primary = TRUE)
			ORDER BY n.published_at DESC
			LIMIT 1`, stockCode).Scan(&articleID, &anchorEmbedding); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, nil // no embedded news for this stock yet → "not ready"
			}
			return nil, fmt.Errorf("failed to resolve anchor: %w", err)
		}
	} else {
		if err := s.db.QueryRow(ctx, `
			SELECT embedding::text
			FROM embeddings
			WHERE object_type = 'news_article' AND object_id = $1
			LIMIT 1`, articleID).Scan(&anchorEmbedding); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, nil // explicit anchor not embedded yet → "not ready"
			}
			return nil, fmt.Errorf("failed to fetch anchor embedding: %w", err)
		}
	}

	rows, err := s.db.Query(ctx, relatedNewsANNQuery, anchorEmbedding, articleID, limit)
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
