package shorts

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/jackc/pgx/v5"
)

// Council hub reads: ListCouncils (the state index + council choropleth) and
// GetCouncilProfile (one council, everything held for it).
//
// Three rules shape every query here:
//   - Council facts are COUNCIL-level. The ABS council house median is the whole
//     council's; a suburb's own Valuer-General median is shown only on that
//     suburb. Nothing is ever smeared across the other.
//   - NULL is "no source covers this", never 0. Every optional number is a
//     pointer, and a rollup over zero covered suburbs is absent.
//   - Only the base identity query can fail the request. Hazards, crime, price
//     drops and neighbours are tolerated blocks (log.Warnf, empty section), the
//     way GetSuburbProfile treats its optional blocks: each reads a table that
//     lands by hand on prod or an MV an environment may never have built.

// councilMemberMinShare is the smallest share of a suburb's residents that
// makes a straddling suburb a member of a council it is not dominant in. The
// same 5% floor the suburb profile uses to name a second council.
const councilMemberMinShare = councilOverlapMinShare

// councilHazardMinCoverage is the share of a council's member residents the
// covered suburbs must hold before the index / choropleth print a council-wide
// hazard share (see councilHazardRollupQuery).
const councilHazardMinCoverage = 0.5

// councilDropsMinCount is the k-anonymity floor for crawl-derived drops: a
// council (and a named suburb) needs at least this many distinct cut listings.
const councilDropsMinCount = 3

// CouncilLgaVintage names the boundary edition every council fact is keyed to.
const CouncilLgaVintage = "ABS ASGS Edition 3, LGA 2024 boundaries"

// ErrCouncilNotFound is returned when no council with a page matches.
var ErrCouncilNotFound = errors.New("council not found")

// CouncilSummaryRow is one council's headline row. The council index table,
// the council choropleth and the profile's summary all read exactly this.
type CouncilSummaryRow struct {
	LgaCode           string
	Slug              string
	DisplayName       string
	Kind              string
	StateCode         string
	Population        int32 // ABS ERP at 30 June ErpYear; 0 if none
	ErpYear           int32
	PopGrowthPct      *float64
	AreaSqkm          *float64
	DensityPerSqkm    *float64
	MemberSuburbCount int32 // suburbs whose DOMINANT council this is
	HouseMedian       *float64
	HouseMedianPeriod string
	FagPerResident    *float64
	FagYear           string
	ApprovalsPer1000  *float64
	ApprovalsThrough  string // 'YYYY-MM'
	SeifaIrsadDecile  *int32
	FloodSharePct     *float64
	BushfireSharePct  *float64
	PriceDropShare    *float64
	DataThrough       *time.Time // newest period in any of the council's series, never in the future
	// Freshness of PriceDropShare (program decision 9): when it was computed
	// and the newest crawl observation behind it. Nil without a share.
	PriceDropsAsOf        *time.Time
	PriceDropsDataThrough *time.Time
}

// councilSummaryQuery is the base row for every council with a page in a state
// ($2 empty for all, or one lga_code24). Reads only lga + suburb_lga +
// lga_series, which all ship in 000126 — the tolerated blocks add the rest.
//
// The approvals rate needs a full 12 months ending at the council's latest
// month; a shorter window is not "the last 12 months" and stays absent.
const councilSummaryQuery = `
		WITH c AS (
			SELECT l.lga_code24, l.slug, COALESCE(NULLIF(l.display_name, ''), l.lga_name) AS name,
			       l.kind, l.state_code, COALESCE(l.population, 0) AS population,
			       COALESCE(l.erp_year, 0) AS erp_year, l.pop_growth_pct::float8 AS growth,
			       l.area_sqkm::float8 AS area, l.seifa_irsad_decile::int AS irsad,
			       l.fed_fag_aud::float8 AS fag, COALESCE(l.fed_fag_year, '') AS fag_year
			FROM lga l
			WHERE l.state_code = $1 AND l.kind IN ('council', 'unincorporated') AND l.slug IS NOT NULL
			  AND ($2 = '' OR l.lga_code24 = $2)
		)
		SELECT c.lga_code24, c.slug, c.name, c.kind, c.state_code, c.population, c.erp_year,
		       c.growth, c.area, c.irsad, c.fag, c.fag_year,
		       (SELECT count(*) FROM suburb_lga sl WHERE sl.lga_code24 = c.lga_code24) AS members,
		       hm.value, COALESCE(hm.period_label, ''),
		       ap.total, COALESCE(ap.months, 0), COALESCE(to_char(ap.through, 'YYYY-MM'), ''),
		       (SELECT max(x.period) FROM lga_series x
		        WHERE x.lga_code24 = c.lga_code24 AND x.source_licence <> 'proprietary-tos-restricted'
		          AND x.period <= current_date)
		FROM c
		LEFT JOIN LATERAL (
			SELECT s.value, s.period_label
			FROM lga_series s
			WHERE s.lga_code24 = c.lga_code24 AND s.measure = 'house_median_price'
			  AND s.source_licence <> 'proprietary-tos-restricted'
			ORDER BY s.period DESC
			LIMIT 1
		) hm ON true
		LEFT JOIN LATERAL (
			SELECT sum(s.value) AS total, count(*) AS months, max(s.period) AS through
			FROM lga_series s
			WHERE s.lga_code24 = c.lga_code24 AND s.measure = 'dwelling_approvals_total'
			  AND s.source_licence <> 'proprietary-tos-restricted'
			  AND s.period > (
			    SELECT max(x.period) FROM lga_series x
			    WHERE x.lga_code24 = c.lga_code24 AND x.measure = 'dwelling_approvals_total'
			      AND x.source_licence <> 'proprietary-tos-restricted'
			  ) - INTERVAL '12 months'
		) ap ON true
		ORDER BY c.population DESC, c.name, c.lga_code24`

