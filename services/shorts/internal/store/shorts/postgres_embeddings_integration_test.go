//go:build integration
// +build integration

package shorts

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// startPgvector boots a pgvector-enabled Postgres and applies the minimal schema this test needs.
func startPgvector(t *testing.T) (*pgxpool.Pool, func()) {
	t.Helper()
	ctx := context.Background()
	container, err := postgres.Run(ctx,
		"pgvector/pgvector:pg16",
		postgres.WithDatabase("shorts_test"),
		postgres.WithUsername("test_user"),
		postgres.WithPassword("test_password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	require.NoError(t, err)

	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	poolConfig, err := pgxpool.ParseConfig(dsn)
	require.NoError(t, err)
	// Match production: use simple protocol so timestamptz scans as string.
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `
		CREATE EXTENSION IF NOT EXISTS vector;
		CREATE TABLE news_articles (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			stock_code VARCHAR(10) NOT NULL,
			source VARCHAR(50) NOT NULL,
			headline TEXT NOT NULL,
			url TEXT NOT NULL,
			published_at TIMESTAMPTZ NOT NULL,
			sentiment VARCHAR(20),
			relevance_score DOUBLE PRECISION DEFAULT 0,
			is_price_sensitive BOOLEAN DEFAULT FALSE,
			summary TEXT,
			tags JSONB DEFAULT '[]'::jsonb,
			image_url TEXT,
			cluster_id UUID,
			cluster_is_primary BOOLEAN
		);
		CREATE TABLE embeddings (
			id BIGSERIAL PRIMARY KEY,
			object_type TEXT NOT NULL,
			object_id TEXT NOT NULL,
			chunk_idx INTEGER NOT NULL DEFAULT 0,
			embedding vector(3) NOT NULL,
			model TEXT NOT NULL,
			UNIQUE (object_type, object_id, chunk_idx)
		);
		CREATE INDEX idx_embeddings_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops);`)
	require.NoError(t, err)

	cleanup := func() {
		pool.Close()
		_ = container.Terminate(ctx)
	}
	return pool, cleanup
}

func TestGetRelatedNews_ReturnsNearestFirst(t *testing.T) {
	pool, cleanup := startPgvector(t)
	defer cleanup()
	ctx := context.Background()

	seed := func(id, headline, vec string) {
		_, err := pool.Exec(ctx, `INSERT INTO news_articles (id, stock_code, source, headline, url, published_at)
			VALUES ($1, 'BHP', 'stockhead', $2, $3, now())`, id, headline, "http://x/"+id)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO embeddings (object_type, object_id, embedding, model)
			VALUES ('news_article', $1, $2::vector, 'test')`, id, vec)
		require.NoError(t, err)
	}
	anchorID := "11111111-1111-1111-1111-111111111111"
	nearID := "22222222-2222-2222-2222-222222222222"
	farID := "33333333-3333-3333-3333-333333333333"
	seed(anchorID, "anchor", "[1,0,0]")
	seed(nearID, "near story", "[0.9,0.1,0]")
	seed(farID, "far story", "[0,0,1]")

	store := &postgresStore{db: pool}
	got, err := store.GetRelatedNews("BHP", anchorID, 10)
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Equal(t, nearID, got[0].ID, "nearest article must come first")
	require.Equal(t, farID, got[1].ID)
}

func TestGetRelatedNews_NoNewsReturnsNil(t *testing.T) {
	pool, cleanup := startPgvector(t)
	defer cleanup()
	store := &postgresStore{db: pool}
	got, err := store.GetRelatedNews("ZZZ", "", 6)
	require.NoError(t, err)
	require.Nil(t, got)
}

// TestGetRelatedNews_AutoResolvesAnchor covers the articleID=="" path the frontend
// uses: the stock's latest article becomes the anchor and is excluded from results.
func TestGetRelatedNews_AutoResolvesAnchor(t *testing.T) {
	pool, cleanup := startPgvector(t)
	defer cleanup()
	ctx := context.Background()

	seed := func(id, vec, publishedAt string) {
		_, err := pool.Exec(ctx, `INSERT INTO news_articles (id, stock_code, source, headline, url, published_at)
			VALUES ($1, 'BHP', 'stockhead', 'h', $2, $3::timestamptz)`, id, "http://x/"+id, publishedAt)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO embeddings (object_type, object_id, embedding, model)
			VALUES ('news_article', $1, $2::vector, 'test')`, id, vec)
		require.NoError(t, err)
	}
	latestID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" // newest → becomes the anchor
	olderID := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	seed(latestID, "[1,0,0]", "2026-06-18T00:00:00Z")
	seed(olderID, "[0.8,0.2,0]", "2026-06-10T00:00:00Z")

	store := &postgresStore{db: pool}
	got, err := store.GetRelatedNews("BHP", "", 6) // empty articleID → auto-resolve latest as anchor
	require.NoError(t, err)
	require.Len(t, got, 1, "anchor auto-resolved to the latest article and excluded from results")
	require.Equal(t, olderID, got[0].ID)
}

