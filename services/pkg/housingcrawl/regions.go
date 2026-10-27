package housingcrawl

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// UpsertRegions writes the distinct regions referenced by regions (the fact table's
// FK target), deriving each region's metadata from the first region seen.
func UpsertRegions(ctx context.Context, pool *pgxpool.Pool, regions []Region) error {
	seen := map[string]Region{}
	for _, o := range regions {
		if _, ok := seen[o.RegionCode]; !ok {
			seen[o.RegionCode] = o
		}
	}
	batch := &pgx.Batch{}
	for _, o := range seen {
		batch.Queue(`
			INSERT INTO house_price_regions (region_code, region_type, region_name, state_code, postcode)
			VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''))
			ON CONFLICT (region_code) DO UPDATE SET
				region_type = EXCLUDED.region_type,
				region_name = EXCLUDED.region_name,
				state_code  = COALESCE(EXCLUDED.state_code, house_price_regions.state_code),
				postcode    = COALESCE(EXCLUDED.postcode, house_price_regions.postcode)`,
			o.RegionCode, o.RegionType, o.RegionName, o.StateCode, o.Postcode)
	}
	br := pool.SendBatch(ctx, batch)
	for range seen {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return err
		}
	}
	return br.Close()
}

func RefreshHousingMV(ctx context.Context, pool *pgxpool.Pool) error {
	// The function-scoped GUC cannot disarm a timeout already armed for the
	// calling command, so the override must precede the function call. Simple
	// protocol wraps this multi-statement command in an implicit transaction;
	// SET LOCAL scopes the override to that transaction and expires with it.
	_, err := pool.Exec(ctx, `SET LOCAL statement_timeout = 0;
		SELECT refresh_housing_materialized_views()`)
	return err
}

// LinkSuburbSalCodes backfills house_price_regions.sal_code for suburb regions by
// matching the region NAME to an ABS SAL name — the same logic as migrations 000056
// (exact) + 000068 (parenthetical-stripped fallback for ABS names like
// "Abbotsford (NSW)"). Run every ingest so newly-added suburbs (any state)
// self-link without a manual SQL step. Idempotent: only touches NULL sal_codes.
//
// The stripped pass is where one name meets several SALs: ABS parenthesises a
// name precisely because it repeats ("Mayfield (Newcastle - NSW)", 9,760
// people; "Mayfield (Shoalhaven - NSW)", 36). An UPDATE … FROM with several
// matching rows applies an arbitrary one, and prod linked the VG "Mayfield"
// series to the 36-person locality — the populous suburb then read as
// unpriced and the locality showed Newcastle's median. The pass now takes the
// most populous candidate (sal_code breaks a tie, so a re-run is stable):
// suburb_demographics carries no postcode to match on, and a suburb-level
// median exists because the place has sales, which the populous one does.
func LinkSuburbSalCodes(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	var total int64
	tag, err := pool.Exec(ctx, `
		UPDATE house_price_regions r SET sal_code = d.sal_code
		FROM suburb_demographics d
		WHERE r.sal_code IS NULL AND r.region_type = 'suburb' AND r.state_code = d.state_code
		  AND upper(trim(r.region_name)) = upper(trim(d.sal_name))`)
	if err != nil {
		return total, fmt.Errorf("sal link (exact): %w", err)
	}
	total += tag.RowsAffected()
	tag, err = pool.Exec(ctx, linkStrippedSalSQL)
	if err != nil {
		return total, fmt.Errorf("sal link (stripped): %w", err)
	}
	total += tag.RowsAffected()
	return total, nil
}

// linkStrippedSalSQL links each still-unlinked suburb region to the MOST
// POPULOUS SAL whose name, qualifier stripped, matches it in the same state.
const linkStrippedSalSQL = `
		UPDATE house_price_regions r SET sal_code = pick.sal_code
		FROM (
			SELECT DISTINCT ON (u.region_code) u.region_code, d.sal_code
			FROM house_price_regions u
			JOIN suburb_demographics d
			  ON d.state_code = u.state_code
			 AND upper(trim(u.region_name)) = upper(trim(regexp_replace(d.sal_name, '\s*\(.*\)\s*$', '')))
			WHERE u.sal_code IS NULL AND u.region_type = 'suburb'
			ORDER BY u.region_code, COALESCE(d.population, 0) DESC, d.sal_code
		) pick
		WHERE r.region_code = pick.region_code AND r.sal_code IS NULL`
