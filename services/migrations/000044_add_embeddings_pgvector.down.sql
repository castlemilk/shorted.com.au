DROP INDEX IF EXISTS idx_embeddings_object;
DROP INDEX IF EXISTS idx_embeddings_hnsw;
DROP TABLE IF EXISTS embeddings;
-- Intentionally do NOT drop the vector extension on down (may be used elsewhere).