// councilMembersCTE expands the mesh-block bridge into (council, suburb) pairs:
// a suburb belongs to its dominant council, and to any other council holding
// at least $3 of its residents. w = the residents it contributes (Census 2021
// persons x share), the weight every rollup uses. A bridge row written before
// overlaps existed (overlap_lgas = []) still counts for its dominant council.
const councilMembersCTE = `
		m AS (
			SELECT o.lga_code24, sl.sal_code, o.share, (sl.lga_code24 = o.lga_code24) AS dominant,
			       COALESCE(d.population, 0)::float8 * o.share AS w
			FROM suburb_lga sl
			JOIN suburb_demographics d ON d.sal_code = sl.sal_code
			CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(NULLIF(sl.overlap_lgas, '[]'::jsonb),
			    jsonb_build_array(jsonb_build_object('lga_code24', sl.lga_code24, 'share', COALESCE(sl.dominant_share, 1)))))
			    AS o(lga_code24 text, share double precision)
			WHERE d.state_code = $1 AND ($2 = '' OR o.lga_code24 = $2)
			  AND (o.lga_code24 = sl.lga_code24 OR o.share >= $3)
		)`

// councilHazardRollupQuery: population-weighted flood/bushfire planning shares
// over member suburbs the source covers. A council none of whose suburbs is
// covered gets NULL (the FILTERed denominator is NULL), never 0%.
//
// The index and the choropleth show this one number with no coverage beside
// it, so it is also absent unless the covered suburbs hold at least $4 of the
// council's member residents: "0%" resting on 5 mapped suburbs of 24 would read
// as a measurement of the whole council. The hub's own rollup states its
// covered-suburb count beside the figure and is not floored.
const councilHazardRollupQuery = `
		WITH` + councilMembersCTE + `
		SELECT m.lga_code24,
		       CASE WHEN sum(m.w) FILTER (WHERE h.flood_planning_share_pct IS NOT NULL) >= $4 * sum(m.w)
		            THEN sum(m.w * h.flood_planning_share_pct) FILTER (WHERE h.flood_planning_share_pct IS NOT NULL)
		                 / NULLIF(sum(m.w) FILTER (WHERE h.flood_planning_share_pct IS NOT NULL), 0) END,
		       CASE WHEN sum(m.w) FILTER (WHERE h.bushfire_prone_share_pct IS NOT NULL) >= $4 * sum(m.w)
		            THEN sum(m.w * h.bushfire_prone_share_pct) FILTER (WHERE h.bushfire_prone_share_pct IS NOT NULL)
		                 / NULLIF(sum(m.w) FILTER (WHERE h.bushfire_prone_share_pct IS NOT NULL), 0) END
		FROM m
		LEFT JOIN suburb_hazard_exposure h ON h.sal_code = m.sal_code AND h.source_licence <> 'proprietary-tos-restricted'
		GROUP BY m.lga_code24`

// councilDropsQuery: asking-price cuts for every crawled suburb whose
// DOMINANT council this is — a listing sits at one address, so it is never
// split by share — plus one council-total row per council (sal_code NULL, from
// the GROUPING SETS).
//
// It counts from the crawl tables, NOT from mv_suburb_price_drops: that view
// drops every suburb with fewer than 3 cuts, so summing it loses exactly the
// cuts a council-level floor exists to pool (measured on prod 2026-09-24: 65
// cuts over 42 sub-floor suburbs in 24 councils) while their listings still
// entered the denominator. Here numerator and denominator are one population
// and the k>=3 floor applies to the council total. Only aggregates leave the
// database; no listing row, address or price is selected.
//
// Every filter mirrors the drops views so the council and the suburb board
// count the same thing: address-deduped (one winner per address, the source
// with the largest total cut, as the view picks it), 30-day events, the 40%
// sanity cap, and "active" = is_active AND seen in the last 14 days (program
// decision 9 — the drill-downs and 000124's views use the same window).
// $3 is the floor: a per-suburb median over fewer cuts is withheld.
const councilDropsQuery = `
		WITH sub AS (
			SELECT sl.lga_code24, sl.sal_code, r.region_code
			FROM suburb_lga sl
			JOIN lga l ON l.lga_code24 = sl.lga_code24
			JOIN house_price_regions r ON r.sal_code = sl.sal_code
			WHERE l.state_code = $1 AND ($2 = '' OR sl.lga_code24 = $2)
		), live AS (
			SELECT sub.lga_code24, sub.sal_code, pl.id, pl.address_key, pl.last_seen_at
			FROM sub
			JOIN property_listings pl ON pl.region_code = sub.region_code
			WHERE pl.is_active
			  AND pl.last_seen_at >= now() - interval '14 days'
			  AND NULLIF(pl.address_key, '') IS NOT NULL
		), per_source AS (
			SELECT lv.lga_code24, lv.sal_code, lv.address_key, e.source,
			       max(e.drop_pct) AS max_pct, sum(e.drop_abs) AS total_abs, max(e.observed_at) AS cut_at
			FROM live lv
			JOIN property_price_events e ON e.listing_pk = lv.id
			WHERE e.event_type = 'price_drop'
			  AND e.observed_at >= now() - interval '30 days'
			  AND e.drop_pct IS NOT NULL
			  AND e.drop_pct <= 0.40
			GROUP BY lv.lga_code24, lv.sal_code, lv.address_key, e.source
		), cut AS (
			SELECT DISTINCT ON (sal_code, address_key) lga_code24, sal_code, address_key, max_pct, cut_at
			FROM per_source
			ORDER BY sal_code, address_key, total_abs DESC, source
		), tracked AS (
			SELECT lga_code24, sal_code, count(DISTINCT address_key) AS n, max(last_seen_at) AS seen_at
			FROM live
			GROUP BY GROUPING SETS ((lga_code24, sal_code), (lga_code24))
		), dropped AS (
			SELECT lga_code24, sal_code, count(DISTINCT address_key) AS n,
			       percentile_cont(0.5) WITHIN GROUP (ORDER BY max_pct) AS median_pct,
			       max(cut_at) AS cut_at
			FROM cut
			GROUP BY GROUPING SETS ((lga_code24, sal_code), (lga_code24))
		)
		SELECT t.lga_code24, COALESCE(t.sal_code, ''), COALESCE(d.sal_name, ''), COALESCE(d.postcode, ''),
		       COALESCE(x.n, 0)::bigint, t.n::bigint,
		       CASE WHEN x.n >= $3 THEN x.median_pct END,
		       GREATEST(t.seen_at, x.cut_at), now()
		FROM tracked t
		LEFT JOIN dropped x ON x.lga_code24 = t.lga_code24 AND x.sal_code IS NOT DISTINCT FROM t.sal_code
		LEFT JOIN suburb_demographics d ON d.sal_code = t.sal_code
		ORDER BY t.lga_code24, t.sal_code NULLS FIRST`

