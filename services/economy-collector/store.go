package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func connect(ctx context.Context, dbURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	// SimpleProtocol keeps the Supabase transaction pooler (port 6543) happy.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	cfg.MaxConns = 4
	return pgxpool.NewWithConfig(ctx, cfg)
}

// upsertObservations writes catalog rows then observations for a batch of
// observations, all inside one transaction so a failing source never leaves
// half-written data (per-source atomicity).
func upsertObservations(ctx context.Context, pool *pgxpool.Pool, obs []Obs) (int, error) {
	if len(obs) == 0 {
		return 0, fmt.Errorf("importer produced 0 observations — treating as format drift, not success")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Upsert distinct series defs, collecting series_key -> id.
	ids := map[string]int64{}
	const sq = `
		INSERT INTO economic_series
			(series_key, topic, metric, product, region_type, region_code,
			 region_name, unit, frequency, adjustment, dimensions, source_key, licence)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$13)
		-- Identity fields (topic/metric/product/region/source_key/licence/frequency)
		-- are deliberately immutable on re-run; only display/metadata fields refresh.
		ON CONFLICT (series_key) DO UPDATE SET
			region_name = EXCLUDED.region_name, unit = EXCLUDED.unit,
			dimensions = EXCLUDED.dimensions, updated_at = now()
		RETURNING id`
	for _, o := range obs {
		key := o.Series.Key()
		if _, done := ids[key]; done {
			continue
		}
		dims, err := json.Marshal(orEmpty(o.Series.Dimensions))
		if err != nil {
			return 0, err
		}
		var id int64
		if err := tx.QueryRow(ctx, sq,
			key, o.Series.Topic, o.Series.Metric, o.Series.Product,
			o.Series.RegionType, o.Series.RegionCode, o.Series.RegionName,
			o.Series.Unit, o.Series.Frequency, adjustmentOrDefault(o.Series.Adjustment),
			string(dims), o.Series.SourceKey, o.Series.Licence,
		).Scan(&id); err != nil {
			return 0, fmt.Errorf("upsert series %s: %w", key, err)
		}
		ids[key] = id
	}

	// 2. Batch-upsert observations (latest vintage wins).
	const oq = `
		INSERT INTO economic_observations (series_id, period, value)
		VALUES ($1, $2, $3)
		ON CONFLICT (series_id, period) DO UPDATE SET value = EXCLUDED.value`
	batch := &pgx.Batch{}
	for _, o := range obs {
		batch.Queue(oq, ids[o.Series.Key()], o.Period, o.Value)
	}
	br := tx.SendBatch(ctx, batch)
	n := 0
	for range obs {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			// tx rolls back on return (deferred), so nothing persisted —
			// report 0 rather than a partial count that implies otherwise.
			return 0, err
		}
		n++
	}
	if err := br.Close(); err != nil {
		return 0, err
	}
	return n, tx.Commit(ctx)
}

func adjustmentOrDefault(a string) string {
	if a == "" {
		return "original"
	}
	return a
}

func orEmpty(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}
