package shorts

import (
	"sync"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// Suburb reference views (migration 000139).
//
// The suburb list, profile, similar-suburbs kNN, metric columns and council
// suburb table used to recompute, on every cache miss, values that change only
// when an official source loads: each suburb's latest public median and YoY,
// the state baselines and the similarity deviations. That was a third of all
// prod database time (2026-10-21 review, DBP-01). 000139 materializes them;
// the readers take them from there and fall back to the live SQL below only
// when a view does not exist (42P01), so a database without 000139 (dev, test,
// or prod before the hand-apply) keeps working at the old cost.
//
// Both sources expose the same columns under the same aliases (r.* for the
// price, sb.* for the baselines), so every reader has one select list.

// suburbReadSource says where a suburb reader takes its reference values from.
type suburbReadSource int

const (
	// suburbFromViews reads the 000139 materialized views.
	suburbFromViews suburbReadSource = iota
	// suburbFromLiveSQL computes the same values per request.
	suburbFromLiveSQL
)

// suburbLatestPriceViewJoin is preferredSuburbRegionJoin, precomputed: one
// row per SAL with the same region, value, period and yoy_pct.
const suburbLatestPriceViewJoin = `
		LEFT JOIN mv_suburb_latest_price r ON r.sal_code = d.sal_code`

// suburbPriceJoin returns the join that gives a reader aliasing
// suburb_demographics as d its suburb's public price as r.region_code,
// r.value, r.period and r.yoy_pct.
func suburbPriceJoin(src suburbReadSource) string {
	if src == suburbFromViews {
		return suburbLatestPriceViewJoin
	}
	return preferredSuburbRegionJoin
}

// suburbBaselinesViewJoin attaches the state baselines for d.state_code.
const suburbBaselinesViewJoin = `
		LEFT JOIN mv_housing_state_baselines sb ON sb.state_code = d.state_code`

// suburbBaselinesLiveJoin computes what mv_housing_state_baselines stores, for
// d's state, with the same column names.
//
// The state price baseline is the MEDIAN of the latest public median per priced
// suburb in the state (it covers VIC's annual series); a mean let one $110.5M
// development sale move NSW by about $45k. The income references are the
// median suburb's median, in the state and nationally. The Census shares are
// rebuilt as SUM(share x weight) / SUM(weight) over the suburbs that carry
// them (a suburb below an ingest floor is NULL and drops out of both sums),
// weighted by the denominator each is a share of: dwelling_count for tenure,
// structure and household mix, population for the person rates (the labour
// force is not stored, so unemployment is resident-weighted).
const suburbBaselinesLiveJoin = `
		LEFT JOIN LATERAL (
		  SELECT (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latest) FROM (
		            SELECT DISTINCT ON (hp.region_code) hp.value AS latest
		            FROM house_prices hp JOIN house_price_regions sr ON sr.region_code = hp.region_code
		            WHERE sr.state_code = d.state_code AND sr.region_type = 'suburb' AND hp.source_licence <> 'proprietary-tos-restricted'
		              AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
		            ORDER BY hp.region_code, hp.period DESC) s) AS state_median_price,
		         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY median_weekly_hhd_income)
		            FROM suburb_demographics WHERE median_weekly_hhd_income > 0) AS national_median_hhd_income,
		         sc.*
		  FROM (
		    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY sd.median_weekly_hhd_income)
		             FILTER (WHERE sd.median_weekly_hhd_income > 0) AS median_hhd_income,
		           SUM(sd.pct_owned_outright * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_owned_outright IS NOT NULL), 0) AS pct_owned_outright,
		           SUM(sd.pct_owned_mortgage * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_owned_mortgage IS NOT NULL), 0) AS pct_owned_mortgage,
		           SUM(sd.pct_rented * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_rented IS NOT NULL), 0) AS pct_rented,
		           SUM(sd.pct_separate_house * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_separate_house IS NOT NULL), 0) AS pct_separate_house,
		           SUM(sd.pct_flat_apartment * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_flat_apartment IS NOT NULL), 0) AS pct_flat_apartment,
		           SUM(sd.pct_couple_with_children * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_couple_with_children IS NOT NULL), 0) AS pct_couple_with_children,
		           SUM(sd.pct_lone_person_household * sd.dwelling_count) / NULLIF(SUM(sd.dwelling_count) FILTER (WHERE sd.pct_lone_person_household IS NOT NULL), 0) AS pct_lone_person_household,
		           SUM(sd.unemployment_rate * sd.population) / NULLIF(SUM(sd.population) FILTER (WHERE sd.unemployment_rate IS NOT NULL), 0) AS unemployment_rate,
		           SUM(sd.labour_force_participation_rate * sd.population) / NULLIF(SUM(sd.population) FILTER (WHERE sd.labour_force_participation_rate IS NOT NULL), 0) AS labour_force_participation_rate,
		           SUM(sd.pct_bachelor_or_higher * sd.population) / NULLIF(SUM(sd.population) FILTER (WHERE sd.pct_bachelor_or_higher IS NOT NULL), 0) AS pct_bachelor_or_higher,
		           SUM(sd.pct_low_personal_income * sd.population) / NULLIF(SUM(sd.population) FILTER (WHERE sd.pct_low_personal_income IS NOT NULL), 0) AS pct_low_personal_income,
		           SUM(sd.pct_high_personal_income * sd.population) / NULLIF(SUM(sd.population) FILTER (WHERE sd.pct_high_personal_income IS NOT NULL), 0) AS pct_high_personal_income
		    FROM suburb_demographics sd
		    WHERE sd.state_code = d.state_code
		  ) sc
		) sb ON true`

// suburbBaselinesJoin returns the join that exposes d's state baselines as sb.*.
func suburbBaselinesJoin(src suburbReadSource) string {
	if src == suburbFromViews {
		return suburbBaselinesViewJoin
	}
	return suburbBaselinesLiveJoin
}

// similarSuburbsViewQuery is similarSuburbsLiveQuery over the precomputed
// features: each stored feature is already divided by its deviation, so the
// distance is the same sum of squared differences without recomputing six
// deviations over every suburb. Ties at the LIMIT break on sal_code, which the
// live query leaves to the executor. Price stays display-only and is joined
// for the k winners only.
const similarSuburbsViewQuery = `
		WITH ranked AS (
			SELECT c.sal_code,
			       sqrt(
			         COALESCE(power(c.z_age - t.z_age, 2), 0) +
			         COALESCE(power(c.z_inc - t.z_inc, 2), 0) +
			         COALESCE(power(c.z_bo - t.z_bo, 2), 0) +
			         COALESCE(power(c.z_den - t.z_den, 2), 0) +
			         COALESCE(power(c.z_pop - t.z_pop, 2), 0) +
			         COALESCE(power(c.z_coast - t.z_coast, 2), 0)
			       ) AS dist
			FROM mv_suburb_similarity_features c
			JOIN mv_suburb_similarity_features t ON t.sal_code = $1
			WHERE c.candidate AND c.sal_code <> $1
			ORDER BY dist ASC NULLS LAST, c.sal_code
			LIMIT $2
		)
		SELECT d.sal_code, d.sal_name, d.state_code, COALESCE(r.value,0),
		       COALESCE(r.region_code,''), k.dist
		FROM ranked k
		JOIN suburb_demographics d ON d.sal_code = k.sal_code` + suburbLatestPriceViewJoin + `
		ORDER BY k.dist ASC NULLS LAST, k.sal_code`

// similarSuburbsLiveQuery finds the k nearest suburbs nationally in a z-scored
// feature space (age, income, born-overseas, amenity density, log-population,
// and distance-to-coast capped at 100km so coastal suburbs cluster together).
const similarSuburbsLiveQuery = `
		WITH stats AS (
			SELECT NULLIF(stddev_pop(d.median_age),0) sage,
			       NULLIF(stddev_pop(d.median_weekly_hhd_income),0) sinc,
			       NULLIF(stddev_pop(d.pct_born_overseas),0) sbo,
			       NULLIF(stddev_pop(COALESCE(a.amenity_density_score,0)),0) sden,
			       NULLIF(stddev_pop(ln(GREATEST(d.population,1))),0) spop,
			       NULLIF(stddev_pop(LEAST(COALESCE(a.dist_to_coast_km,0),100)),0) scoast
			FROM suburb_demographics d LEFT JOIN suburb_amenities a ON a.sal_code = d.sal_code
			WHERE d.population > 200
		),
		tgt AS (
			SELECT d.median_age ma, d.median_weekly_hhd_income mi, d.pct_born_overseas mb,
			       COALESCE(a.amenity_density_score,0) md, ln(GREATEST(d.population,1)) mp,
			       LEAST(COALESCE(a.dist_to_coast_km,0),100) mc
			FROM suburb_demographics d LEFT JOIN suburb_amenities a ON a.sal_code = d.sal_code
			WHERE d.sal_code = $1
		),
		ranked AS (
			SELECT d.sal_code, d.sal_name, d.state_code,
			       sqrt(
			         COALESCE(pow((d.median_age - tgt.ma)/stats.sage,2),0) +
			         COALESCE(pow((d.median_weekly_hhd_income - tgt.mi)/stats.sinc,2),0) +
			         COALESCE(pow((d.pct_born_overseas - tgt.mb)/stats.sbo,2),0) +
			         COALESCE(pow((COALESCE(a.amenity_density_score,0) - tgt.md)/stats.sden,2),0) +
			         COALESCE(pow((ln(GREATEST(d.population,1)) - tgt.mp)/stats.spop,2),0) +
			         COALESCE(pow((LEAST(COALESCE(a.dist_to_coast_km,0),100) - tgt.mc)/stats.scoast,2),0)
			       ) AS dist
			FROM suburb_demographics d
			LEFT JOIN suburb_amenities a ON a.sal_code = d.sal_code
			CROSS JOIN tgt CROSS JOIN stats
			WHERE d.sal_code <> $1 AND d.population > 200
			  AND d.median_age IS NOT NULL AND d.median_weekly_hhd_income IS NOT NULL
			ORDER BY dist ASC NULLS LAST
			LIMIT $2
		)
		-- Price is display-only (it never enters the distance), so defer the
		-- per-candidate latest-median LATERAL probe until AFTER the top-k are
		-- chosen: k probes instead of one per ~15k candidate suburbs. It is the
		-- SAME one-region-per-SAL preference the list and profile readers use:
		-- a bare join on house_price_regions fanned out on every SAL carrying
		-- both a crawl key and a Valuer-General key (329 in prod), so the list
		-- repeated suburbs and returned more rows than its LIMIT.
		SELECT d.sal_code, d.sal_name, d.state_code, COALESCE(r.value,0),
		       COALESCE(r.region_code,''), d.dist
		FROM ranked d` + preferredSuburbRegionJoin + `
		ORDER BY d.dist ASC NULLS LAST, d.sal_code`

// similarSuburbsQuery returns the kNN for src; $1 = target SAL, $2 = k.
func similarSuburbsQuery(src suburbReadSource) string {
	if src == suburbFromViews {
		return similarSuburbsViewQuery
	}
	return similarSuburbsLiveQuery
}

// readSuburbReference runs read against the 000139 views and, only when one
// of them does not exist (42P01), against the live SQL. Any other error is
// returned as is: falling back on a timeout would hide a sick view behind the
// slow query it replaced. The fallback is logged once per reader per process.
func readSuburbReference[T any](reader string, read func(src suburbReadSource) (T, error)) (T, error) {
	return fallbackOnUndefinedTable(
		func() (T, error) { return read(suburbFromViews) },
		func(err error) (T, error) {
			logSuburbViewsMissingOnce(reader, err)
			return read(suburbFromLiveSQL)
		},
	)
}

// suburbViewsMissingLog holds one sync.Once per reader.
var suburbViewsMissingLog sync.Map

func logSuburbViewsMissingOnce(reader string, err error) {
	once, _ := suburbViewsMissingLog.LoadOrStore(reader, &sync.Once{})
	once.(*sync.Once).Do(func() {
		log.Warnf("%s: suburb reference views missing (migration 000139 not applied?); computing them per request: %v", reader, err)
	})
}
