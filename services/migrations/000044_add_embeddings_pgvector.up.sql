-- Semantic layer: pgvector + per-object embeddings (768-dim, Gemini text-embedding-004)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS embeddings (
    id          BIGSERIAL PRIMARY KEY,
    object_type TEXT NOT NULL,            -- 'news_article' | 'company_summary' | 'report_chunk'
    object_id   TEXT NOT NULL,            -- news_articles.id (UUID as text), stock_code, or content_hash:chunk
    chunk_idx   INTEGER NOT NULL DEFAULT 0,
    embedding   vector(768) NOT NULL,
    model       TEXT NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (object_type, object_id, chunk_idx)
);

-- ANN index for cosine similarity (pgvector HNSW)
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw
    ON embeddings USING hnsw (embedding vector_cosine_ops);

-- Lookup index for "find the embedding for this object"
CREATE INDEX IF NOT EXISTS idx_embeddings_object
    ON embeddings (object_type, object_id);