// TestGetRelatedNews_UsesHNSWIndex is a SCALE-REGRESSION guard. It EXPLAINs the exact
// production ANN query against a non-trivial dataset and asserts the planner uses the
// pgvector HNSW index. The original implementation took the anchor vector from a CROSS
// JOIN, which silently defeated the index and did a full-scan KNN that only timed out
// at scale — the small-row tests above could not catch it.
func TestGetRelatedNews_UsesHNSWIndex(t *testing.T) {
	pool, cleanup := startPgvector(t)
	defer cleanup()
	ctx := context.Background()

	// Seed a non-trivial dataset so a seq-scan plan is clearly distinguishable.
	const n = 300
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("00000000-0000-0000-0000-%012d", i)
		vec := fmt.Sprintf("[%f,%f,%f]", float64(i%7)/7, float64(i%5)/5, float64(i%3)/3)
		_, err := pool.Exec(ctx, `INSERT INTO news_articles (id, stock_code, source, headline, url, published_at)
			VALUES ($1, 'BHP', 'stockhead', 'h', $2, now())`, id, "http://x/"+id)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `INSERT INTO embeddings (object_type, object_id, embedding, model)
			VALUES ('news_article', $1, $2::vector, 'test')`, id, vec)
		require.NoError(t, err)
	}

	// Pick any embedded article as the anchor and grab its embedding literal.
	var anchorID, emb string
	require.NoError(t, pool.QueryRow(ctx, `SELECT object_id, embedding::text FROM embeddings LIMIT 1`).Scan(&anchorID, &emb))

	// EXPLAIN the EXACT production query. Disable seq scans on this connection so the
	// planner must reveal whether the query is index-USABLE: the literal-vector form
	// can use idx_embeddings_hnsw; the old CROSS JOIN form cannot and would seq-scan.
	conn, err := pool.Acquire(ctx)
	require.NoError(t, err)
	defer conn.Release()
	// With seq scans AND sorts disabled, the literal-vector ORDER BY can only be
	// satisfied by the HNSW index; the old CROSS JOIN form (non-constant vector) cannot
	// use it and falls back to a (penalised) seq scan + sort — exposing the regression.
	_, err = conn.Exec(ctx, "SET enable_seqscan = off")
	require.NoError(t, err)
	_, err = conn.Exec(ctx, "SET enable_sort = off")
	require.NoError(t, err)

	rows, err := conn.Query(ctx, "EXPLAIN "+relatedNewsANNQuery, emb, anchorID, int32(6))
	require.NoError(t, err)
	var plan strings.Builder
	for rows.Next() {
		var line string
		require.NoError(t, rows.Scan(&line))
		plan.WriteString(line)
		plan.WriteByte('\n')
	}
	require.NoError(t, rows.Err())

	require.Contains(t, plan.String(), "idx_embeddings_hnsw",
		"GetRelatedNews ANN query must use the HNSW index (guards against a regression to the "+
			"CROSS JOIN / exact-KNN form that times out at scale). EXPLAIN plan:\n"+plan.String())
}