// councilDropsMVQuery reads the same rows from mv_council_price_drops
// (migration 000127): councilDropsQuery computed once per housing refresh
// instead of on every cold council read, which on prod walked 18,640 buffers
// of property_listings and made the first NSW ListCouncils after a deploy take
// 11s. The view's definition is councilDropsQuery with the state/council
// filters lifted into columns (TestCouncilDropsMVMatchesLiveQuery pins that),
// so the rows are identical to the live query run at refresh time; as_of is
// that refresh (housing_mv_refresh.refreshed_at), the instant every window in
// the view was evaluated. No bookkeeping row means no as_of, so nothing is
// published rather than an undated share.
const councilDropsMVQuery = `
		SELECT m.lga_code24, m.sal_code, m.sal_name, m.postcode, m.dropped, m.tracked,
		       m.median_drop_pct, m.data_through, f.refreshed_at
		FROM mv_council_price_drops m
		JOIN housing_mv_refresh f ON f.mv_name = 'mv_council_price_drops'
		WHERE m.state_code = $1 AND ($2 = '' OR m.lga_code24 = $2)
		ORDER BY m.lga_code24, m.sal_code`

// ListCouncils returns every council with a page in one state.
func (s *postgresStore) ListCouncils(stateCode string) ([]*CouncilSummaryRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.councilSummaries(ctx, stateCode, "")
}

