package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/generative-ai-go/genai"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
)

const (
	// gemini-embedding-001 is MRL-trained (3072 default dims). We truncate to the
	// first embeddingDims — a valid lower-dim embedding — to match embeddings.vector(768).
	// (text-embedding-004 was retired; this model only supports embedContent, not the
	// synchronous batch method, so EmbedBatch loops single calls.)
	embeddingModel   = "gemini-embedding-001"
	embeddingDims    = 768
	embedBatchSize   = 200 // rows selected + written per backfill chunk
	embedConcurrency = 8   // parallel EmbedContent calls per chunk
	embedMaxRetries  = 5   // retry/backoff on rate-limit / 5xx
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

// embedOne embeds a single text (gemini-embedding-001 only supports single
// embedContent), MRL-truncated to embeddingDims, with retry/backoff on transient
// errors. Cosine distance is scale-invariant so the truncated vector needs no
// renormalization.
func (e *Embedder) embedOne(ctx context.Context, text string) ([]float32, error) {
	var lastErr error
	for attempt := 0; attempt <= embedMaxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(1<<(attempt-1)) * 400 * time.Millisecond
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}
		res, err := e.model.EmbedContent(ctx, genai.Text(text))
		if err != nil {
			recordNewsGeminiEmbedding(ctx, "news_embedding", embeddingModel, "embed_content", "error", len([]rune(text)))
			lastErr = err
			if isRetryableEmbedErr(err) {
				continue
			}
			return nil, err
		}
		recordNewsGeminiEmbedding(ctx, "news_embedding", embeddingModel, "embed_content", "success", len([]rune(text)))
		if res.Embedding == nil || len(res.Embedding.Values) < embeddingDims {
			got := 0
			if res.Embedding != nil {
				got = len(res.Embedding.Values)
			}
			return nil, fmt.Errorf("embedding too short: got %d, need %d", got, embeddingDims)
		}
		return res.Embedding.Values[:embeddingDims], nil
	}
	return nil, fmt.Errorf("embed failed after %d retries: %w", embedMaxRetries, lastErr)
}

// isRetryableEmbedErr reports whether a Gemini error is transient (rate limit or
// 5xx) and worth retrying.
func isRetryableEmbedErr(err error) bool {
	var gerr *googleapi.Error
	if errors.As(err, &gerr) {
		return gerr.Code == 429 || gerr.Code >= 500
	}
	return false
}

// EmbedBatch returns one embeddingDims-length vector per input text, preserving
// order, fanning the per-text embedContent calls across embedConcurrency workers.
// Items that fail after retries are left nil — callers skip them and the
// idempotent backfill retries them on a later run.
func (e *Embedder) EmbedBatch(ctx context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	sem := make(chan struct{}, embedConcurrency)
	var wg sync.WaitGroup
	for i, t := range texts {
		// Acquire a slot before Add() so the WaitGroup stays balanced if ctx
		// is cancelled mid-dispatch (a deadline-carrying ctx from a future
		// query-time caller).
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			wg.Wait()
			return out, ctx.Err()
		}
		wg.Add(1)
		go func(i int, t string) {
			defer wg.Done()
			defer func() { <-sem }()
			v, err := e.embedOne(ctx, t)
			if err != nil {
				log.Printf("  WARN: embed failed (item %d): %v", i, err)
				return // leave out[i] nil; retried on a later run
			}
			out[i] = v
		}(i, t)
	}
	wg.Wait()
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
			if vectors[i] == nil {
				continue // embed failed after retries; retried on a later run
			}
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
