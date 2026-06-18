//go:build integration
// +build integration

package shorts

import (
	"context"
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
		);`)
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