func (s *postgresStore) councilSummaries(ctx context.Context, stateCode, lgaCode string) ([]*CouncilSummaryRow, error) {
	rows, err := s.db.Query(ctx, councilSummaryQuery, stateCode, lgaCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*CouncilSummaryRow
	byCode := map[string]*CouncilSummaryRow{}
	for rows.Next() {
		var (
			r                         CouncilSummaryRow
			growth, area, fag, median sql.NullFloat64
			approvals                 sql.NullFloat64
			irsad                     sql.NullInt32
			members                   int64
			approvalMonths            int64
			through                   sql.NullTime
		)
		if err := rows.Scan(&r.LgaCode, &r.Slug, &r.DisplayName, &r.Kind, &r.StateCode, &r.Population, &r.ErpYear,
			&growth, &area, &irsad, &fag, &r.FagYear, &members, &median, &r.HouseMedianPeriod,
			&approvals, &approvalMonths, &r.ApprovalsThrough, &through); err != nil {
			return nil, err
		}
		r.MemberSuburbCount = int32(members)
		if through.Valid {
			t := through.Time
			r.DataThrough = &t
		}
		r.PopGrowthPct, r.SeifaIrsadDecile = nullableFloatPointer(growth), nullableInt32Pointer(irsad)
		deriveCouncilRates(&r, nullableFloatPointer(area), nullableFloatPointer(fag), nullableFloatPointer(median),
			nullableFloatPointer(approvals), approvalMonths)
		out = append(out, &r)
		byCode[r.LgaCode] = &r
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	if err := s.attachCouncilHazards(ctx, stateCode, lgaCode, byCode); err != nil {
		log.Warnf("ListCouncils(%s): hazard rollup unavailable: %v", stateCode, err)
	}
	if drops, err := s.councilDrops(ctx, stateCode, lgaCode); err == nil {
		for code, c := range drops {
			if r := byCode[code]; r != nil {
				if agg := aggregateCouncilDrops(c); agg != nil {
					share, asOf := agg.DroppedShare, agg.AsOf
					r.PriceDropShare, r.PriceDropsAsOf, r.PriceDropsDataThrough = &share, &asOf, agg.DataThrough
				}
			}
		}
	} else {
		log.Warnf("ListCouncils(%s): price-drop rollup unavailable: %v", stateCode, err)
	}
	return out, nil
}

// deriveCouncilRates fills the per-resident / per-area figures. Each is absent
// when its inputs are: no ERP means no density, no FAG means no grant per
// resident, fewer than 12 approval months means no 12-month rate.
func deriveCouncilRates(r *CouncilSummaryRow, area, fag, median, approvals *float64, approvalMonths int64) {
	r.AreaSqkm = area
	if median != nil && r.HouseMedianPeriod != "" {
		r.HouseMedian = median
	} else {
		r.HouseMedianPeriod = ""
	}
	pop := float64(r.Population)
	if area != nil && *area > 0 && pop > 0 {
		v := pop / *area
		r.DensityPerSqkm = &v
	}
	if fag != nil && *fag > 0 && pop > 0 && r.FagYear != "" {
		v := *fag / pop
		r.FagPerResident = &v
	} else {
		r.FagYear = ""
	}
	if approvals != nil && approvalMonths >= 12 && pop > 0 {
		v := *approvals / pop * 1000
		r.ApprovalsPer1000 = &v
	} else {
		r.ApprovalsThrough = ""
	}
}

func (s *postgresStore) attachCouncilHazards(ctx context.Context, stateCode, lgaCode string, byCode map[string]*CouncilSummaryRow) error {
	rows, err := s.db.Query(ctx, councilHazardRollupQuery, stateCode, lgaCode, councilMemberMinShare, councilHazardMinCoverage)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var code string
		var flood, fire sql.NullFloat64
		if err := rows.Scan(&code, &flood, &fire); err != nil {
			return err
		}
		if r := byCode[code]; r != nil {
			r.FloodSharePct, r.BushfireSharePct = nullableFloatPointer(flood), nullableFloatPointer(fire)
		}
	}
	return rows.Err()
}

// CouncilDropSuburbRow is one crawled suburb in a council, or (SALCode "")
// the council's own total.
type CouncilDropSuburbRow struct {
	SALCode       string
	SALName       string
	Postcode      string
	Dropped       int32
	Tracked       int32
	MedianDropPct *float64   // 0..1 fraction; absent below the floor
	DataThrough   *time.Time // newest crawl observation behind the row
}

// councilDrops is one council's scan: its total and its crawled suburbs.
type councilDrops struct {
	Total   CouncilDropSuburbRow
	Suburbs []CouncilDropSuburbRow
	AsOf    time.Time
}

// CouncilPriceDropsRow is the council-level aggregate.
type CouncilPriceDropsRow struct {
	Dropped        int32
	Tracked        int32
	DroppedShare   float64
	MedianDropPct  *float64 // median cut over every cut listing in the council
	SuburbsTracked int32
	Suburbs        []CouncilDropSuburbRow // only suburbs clearing the floor themselves
	AsOf           time.Time              // when this was computed (decision 9 as_of)
	DataThrough    *time.Time             // newest crawl observation behind it
}

// councilDrops reads the council price-drop rows from mv_council_price_drops,
// falling back to the live councilDropsQuery only where the view does not
// exist (a database before migration 000127), so dev and test databases keep
// working and a code-before-DDL deploy degrades to the old latency rather
// than to no drops at all.
func (s *postgresStore) councilDrops(ctx context.Context, stateCode, lgaCode string) (map[string]*councilDrops, error) {
	out, err := s.scanCouncilDrops(ctx, councilDropsMVQuery, stateCode, lgaCode)
	if err != nil && isUndefinedTable(err) {
		log.Warnf("council drops: mv_council_price_drops absent, using the live query: %v", err)
		return s.scanCouncilDrops(ctx, councilDropsQuery, stateCode, lgaCode, councilDropsMinCount)
	}
	return out, err
}

func (s *postgresStore) scanCouncilDrops(ctx context.Context, query string, args ...any) (map[string]*councilDrops, error) {
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*councilDrops{}
	for rows.Next() {
		var code string
		var r CouncilDropSuburbRow
		var dropped, tracked int64
		var median sql.NullFloat64
		var through sql.NullTime
		var asOf time.Time
		if err := rows.Scan(&code, &r.SALCode, &r.SALName, &r.Postcode, &dropped, &tracked, &median, &through, &asOf); err != nil {
			return nil, err
		}
		r.Dropped, r.Tracked, r.MedianDropPct = int32(dropped), int32(tracked), nullableFloatPointer(median)
		if through.Valid {
			t := through.Time
			r.DataThrough = &t
		}
		c := out[code]
		if c == nil {
			c = &councilDrops{AsOf: asOf}
			out[code] = c
		}
		if r.SALCode == "" {
			c.Total = r
		} else {
			c.Suburbs = append(c.Suburbs, r)
		}
	}
	return out, rows.Err()
}

// aggregateCouncilDrops applies the floor to the COUNCIL total: fewer than
// councilDropsMinCount cut listings (or no tracked listings) publishes nothing.
// The total is counted from every crawled member suburb, so cuts in suburbs
// under the floor still reach it. Only suburbs that clear the floor themselves
// are named, largest first, and a median over fewer cuts is never carried.
func aggregateCouncilDrops(c *councilDrops) *CouncilPriceDropsRow {
	if c == nil || c.Total.Dropped < councilDropsMinCount || c.Total.Tracked <= 0 {
		return nil
	}
	agg := CouncilPriceDropsRow{
		Dropped: c.Total.Dropped, Tracked: c.Total.Tracked,
		DroppedShare:  float64(c.Total.Dropped) / float64(c.Total.Tracked),
		MedianDropPct: c.Total.MedianDropPct,
		AsOf:          c.AsOf, DataThrough: c.Total.DataThrough,
	}
	for _, s := range c.Suburbs {
		if s.Tracked > 0 {
			agg.SuburbsTracked++
		}
		if s.Dropped >= councilDropsMinCount {
			agg.Suburbs = append(agg.Suburbs, s)
		}
	}
	sort.SliceStable(agg.Suburbs, func(i, j int) bool {
		if agg.Suburbs[i].Dropped != agg.Suburbs[j].Dropped {
			return agg.Suburbs[i].Dropped > agg.Suburbs[j].Dropped
		}
		return agg.Suburbs[i].SALCode < agg.Suburbs[j].SALCode
	})
	return &agg
}

func medianOf(values []float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	n := len(sorted)
	v := sorted[n/2]
	if n%2 == 0 {
		v = (sorted[n/2-1] + sorted[n/2]) / 2
	}
	return &v
}

// ── Profile ─────────────────────────────────────────────────────────────────

// CouncilProfileRow is everything held for one council.
type CouncilProfileRow struct {
	// Base LgaInfo fields (the same columns the suburb profile's card reads).
	LgaName           string
	AreaSqkm          float64
	FagAud            float64
	FagYear           string
	AvgRates          float64
	OpSurplusRatio    float64
	AssetRenewalRatio float64
	FinSource         string
	FinYear           string
	FactsAsOf         *time.Time
	// 000126 facts, shared with the suburb profile's council card.
	Facts SuburbCouncilRow

	Summary      *CouncilSummaryRow
	Series       []CouncilSeriesRow
	Suburbs      []CouncilSuburbRow
	Rollup       CouncilRollupRow
	FederalSeats []CouncilRepresentativeRow
	StateSeats   []CouncilRepresentativeRow
	PriceDrops   *CouncilPriceDropsRow
	Neighbours   []CouncilNeighbourRow
}

// CouncilSeriesRow is one lga_series measure, ascending by period.
type CouncilSeriesRow struct {
	Measure       string
	Unit          string
	Source        string
	SourceLicence string
	Points        []CouncilSeriesPointRow
}

type CouncilSeriesPointRow struct {
	Period      time.Time
	PeriodLabel string
	Value       float64
}

// CouncilSuburbRow is one member suburb. VGMedian is the suburb's OWN
// Valuer-General median — never the council's.
type CouncilSuburbRow struct {
	SALCode          string
	SALName          string
	Postcode         string
	Population       int32
	Share            float64
	Dominant         bool
	VGMedian         *float64
	VGMedianPeriod   *time.Time
	FloodSharePct    *float64
	BushfireSharePct *float64
	WaterSharePct    *float64
	SeifaIrsadDecile *int32
	FederalDivision  string
	FederalMember    string
	FederalParty     string
	FederalPartyAb   string
	StateDistrict    string
	StateMember      string
	StateParty       string
	StatePartyAb     string
}

// CouncilRollupRow aggregates the member suburbs.
type CouncilRollupRow struct {
	MemberSuburbs          int32
	DominantSuburbs        int32
	FloodSharePct          *float64
	FloodCoveredSuburbs    int32
	BushfireSharePct       *float64
	BushfireCoveredSuburbs int32
	WaterSharePct          *float64
	WaterCoveredSuburbs    int32
	PricedSuburbs          int32
	MedianMin              *float64
	MedianMax              *float64
	MedianOfMedians        *float64
	Crime                  []CouncilCrimeStatRow
}

type CouncilCrimeStatRow struct {
	CrimeType          string
	RatePer100k        float64
	FYEnding           int32
	CoveredSuburbs     int32
	SourceJurisdiction string
	Source             string
	SourceLicence      string
}

type CouncilRepresentativeRow struct {
	Name            string
	Member          string
	Party           string
	PartyAb         string
	PopulationShare float64
	SuburbCount     int32
}

type CouncilNeighbourRow struct {
	LgaCode       string
	Slug          string
	DisplayName   string
	Kind          string
	StateCode     string
	SharesBorder  bool
	SharedSuburbs int32
}

// councilIdentityQuery resolves (state, slug) to one council with a page and
// reads its current facts. Pseudo areas ("No usual address") never match.
const councilIdentityQuery = `
		SELECT lg.lga_code24, lg.lga_name, COALESCE(lg.area_sqkm, 0), COALESCE(lg.fed_fag_aud, 0),
		       COALESCE(lg.fed_fag_year, ''), COALESCE(lg.avg_rates, 0), COALESCE(lg.op_surplus_ratio, 0),
		       COALESCE(lg.asset_renewal_ratio, 0), COALESCE(lg.fin_source, ''), COALESCE(lg.fin_year, ''),
		       lg.fetched_at,
		       lg.slug, COALESCE(NULLIF(lg.display_name, ''), lg.lga_name), lg.kind,
		       COALESCE(lg.erp_year, 0), lg.pop_growth_pct, lg.median_age, lg.median_hhd_income,
		       lg.pct_rented, lg.median_weekly_rent, lg.median_mortgage_monthly, lg.avg_household_size,
		       lg.seifa_irsad_decile, lg.seifa_irsd_decile,
		       COALESCE(lg.website, ''), COALESCE(lg.wikidata_qid, ''), lg.centroid_lat, lg.centroid_lon,
		       hm.value, COALESCE(hm.period_label, '')
		FROM lga lg
		LEFT JOIN LATERAL (
			SELECT ls.value, ls.period_label
			FROM lga_series ls
			WHERE ls.lga_code24 = lg.lga_code24 AND ls.measure = 'house_median_price'
			  AND ls.source_licence <> 'proprietary-tos-restricted'
			ORDER BY ls.period DESC
			LIMIT 1
		) hm ON true
		WHERE lg.state_code = $1 AND lg.slug = $2 AND lg.kind IN ('council', 'unincorporated')`

// councilSeriesQuery reads every licence-clean series for the council.
const councilSeriesQuery = `
		SELECT measure, unit, source, source_licence, period, COALESCE(period_label, ''), value
		FROM lga_series
		WHERE lga_code24 = $1 AND source_licence <> 'proprietary-tos-restricted'
		ORDER BY measure, source, period`

// councilSuburbsQuery lists the member suburbs with the per-suburb facts the
// hub table and every Go-side rollup read. vg_median comes from the suburb's
// own public price series (preferredSuburbRegionJoin); a suburb without one
// stays NULL — the council median is never substituted.
const councilSuburbsQuery = `
		WITH` + councilMembersCTE + `
		SELECT d.sal_code, d.sal_name, COALESCE(d.postcode, ''), COALESCE(d.population, 0),
		       m.share, m.dominant, r.value, r.period,
		       h.flood_planning_share_pct, h.bushfire_prone_share_pct, h.water_observed_share_pct,
		       d.seifa_irsad_decile_aus,
		       COALESCE(d.federal_division, ''), COALESCE(d.federal_member, ''),
		       COALESCE(d.federal_party, ''), COALESCE(d.federal_party_ab, ''),
		       COALESCE(d.state_district, ''), COALESCE(d.state_member, ''),
		       COALESCE(d.state_party, ''), COALESCE(d.state_party_ab, '')
		FROM m
		JOIN suburb_demographics d ON d.sal_code = m.sal_code` + preferredSuburbRegionJoin + `
		LEFT JOIN suburb_hazard_exposure h ON h.sal_code = d.sal_code AND h.source_licence <> 'proprietary-tos-restricted'
		ORDER BY COALESCE(d.population, 0) DESC, d.sal_name, d.sal_code`

// councilCrimeQuery pools the latest gated crime rates over member suburbs the
// source covers, weighted by the residents each contributes. A rate per 100k
// weighted by population is total incidents over total population.
const councilCrimeQuery = `
		WITH` + councilMembersCTE + `
		SELECT c.crime_type, max(c.fy_ending)::int,
		       sum(c.rate_per_100k::float8 * c.population * m.share) / NULLIF(sum(c.population * m.share), 0),
		       count(DISTINCT c.sal_code)::int,
		       min(c.source_jurisdiction), min(c.source), min(c.source_licence)
		FROM m
		JOIN mv_suburb_crime_latest c ON c.sal_code = m.sal_code
		WHERE NOT c.small_pop AND NOT c.unreliable AND c.population > 0 AND c.rate_per_100k IS NOT NULL
		GROUP BY c.crime_type
		ORDER BY c.crime_type`

// councilStraddleNeighboursQuery counts the suburbs split between this council
// and each other council (both at >= 1%, the bridge's own floor).
const councilStraddleNeighboursQuery = `
		SELECT o2.lga_code24, count(DISTINCT sl.sal_code)::int
		FROM suburb_lga sl
		CROSS JOIN LATERAL jsonb_to_recordset(sl.overlap_lgas) AS o1(lga_code24 text, share double precision)
		CROSS JOIN LATERAL jsonb_to_recordset(sl.overlap_lgas) AS o2(lga_code24 text, share double precision)
		WHERE sl.overlap_lgas @> jsonb_build_array(jsonb_build_object('lga_code24', $1::text))
		  AND o1.lga_code24 = $1 AND o2.lga_code24 <> $1
		GROUP BY o2.lga_code24`

const councilNeighbourIdentityQuery = `
		SELECT lga_code24, CASE WHEN kind IN ('council', 'unincorporated') THEN COALESCE(slug, '') ELSE '' END,
		       COALESCE(NULLIF(display_name, ''), lga_name), COALESCE(kind, ''), COALESCE(state_code, '')
		FROM lga
		WHERE lga_code24 = ANY($1) AND COALESCE(kind, '') <> 'pseudo'`

// GetCouncilProfile returns one council's hub, or ErrCouncilNotFound.
func (s *postgresStore) GetCouncilProfile(stateCode, slug string) (*CouncilProfileRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	p := &CouncilProfileRow{}
	var (
		code                                          string
		fetched                                       sql.NullTime
		growth, age, rented, hhSize, lat, lon, median sql.NullFloat64
		income, rent, mortgage, irsad, irsd           sql.NullInt32
	)
	f := &p.Facts
	err := s.db.QueryRow(ctx, councilIdentityQuery, stateCode, slug).Scan(
		&code, &p.LgaName, &p.AreaSqkm, &p.FagAud, &p.FagYear, &p.AvgRates, &p.OpSurplusRatio,
		&p.AssetRenewalRatio, &p.FinSource, &p.FinYear, &fetched,
		&f.Slug, &f.DisplayName, &f.Kind, &f.ErpYear, &growth, &age, &income,
		&rented, &rent, &mortgage, &hhSize, &irsad, &irsd,
		&f.Website, &f.WikidataQID, &lat, &lon, &median, &f.HouseMedianPeriod,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrCouncilNotFound
		}
		return nil, err
	}
	if fetched.Valid {
		t := fetched.Time
		p.FactsAsOf = &t
	}
	f.PopGrowthPct, f.MedianAge, f.PctRented = nullableFloatPointer(growth), nullableFloatPointer(age), nullableFloatPointer(rented)
	f.AvgHouseholdSize, f.CentroidLat, f.CentroidLon = nullableFloatPointer(hhSize), nullableFloatPointer(lat), nullableFloatPointer(lon)
	f.HouseMedian = nullableFloatPointer(median)
	f.MedianHhdIncome, f.MedianWeeklyRent, f.MedianMortgageMonthly = nullableInt32Pointer(income), nullableInt32Pointer(rent), nullableInt32Pointer(mortgage)
	f.SeifaIrsadDecile, f.SeifaIrsdDecile = nullableInt32Pointer(irsad), nullableInt32Pointer(irsd)
	if f.HouseMedian == nil {
		f.HouseMedianPeriod = ""
	}

	summaries, err := s.councilSummaries(ctx, stateCode, code)
	if err != nil {
		return nil, err
	}
	if len(summaries) == 1 {
		p.Summary = summaries[0]
	}
	if series, err := s.councilSeries(ctx, code); err == nil {
		p.Series = series
	} else {
		log.Warnf("GetCouncilProfile(%s): series unavailable: %v", code, err)
	}
	if suburbs, err := s.councilSuburbs(ctx, stateCode, code); err == nil {
		p.Suburbs = suburbs
		p.Rollup = rollupCouncilSuburbs(suburbs)
		p.FederalSeats, p.StateSeats = councilRepresentation(suburbs)
	} else {
		log.Warnf("GetCouncilProfile(%s): member suburbs unavailable: %v", code, err)
	}
	if crime, err := s.councilCrime(ctx, stateCode, code); err == nil {
		p.Rollup.Crime = crime
	} else {
		log.Warnf("GetCouncilProfile(%s): crime rollup unavailable: %v", code, err)
	}
	if drops, err := s.councilDrops(ctx, stateCode, code); err == nil {
		p.PriceDrops = aggregateCouncilDrops(drops[code])
	} else {
		log.Warnf("GetCouncilProfile(%s): price drops unavailable: %v", code, err)
	}
	if neighbours, err := s.councilNeighbours(ctx, code); err == nil {
		p.Neighbours = neighbours
	} else {
		log.Warnf("GetCouncilProfile(%s): neighbours unavailable: %v", code, err)
	}
	return p, nil
}

