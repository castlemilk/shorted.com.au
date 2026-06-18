package main

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"

	"github.com/google/generative-ai-go/genai"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/option"
)

const (
	embeddingModel = "text-embedding-004" // 768-dim, matches embeddings.vector(768)
	embedBatchSize = 50
)

// Embedder wraps a Gemini embedding model.
type Embedder struct {
	client *genai.Client
	model  *genai.EmbeddingModel
}

// NewEmbedder constructs a Gemini-backed embedder. Reuses GEMINI_API_KEY.
func NewEmbedder(ctx context.Context, apiKey string) (*Embedder, error) {
	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		return nil, fmt.Errorf("create genai client: %w", err)
	}
	return &Embedder{client: client, model: client.EmbeddingModel(embeddingModel)}, nil
}

// Close releases the underlying client.
func (e *Embedder) Close() error { return e.client.Close() }

// EmbedBatch returns one 768-float vector per input text, preserving order.
func (e *Embedder) EmbedBatch(ctx context.Context, texts []string) ([][]float32, error) {
	b := e.model.NewBatch()
	for _, t := range texts {
		b.AddContent(genai.Text(t))
	}
	res, err := e.model.BatchEmbedContents(ctx, b)
	if err != nil {
		return nil, fmt.Errorf("batch embed: %w", err)
	}
	out := make([][]float32, len(res.Embeddings))
	for i, emb := range res.Embeddings {
		out[i] = emb.Values
	}
	return out, nil
}

// buildEmbedText composes the text we embed for a news article.
func buildEmbedText(headline, summary string) string {
	headline = strings.TrimSpace(headline)
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return headline
	}
	return headline + "\n\n" + summary
}

// formatVector renders a float slice as a pgvector literal: [v1,v2,...].
// Used with $N::vector casts so it works under SimpleProtocol pooling.
func formatVector(vals []float32) string {
	var sb strings.Builder
	sb.WriteByte('[')
	for i, v := range vals {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(strconv.FormatFloat(float64(v), 'f', -1, 32))
	}
	sb.WriteByte(']')
	return sb.String()
}

// EmbedBackfillOpts controls a backfill run.
type EmbedBackfillOpts struct {
	Limit int // max articles to embed this run (0 = a single default batch)
}

// EmbedBackfill embeds news_articles that have no embedding yet and writes them
// to the embeddings table. Idempotent: skips articles already embedded.
func EmbedBackfill(ctx context.Context, db *pgxpool.Pool, embedder *Embedder, opts EmbedBackfillOpts) (int, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = embedBatchSize
	}

	rows, err := db.Query(ctx, `
		SELECT n.id::text, n.headline, COALESCE(n.summary, '')
		FROM news_articles n
		WHERE NOT EXISTS (
			SELECT 1 FROM embeddings e
			WHERE e.object_type = 'news_article' AND e.object_id = n.id::text
		)
		ORDER BY n.published_at DESC
		LIMIT $1`, limit)
	if err != nil {
		return 0, fmt.Errorf("select unembedded articles: %w", err)
	}

	var ids, texts []string
	for rows.Next() {
		var id, headline, summary string
		if err := rows.Scan(&id, &headline, &summary); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan article: %w", err)
		}
		ids = append(ids, id)
		texts = append(texts, buildEmbedText(headline, summary))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate articles: %w", err)
	}
	if len(ids) == 0 {
		return 0, nil
	}

	// Embed + write in chunks of embedBatchSize so a large Limit never exceeds
	// the model's per-request batch cap (the candidate set can be > one batch).
	written := 0
	for start := 0; start < len(ids); start += embedBatchSize {
		end := start + embedBatchSize
		if end > len(ids) {
			end = len(ids)
		}
		batchIDs, batchTexts := ids[start:end], texts[start:end]

		vectors, err := embedder.EmbedBatch(ctx, batchTexts)
		if err != nil {
			return written, err
		}
		if len(vectors) != len(batchIDs) {
			return written, fmt.Errorf("embedding count mismatch: got %d for %d articles", len(vectors), len(batchIDs))
		}

		for i, id := range batchIDs {
			_, err := db.Exec(ctx, `
				INSERT INTO embeddings (object_type, object_id, chunk_idx, embedding, model)
				VALUES ('news_article', $1, 0, $2::vector, $3)
				ON CONFLICT (object_type, object_id, chunk_idx)
				DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model`,
				id, formatVector(vectors[i]), embeddingModel)
			if err != nil {
				log.Printf("  WARN: failed to write embedding for %s: %v", id, err)
				continue
			}
			written++
		}
	}
	if failed := len(ids) - written; failed > 0 {
		log.Printf("  WARN: failed to write %d/%d embeddings", failed, len(ids))
	}
	return written, nil
}
