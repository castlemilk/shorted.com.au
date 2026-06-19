CREATE TABLE IF NOT EXISTS entity_edges (
    id            BIGSERIAL PRIMARY KEY,
    src_id        BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    dst_id        BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    edge_type     TEXT NOT NULL,
    weight        DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    attrs         JSONB NOT NULL DEFAULT '{}',
    source        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (src_id, dst_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_entity_edges_src ON entity_edges(src_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_entity_edges_dst ON entity_edges(dst_id, edge_type);