func (s *postgresStore) councilSeries(ctx context.Context, code string) ([]CouncilSeriesRow, error) {
	rows, err := s.db.Query(ctx, councilSeriesQuery, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CouncilSeriesRow
	for rows.Next() {
		var measure, unit, source, licence string
		var pt CouncilSeriesPointRow
		if err := rows.Scan(&measure, &unit, &source, &licence, &pt.Period, &pt.PeriodLabel, &pt.Value); err != nil {
			return nil, err
		}
		if n := len(out); n == 0 || out[n-1].Measure != measure || out[n-1].Source != source {
			out = append(out, CouncilSeriesRow{Measure: measure, Unit: unit, Source: source, SourceLicence: licence})
		}
		last := &out[len(out)-1]
		last.Points = append(last.Points, pt)
	}
	return out, rows.Err()
}

func (s *postgresStore) councilSuburbs(ctx context.Context, stateCode, code string) ([]CouncilSuburbRow, error) {
	rows, err := s.db.Query(ctx, councilSuburbsQuery, stateCode, code, councilMemberMinShare)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CouncilSuburbRow
	for rows.Next() {
		var (
			r                  CouncilSuburbRow
			median             sql.NullFloat64
			period             sql.NullTime
			flood, fire, water sql.NullFloat64
			irsad              sql.NullInt32
		)
		if err := rows.Scan(&r.SALCode, &r.SALName, &r.Postcode, &r.Population, &r.Share, &r.Dominant,
			&median, &period, &flood, &fire, &water, &irsad,
			&r.FederalDivision, &r.FederalMember, &r.FederalParty, &r.FederalPartyAb,
			&r.StateDistrict, &r.StateMember, &r.StateParty, &r.StatePartyAb); err != nil {
			return nil, err
		}
		r.VGMedian = nullableFloatPointer(median)
		if r.VGMedian != nil && period.Valid {
			t := period.Time
			r.VGMedianPeriod = &t
		} else {
			r.VGMedian = nil
		}
		r.FloodSharePct, r.BushfireSharePct, r.WaterSharePct = nullableFloatPointer(flood), nullableFloatPointer(fire), nullableFloatPointer(water)
		r.SeifaIrsadDecile = nullableInt32Pointer(irsad)
		out = append(out, r)
	}
	return out, rows.Err()
}

// rollupCouncilSuburbs weights hazard shares by the residents each member
// suburb contributes (population x share) over the suburbs the source covers,
// so a council with no covered suburb stays absent. The price rollup uses the
// DOMINANT members' own medians only, unweighted: a suburb 5% inside the
// council would otherwise count as if it were wholly in it.
func rollupCouncilSuburbs(suburbs []CouncilSuburbRow) CouncilRollupRow {
	var out CouncilRollupRow
	type acc struct {
		num, den float64
		n        int32
	}
	var flood, fire, water acc
	add := func(a *acc, v *float64, w float64) {
		if v == nil {
			return
		}
		a.n++
		a.num += *v * w
		a.den += w
	}
	var medians []float64
	for _, s := range suburbs {
		out.MemberSuburbs++
		if s.Dominant {
			out.DominantSuburbs++
			if s.VGMedian != nil && *s.VGMedian > 0 {
				medians = append(medians, *s.VGMedian)
			}
		}
		w := float64(s.Population) * s.Share
		add(&flood, s.FloodSharePct, w)
		add(&fire, s.BushfireSharePct, w)
		add(&water, s.WaterSharePct, w)
	}
	finish := func(a acc) *float64 {
		if a.n == 0 || a.den <= 0 {
			return nil
		}
		v := a.num / a.den
		return &v
	}
	out.FloodSharePct, out.FloodCoveredSuburbs = finish(flood), flood.n
	out.BushfireSharePct, out.BushfireCoveredSuburbs = finish(fire), fire.n
	out.WaterSharePct, out.WaterCoveredSuburbs = finish(water), water.n
	if len(medians) > 0 {
		sort.Float64s(medians)
		lo, hi := medians[0], medians[len(medians)-1]
		out.PricedSuburbs = int32(len(medians))
		out.MedianMin, out.MedianMax = &lo, &hi
		out.MedianOfMedians = medianOf(medians)
	}
	return out
}

// councilRepresentation groups member suburbs by federal electorate and state
// district, weighted by the residents each contributes. Suburbs with no seat
// recorded are left out of both the numerator and the denominator.
func councilRepresentation(suburbs []CouncilSuburbRow) (federal, state []CouncilRepresentativeRow) {
	group := func(key func(CouncilSuburbRow) (CouncilRepresentativeRow, bool)) []CouncilRepresentativeRow {
		byName := map[string]*CouncilRepresentativeRow{}
		weights := map[string]float64{}
		var total float64
		var order []string
		for _, s := range suburbs {
			seat, ok := key(s)
			if !ok {
				continue
			}
			w := float64(s.Population) * s.Share
			total += w
			if _, seen := byName[seat.Name]; !seen {
				copied := seat
				byName[seat.Name] = &copied
				order = append(order, seat.Name)
			}
			weights[seat.Name] += w
			byName[seat.Name].SuburbCount++
		}
		out := make([]CouncilRepresentativeRow, 0, len(order))
		for _, name := range order {
			r := *byName[name]
			if total > 0 {
				r.PopulationShare = math.Round(weights[name]/total*1000) / 1000
			}
			out = append(out, r)
		}
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].PopulationShare != out[j].PopulationShare {
				return out[i].PopulationShare > out[j].PopulationShare
			}
			return out[i].Name < out[j].Name
		})
		return out
	}
	federal = group(func(s CouncilSuburbRow) (CouncilRepresentativeRow, bool) {
		return CouncilRepresentativeRow{Name: s.FederalDivision, Member: s.FederalMember, Party: s.FederalParty, PartyAb: s.FederalPartyAb}, s.FederalDivision != ""
	})
	state = group(func(s CouncilSuburbRow) (CouncilRepresentativeRow, bool) {
		return CouncilRepresentativeRow{Name: s.StateDistrict, Member: s.StateMember, Party: s.StateParty, PartyAb: s.StatePartyAb}, s.StateDistrict != ""
	})
	return federal, state
}

