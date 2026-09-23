package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store writes for the council (LGA) layer. Every scalar lives on `lga`, every
// fact with a time axis in `lga_series` (000126).

// LGASeriesRow is one council fact on a time axis. Period is the END of the
// reference period (30 June for a financial year, month-end for a month);
// PeriodLabel is the source's own label ('2025-26', '2026-06', '2025').
type LGASeriesRow struct {
	LGACode     string
	Measure     string
	Period      time.Time
	PeriodLabel string
	Value       float64
	Unit        string // persons | AUD | count
	Source      string
	Licence     string
}

// lgaIndex is the council dimension as the database holds it, keyed by
// lga_code24, for matching source rows before writing (lga_series has an FK).
type lgaIndex struct {
	kind  map[string]string // code → kind
	state map[string]string // code → state_code
	name  map[string]string // code → lga_name
}

func (ix lgaIndex) has(code string) bool { _, ok := ix.kind[code]; return ok }

// geographic reports whether a code is a real council (page-bearing kind). A
// pseudo-area ('No usual address') gets no series: its values are artefacts
// of the ABS accounting, not a place.
func (ix lgaIndex) geographic(code string) bool { return lgaHasPage(ix.kind[code]) }

func loadLGAIndex(ctx context.Context, pool *pgxpool.Pool) (lgaIndex, error) {
	ix := lgaIndex{kind: map[string]string{}, state: map[string]string{}, name: map[string]string{}}
	rows, err := pool.Query(ctx, `SELECT lga_code24, COALESCE(kind, ''), state_code, lga_name FROM lga`)
	if err != nil {
		return ix, err
	}
	defer rows.Close()
	for rows.Next() {
		var code, kind, state, name string
		if err := rows.Scan(&code, &kind, &state, &name); err != nil {
			return ix, err
		}
		if kind == "" {
			kind = lgaKind(code, name) // a dimension loaded before 000126's kind column
		}
		ix.kind[code], ix.state[code], ix.name[code] = kind, state, name
	}
	if err := rows.Err(); err != nil {
		return ix, err
	}
	if len(ix.kind) == 0 {
		return ix, fmt.Errorf("lga dimension is empty — run -mode lga first")
	}
	return ix, nil
}

// byName indexes the page-bearing councils by (state, normCouncil(name)), the
// key every name-matched council source (FAG, LGPRF) joins on. Pseudo-areas
// are left out: no grant or financial return is ever paid to 'No usual address'.
func (ix lgaIndex) byName() map[fagCouncilKey]string {
	out := make(map[fagCouncilKey]string, len(ix.kind))
	for code := range ix.kind {
		if ix.geographic(code) {
			out[fagCouncilKey{ix.state[code], normCouncil(ix.name[code])}] = code
		}
	}
	return out
}

// upsertLGADimension writes the council dimension rows. Slugs are not written
// here: see assignLGASlugs, which never touches a slug already minted.
func upsertLGADimension(ctx context.Context, pool *pgxpool.Pool, rows []LGARow) (int, error) {
	const q = `
		INSERT INTO lga (lga_code24, lga_name, display_name, state_code, kind, area_sqkm,
		                 dwellings, centroid_lat, centroid_lon)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (lga_code24) DO UPDATE SET
			lga_name = EXCLUDED.lga_name, display_name = EXCLUDED.display_name,
			state_code = EXCLUDED.state_code, kind = EXCLUDED.kind,
			area_sqkm = EXCLUDED.area_sqkm, dwellings = EXCLUDED.dwellings,
			centroid_lat = EXCLUDED.centroid_lat, centroid_lon = EXCLUDED.centroid_lon,
			fetched_at = now()`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.Code, r.Name, r.DisplayName, r.StateCode, r.Kind, r.AreaSqkm,
			r.Dwellings, r.CentroidLat, r.CentroidLon)
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// assignLGASlugs mints a slug for every page-bearing council that has none,
// against the slugs already held in the database, and returns how many it
// minted. The UPDATE is guarded by `slug IS NULL` and the partial unique index
// idx_lga_state_slug, so a concurrent run can neither reassign nor duplicate.
func assignLGASlugs(ctx context.Context, pool *pgxpool.Pool, rows []LGARow) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	taken := map[string]map[string]string{}
	have := map[string]bool{}
	q, err := tx.Query(ctx, `SELECT lga_code24, state_code, slug FROM lga WHERE slug IS NOT NULL`)
	if err != nil {
		return 0, err
	}
	for q.Next() {
		var code, state, slug string
		if err := q.Scan(&code, &state, &slug); err != nil {
			q.Close()
			return 0, err
		}
		if taken[state] == nil {
			taken[state] = map[string]string{}
		}
		taken[state][slug] = code
		have[code] = true
	}
	q.Close()
	if err := q.Err(); err != nil {
		return 0, err
	}

	pending := make([]LGARow, 0, len(rows))
	for _, r := range rows {
		if !have[r.Code] {
			pending = append(pending, r)
		}
	}
	minted := mintLGASlugs(taken, pending)
	n := 0
	for code, slug := range minted {
		tag, err := tx.Exec(ctx, `UPDATE lga SET slug = $2 WHERE lga_code24 = $1 AND slug IS NULL`, code, slug)
		if err != nil {
			return n, fmt.Errorf("mint slug %s=%q: %w", code, slug, err)
		}
		n += int(tag.RowsAffected())
	}
	return n, tx.Commit(ctx)
}

