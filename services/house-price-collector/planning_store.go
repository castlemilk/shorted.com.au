package main

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// planningUpsertSQL writes one suburb's planning row. Idempotent: a re-run
// replaces every value, including turning a value back into NULL. A row whose
// SAL has no suburb_demographics parent is skipped (not failed) — the artifact
// is keyed by the committed boundaries and may lead the DB.
const planningUpsertSQL = `
	INSERT INTO suburb_planning
		(sal_code,
		 zone_res_low_share_pct, zone_res_medium_high_share_pct, zone_centre_mixed_share_pct,
		 zone_industrial_share_pct, zone_rural_share_pct, zone_conservation_share_pct,
		 zone_open_space_share_pct, zone_infrastructure_share_pct, zone_water_share_pct,
		 zone_other_share_pct,
		 zoning_coverage_pct, dominant_zone_family,
		 heritage_share_pct, heritage_item_count,
		 nsw_height_median_m, nsw_height_max_m, nsw_fsr_median, nsw_min_lot_median_m2,
		 planning_instruments, zoning_source, heritage_source, source_licence, computed_at)
	SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
	       $20, NULLIF($21, ''), NULLIF($22, ''), $23, now()
	WHERE EXISTS (SELECT 1 FROM suburb_demographics WHERE sal_code = $1)
	ON CONFLICT (sal_code) DO UPDATE SET
		zone_res_low_share_pct = EXCLUDED.zone_res_low_share_pct,
		zone_res_medium_high_share_pct = EXCLUDED.zone_res_medium_high_share_pct,
		zone_centre_mixed_share_pct = EXCLUDED.zone_centre_mixed_share_pct,
		zone_industrial_share_pct = EXCLUDED.zone_industrial_share_pct,
		zone_rural_share_pct = EXCLUDED.zone_rural_share_pct,
		zone_conservation_share_pct = EXCLUDED.zone_conservation_share_pct,
		zone_open_space_share_pct = EXCLUDED.zone_open_space_share_pct,
		zone_infrastructure_share_pct = EXCLUDED.zone_infrastructure_share_pct,
		zone_water_share_pct = EXCLUDED.zone_water_share_pct,
		zone_other_share_pct = EXCLUDED.zone_other_share_pct,
		zoning_coverage_pct = EXCLUDED.zoning_coverage_pct,
		dominant_zone_family = EXCLUDED.dominant_zone_family,
		heritage_share_pct = EXCLUDED.heritage_share_pct,
		heritage_item_count = EXCLUDED.heritage_item_count,
		nsw_height_median_m = EXCLUDED.nsw_height_median_m,
		nsw_height_max_m = EXCLUDED.nsw_height_max_m,
		nsw_fsr_median = EXCLUDED.nsw_fsr_median,
		nsw_min_lot_median_m2 = EXCLUDED.nsw_min_lot_median_m2,
		planning_instruments = EXCLUDED.planning_instruments,
		zoning_source = EXCLUDED.zoning_source,
		heritage_source = EXCLUDED.heritage_source,
		source_licence = EXCLUDED.source_licence,
		computed_at = EXCLUDED.computed_at`

// planningUpsertArgs is the positional argument list for planningUpsertSQL, in
// column order. Split out so the mapping is unit-testable without a database.
func planningUpsertArgs(row PlanningRow) []any {
	args := []any{row.SALCode}
	for _, family := range zoneFamilies {
		args = append(args, row.FamilyShare(family))
	}
	var instruments []string
	if len(row.PlanningInstruments) > 0 {
		instruments = row.PlanningInstruments
	}
	return append(args,
		row.ZoningCoveragePct, row.DominantZoneFamily,
		row.HeritageSharePct, row.HeritageItemCount,
		row.NSWHeightMedianM, row.NSWHeightMaxM, row.NSWFSRMedian, row.NSWMinLotMedianM2,
		instruments, row.ZoningSource, row.HeritageSource, row.Licence,
	)
}

// upsertPlanning writes the offline planning artifact (one row per SAL).
func upsertPlanning(ctx context.Context, pool *pgxpool.Pool, rows []PlanningRow) (int, error) {
	batch := &pgx.Batch{}
	for _, row := range rows {
		batch.Queue(planningUpsertSQL, planningUpsertArgs(row)...)
	}
	results := pool.SendBatch(ctx, batch)
	defer func() { _ = results.Close() }()
	updated := 0
	for range rows {
		tag, err := results.Exec()
		if err != nil {
			return updated, err
		}
		updated += int(tag.RowsAffected())
	}
	return updated, nil
}