func (s *postgresStore) councilCrime(ctx context.Context, stateCode, code string) ([]CouncilCrimeStatRow, error) {
	rows, err := s.db.Query(ctx, councilCrimeQuery, stateCode, code, councilMemberMinShare)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CouncilCrimeStatRow
	for rows.Next() {
		var r CouncilCrimeStatRow
		var rate sql.NullFloat64
		if err := rows.Scan(&r.CrimeType, &r.FYEnding, &rate, &r.CoveredSuburbs,
			&r.SourceJurisdiction, &r.Source, &r.SourceLicence); err != nil {
			return nil, err
		}
		if !rate.Valid || r.CoveredSuburbs == 0 {
			continue
		}
		r.RatePer100k = rate.Float64
		out = append(out, r)
	}
	return out, rows.Err()
}

//go:embed lga_adjacency.json
var lgaAdjacencyJSON []byte

// lgaAdjacency is council -> councils sharing a suburb boundary, derived from
// the committed suburb topology by web/scripts/geo/build-lga-adjacency.mjs.
// The database holds no geometry, so this is the only adjacency source.
var lgaAdjacency = mustParseLgaAdjacency(lgaAdjacencyJSON)

func mustParseLgaAdjacency(raw []byte) map[string][]string {
	var doc struct {
		Neighbours map[string][]string `json:"neighbours"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		panic(fmt.Sprintf("lga_adjacency.json: %v", err))
	}
	return doc.Neighbours
}

// councilNeighbours merges the two neighbour signals: a shared suburb border
// (topology) and suburbs split between the two councils (the mesh-block
// bridge). BOTH are within one state: the topology is per state, and a suburb
// and a council each nest inside a single state, so no suburb straddles a
// state line. Cross-border pairs (Albury–Wodonga, Queanbeyan-Palerang–ACT,
// Tweed–Gold Coast) are therefore never neighbours here, and the page says
// "in the same state".
func (s *postgresStore) councilNeighbours(ctx context.Context, code string) ([]CouncilNeighbourRow, error) {
	byCode := map[string]*CouncilNeighbourRow{}
	for _, n := range lgaAdjacency[code] {
		byCode[n] = &CouncilNeighbourRow{LgaCode: n, SharesBorder: true}
	}
	rows, err := s.db.Query(ctx, councilStraddleNeighboursQuery, code)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var n string
		var shared int32
		if err := rows.Scan(&n, &shared); err != nil {
			rows.Close()
			return nil, err
		}
		if byCode[n] == nil {
			byCode[n] = &CouncilNeighbourRow{LgaCode: n}
		}
		byCode[n].SharedSuburbs = shared
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(byCode) == 0 {
		return nil, nil
	}
	codes := make([]string, 0, len(byCode))
	for c := range byCode {
		codes = append(codes, c)
	}
	idRows, err := s.db.Query(ctx, councilNeighbourIdentityQuery, codes)
	if err != nil {
		return nil, err
	}
	defer idRows.Close()
	var out []CouncilNeighbourRow
	for idRows.Next() {
		var c string
		var r CouncilNeighbourRow
		if err := idRows.Scan(&c, &r.Slug, &r.DisplayName, &r.Kind, &r.StateCode); err != nil {
			return nil, err
		}
		base := byCode[c]
		r.LgaCode, r.SharesBorder, r.SharedSuburbs = c, base.SharesBorder, base.SharedSuburbs
		out = append(out, r)
	}
	if err := idRows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].DisplayName != out[j].DisplayName {
			return out[i].DisplayName < out[j].DisplayName
		}
		return out[i].LgaCode < out[j].LgaCode
	})
	return out, nil
}