// replaceSuburbLGA makes suburb_lga exactly the artifact: every row upserted
// with its dominant share and overlaps, and any suburb the artifact no longer
// bridges (a pseudo SAL, a redrawn boundary) deleted — in one transaction, so
// a reader never sees a half-replaced bridge.
func replaceSuburbLGA(ctx context.Context, pool *pgxpool.Pool, rows []SuburbLGARow) (int, int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const q = `
		INSERT INTO suburb_lga (sal_code, lga_code24, dominant_share, overlap_lgas)
		VALUES ($1, $2, $3, $4::jsonb)
		ON CONFLICT (sal_code) DO UPDATE SET
			lga_code24 = EXCLUDED.lga_code24, dominant_share = EXCLUDED.dominant_share,
			overlap_lgas = EXCLUDED.overlap_lgas`
	sals := make([]string, 0, len(rows))
	n := 0
	for start := 0; start < len(rows); start += 2000 {
		end := min(start+2000, len(rows))
		batch := &pgx.Batch{}
		for _, r := range rows[start:end] {
			overlaps, err := json.Marshal(r.Overlaps)
			if err != nil {
				return n, 0, err
			}
			batch.Queue(q, r.SALCode, r.LGACode, r.DominantShare, string(overlaps))
			sals = append(sals, r.SALCode)
		}
		br := tx.SendBatch(ctx, batch)
		for range rows[start:end] {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return n, 0, err
			}
			n++
		}
		if err := br.Close(); err != nil {
			return n, 0, err
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM suburb_lga WHERE NOT (sal_code = ANY($1))`, sals)
	if err != nil {
		return n, 0, err
	}
	return n, tag.RowsAffected(), tx.Commit(ctx)
}

// upsertLGASeries idempotently writes council series rows, chunked so no one
// pipelined batch stalls the transaction pooler (see upsertCrime).
func upsertLGASeries(ctx context.Context, pool *pgxpool.Pool, rows []LGASeriesRow) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	n, err := upsertLGASeriesTx(ctx, tx, rows)
	if err != nil {
		return n, err
	}
	return n, tx.Commit(ctx)
}

func upsertLGASeriesTx(ctx context.Context, tx pgx.Tx, rows []LGASeriesRow) (int, error) {
	const q = `
		INSERT INTO lga_series (lga_code24, measure, period, period_label, value, unit, source, source_licence)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (lga_code24, measure, period, source) DO UPDATE SET
			period_label = EXCLUDED.period_label, value = EXCLUDED.value, unit = EXCLUDED.unit,
			source_licence = EXCLUDED.source_licence, fetched_at = now()`
	n := 0
	for start := 0; start < len(rows); start += 2000 {
		end := min(start+2000, len(rows))
		batch := &pgx.Batch{}
		for _, r := range rows[start:end] {
			batch.Queue(q, r.LGACode, r.Measure, r.Period, r.PeriodLabel, r.Value, r.Unit, r.Source, r.Licence)
		}
		br := tx.SendBatch(ctx, batch)
		for range rows[start:end] {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return n, err
			}
			n++
		}
		if err := br.Close(); err != nil {
			return n, err
		}
	}
	return n, nil
}

// recordLGARun is the shared tail of every council mode: log a failure and
// record the run cursor either way. lastPeriod is the newest period written.
func recordLGARun(ctx context.Context, pool *pgxpool.Pool, source string, lastPeriod *time.Time, n int, err error) error {
	if err != nil {
		log.Printf("[%s] error after %d rows: %v", source, n, err)
		_ = updateRun(ctx, pool, source, nil, n, "error", err.Error())
		return err
	}
	if uerr := updateRun(ctx, pool, source, lastPeriod, n, "ok", ""); uerr != nil {
		log.Printf("[%s] persist run cursor: %v", source, uerr)
	}
	return nil
}

func latestSeriesPeriod(rows []LGASeriesRow) *time.Time {
	var last *time.Time
	for i := range rows {
		if last == nil || rows[i].Period.After(*last) {
			p := rows[i].Period
			last = &p
		}
	}
	return last
}
