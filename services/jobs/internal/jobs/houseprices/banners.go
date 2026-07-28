package houseprices

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Per-suburb banner archetype (bushland | leafy-suburban | coastal-beach |
// inner-terraces | urban-skyline | ...), classified offline and shipped as a
// flat { salCode: archetype } map (web/public/geo/insights/suburb-archetypes.json,
// committed). This just loads it and upserts the banner_* columns onto
// suburb_demographics (migration 000081). banner_bg_key defaults to the
// archetype — the theme-swapped AVIF library is named
// <archetype>.<light|dark>.avif under web/public/housing-banners/bg/ — but is
// left alone via COALESCE if a later step (e.g. a hand-curated override) has
// already set it.

// BannerRow is one suburb's banner archetype classification (UPDATE target).
type BannerRow struct {
	SALCode   string
	Archetype string
}

// archetypesFile resolves the committed archetype map path, overridable via
// ARCHETYPES_FILE — same env-override convention as CONNECTIVITY_FILE/
// ELECTORATES_DIR/CENSUS_GEO_DIR.
func archetypesFile() string {
	if f := strings.TrimSpace(os.Getenv("ARCHETYPES_FILE")); f != "" {
		return f
	}
	return filepath.Join(filepath.Dir(censusGeoDir()), "insights", "suburb-archetypes.json")
}

// ingestBanners loads { salCode: archetype }.
func ingestBanners() ([]BannerRow, error) {
	raw := map[string]string{}
	if err := readJSONFile(archetypesFile(), &raw); err != nil {
		return nil, err
	}
	rows := make([]BannerRow, 0, len(raw))
	for sal, archetype := range raw {
		rows = append(rows, BannerRow{SALCode: sal, Archetype: archetype})
	}
	return rows, nil
}

// upsertBanners updates each matched suburb's banner_archetype, seeding
// banner_bg_key from the archetype only if it isn't already set.
func upsertBanners(ctx context.Context, pool *pgxpool.Pool, rows []BannerRow) (int, error) {
	const q = `
		UPDATE suburb_demographics SET
			banner_archetype = $2,
			banner_bg_key = COALESCE(banner_bg_key, $2),
			fetched_at = now()
		WHERE sal_code = $1`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.SALCode, r.Archetype)
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
