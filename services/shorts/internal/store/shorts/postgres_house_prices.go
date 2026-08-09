package shorts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/jackc/pgx/v5"
)

// HousingMetricRow is a region's latest house-price observation with QoQ/YoY change.
type HousingMetricRow struct {
	RegionCode    string
	RegionName    string
	RegionType    string
	StateCode     string
	Measure       string
	DwellingType  string
	Value         float64
	Unit          string
	Period        time.Time
	IsPreliminary bool
	QoQPct        float64
	YoYPct        float64
}

// HousePricePointRow is one point in a house-price time series.
type HousePricePointRow struct {
	Period        time.Time
	Value         float64
	IsPreliminary bool
}

// HousePriceSeriesResult is a full series for a region × measure × dwelling.
type HousePriceSeriesResult struct {
	RegionCode    string
	RegionName    string
	Measure       string
	DwellingType  string
	Unit          string
	Source        string
	SourceLicence string
	Points        []*HousePricePointRow
}

// GetHousingOverview returns the latest observation + QoQ/YoY change per region ×
// measure from mv_housing_headline, optionally filtered to one region_type.
func (s *postgresStore) GetHousingOverview(regionType string) ([]*HousingMetricRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	const query = `
		SELECT h.region_code, COALESCE(r.region_name, ''), COALESCE(r.region_type, ''),
		       COALESCE(r.state_code, ''), h.measure, h.dwelling_type, h.value,
		       COALESCE(h.unit, ''), h.period, h.is_preliminary,
		       COALESCE(h.qoq_pct, 0), COALESCE(h.yoy_pct, 0)
		FROM mv_housing_headline h
		JOIN house_price_regions r ON r.region_code = h.region_code
		-- Unfiltered ("") = the /housing dashboard headline: national + gccsa +
		-- state only. Exclude suburb rows (SA metro is the only region_type that
		-- ingests quarterly, so mv_housing_headline carries ~350 Adelaide suburbs
		-- the dashboard never renders — ~113KB / 82% of the response). Explicit
		-- region_type filters still resolve suburbs for callers that ask.
		WHERE (($1 <> '' AND r.region_type = $1) OR ($1 = '' AND r.region_type <> 'suburb'))
		ORDER BY r.region_type, h.measure, h.value DESC`

	rows, err := s.db.Query(ctx, query, regionType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*HousingMetricRow
	for rows.Next() {
		var m HousingMetricRow
		if err := rows.Scan(&m.RegionCode, &m.RegionName, &m.RegionType, &m.StateCode,
			&m.Measure, &m.DwellingType, &m.Value, &m.Unit, &m.Period, &m.IsPreliminary,
			&m.QoQPct, &m.YoYPct); err != nil {
			return nil, err
		}
		out = append(out, &m)
	}
	return out, rows.Err()
}

// GetHousePriceSeries returns the full quarterly series for one region × measure
// (× dwelling_type) from house_prices.
func (s *postgresStore) GetHousePriceSeries(regionCode, measure, dwellingType string) (*HousePriceSeriesResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if dwellingType == "" {
		dwellingType = "all"
	}

	const query = `
		SELECT hp.period, hp.value, hp.is_preliminary, COALESCE(hp.unit, ''),
		       hp.source, hp.source_licence, COALESCE(r.region_name, '')
		FROM house_prices hp
		JOIN house_price_regions r ON r.region_code = hp.region_code
		WHERE hp.region_code = $1 AND hp.measure = $2 AND hp.dwelling_type = $3
		  AND hp.source_licence <> 'proprietary-tos-restricted'
		ORDER BY hp.period ASC`

	rows, err := s.db.Query(ctx, query, regionCode, measure, dwellingType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := &HousePriceSeriesResult{RegionCode: regionCode, Measure: measure, DwellingType: dwellingType}
	for rows.Next() {
		var p HousePricePointRow
		var unit, source, licence, regionName string
		if err := rows.Scan(&p.Period, &p.Value, &p.IsPreliminary, &unit, &source, &licence, &regionName); err != nil {
			return nil, err
		}
		result.Unit, result.Source, result.SourceLicence, result.RegionName = unit, source, licence, regionName
		result.Points = append(result.Points, &p)
	}
	return result, rows.Err()
}

// SuburbSummaryRow is a suburb for the state map/list (SAL-spined, price LEFT-joined).
type SuburbSummaryRow struct {
	SALCode               string
	SALName               string
	StateCode             string
	Postcode              string
	LatestMedianPrice     float64
	LatestPeriod          *time.Time
	YoYPct                float64
	Population            int32
	MedianAge             float64
	MedianWeeklyHhdIncome float64
	RegionCode            string
	PctBornOverseas       float64
	TopReligion           string
	TopLanguage           string
	PctTopLanguage        float64
	FederalDivision       string
	FederalMember         string
	FederalParty          string
	FederalPartyAb        string
	FederalTppAlp         float64
	StateDistrict         string
	StateMember           string
	StateParty            string
	StatePartyAb          string
	// amenity/lifestyle metrics (Local Insights); 0 when not yet ingested
	SchoolsTotal         int32
	SupermarketsTotal    int32
	ColesCount           int32
	WoolworthsCount      int32
	AldiCount            int32
	IgaCount             int32
	PubsBars             int32
	ParksCount           int32
	LibrariesCount       int32
	NearestSupermarketKm float64
	AmenityDensityScore  float64
	HospitalsCount       int32
	GpCount              int32
	PharmacyCount        int32
	NearestTrainKm       float64
	// Declared properties resolving to this suburb (registers of interests).
	PoliticianPropertyCount int32
	NearestHospitalKm       float64
	DistToCoastKm           float64
	// school sector/type split (per-state CC-BY open data)
	SchoolsGov         int32
	SchoolsCatholic    int32
	SchoolsIndependent int32
	SchoolsPrimary     int32
	SchoolsSecondary   int32
	NearestSecondaryKm float64
	// NBN connectivity (Local Insights)
	DominantNbnTech          string
	ConnectivityQualityScore float64
	// Crime percentile ranks (latest pooled FY, gated MV); 0 = no data.
	CrimeBreakInsRank     float64
	CrimeViolentRank      float64
	CrimeMotorVehicleRank float64
}

// SuburbCrimeStatRow is one latest-pooled, gated crime observation.
type SuburbCrimeStatRow struct {
	CrimeType    string
	FYEnding     int32
	RatePer100k  float64
	PctRank      float64
	Jurisdiction string
	Source       string
	Licence      string
}

// SuburbProfileRow is the full per-suburb profile (demographics + headline price).
type SuburbProfileRow struct {
	Summary SuburbSummaryRow
	// full demographics
	MedianWeeklyPerIncome float64
	MedianWeeklyRent      float64
	MedianMonthlyMortgage float64
	PctOwnedOutright      float64
	PctOwnedMortgage      float64
	PctRented             float64
	DwellingCount         int32
	CensusYear            int32
	// cultural demographics — profile-only extras (born-overseas, top religion,
	// top language and their shares live on the embedded Summary).
	PctEnglishOnly float64
	PctTopReligion float64
	PctNoReligion  float64
	// baselines
	StateMedianPrice        float64
	NationalMedianPrice     float64
	StateMedianHhdIncome    float64
	NationalMedianHhdIncome float64
	// council (LGA)
	LgaCode       string
	LgaName       string
	LgaState      string
	LgaAreaSqkm   float64
	LgaPopulation int32
	LgaFagAud     float64
	LgaFagYear    string
	// per-council financials (VIC LGPRF; 0/'' for states not yet sourced)
	LgaAvgRates          float64
	LgaOpSurplusRatio    float64
	LgaAssetRenewalRatio float64
	LgaFinSource         string
	LgaFinYear           string
	// editorial banner header (archetype, blurb, landmarks, background) — the
	// landmarks are left as raw jsonb bytes for the service layer to unmarshal
	// into proto SuburbLandmark values.
	BannerArchetype string
	BannerBlurb     string
	BannerLandmarks []byte
	BannerBgKey     string
	BannerBgUrl     string
	// most-similar suburbs (feature-vector kNN — the knowledge-graph "similar_to")
	Similar []SimilarSuburbRow
	// latest pooled crime observations; empty means no reliable data
	Crime []SuburbCrimeStatRow
}

// SimilarSuburbRow is one near-neighbour in demographic+amenity feature space.
type SimilarSuburbRow struct {
	SALCode           string
	SALName           string
	StateCode         string
	LatestMedianPrice float64
	RegionCode        string
	Distance          float64
}

const listStateSuburbsCrimeJoin = `
		LEFT JOIN (
			-- Latest pooled, CVS-adjusted crime ranks, pivoted per suburb. The MV
			-- (000092) is already gated; this WHERE re-asserts the small_pop/
			-- unreliable gate as defense-in-depth.
			SELECT sal_code,
			       MAX(pct_rank) FILTER (WHERE crime_type = 'break_ins') AS break_ins_rank,
			       MAX(pct_rank) FILTER (WHERE crime_type = 'violent') AS violent_rank,
			       MAX(pct_rank) FILTER (WHERE crime_type = 'motor_vehicle') AS motor_vehicle_rank
			FROM mv_suburb_crime_latest
			WHERE NOT small_pop AND NOT unreliable
			GROUP BY sal_code
		) cr ON cr.sal_code = d.sal_code`

func displayCrimeRank(rank sql.NullFloat64) float64 {
	if !rank.Valid {
		return 0
	}
	return math.Max(math.Round(rank.Float64*10)/10, 0.1)
}

// ListStateSuburbs returns every SAL suburb in a state, LEFT JOINed to its latest
// median price (via the sal_code bridge) and headline demographics.
func (s *postgresStore) ListStateSuburbs(stateCode, query string, limit int32) ([]*SuburbSummaryRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if limit <= 0 || limit > 20000 {
		limit = 5000
	}
	const q = `
		SELECT d.sal_code, d.sal_name, d.state_code, COALESCE(d.postcode, ''),
		       COALESCE(h.value, 0), h.period, COALESCE(h.yoy_pct, 0),
		       COALESCE(d.population, 0), COALESCE(d.median_age, 0),
		       COALESCE(d.median_weekly_hhd_income, 0), COALESCE(r.region_code, ''),
		       COALESCE(d.pct_born_overseas, 0), COALESCE(d.top_religion, ''),
		       COALESCE(d.top_language, ''), COALESCE(d.pct_top_language, 0),
		       COALESCE(d.federal_division, ''), COALESCE(d.federal_member, ''),
		       COALESCE(d.federal_party, ''), COALESCE(d.federal_party_ab, ''),
		       COALESCE(d.federal_tpp_alp, 0), COALESCE(d.state_district, ''),
		       COALESCE(d.state_member, ''), COALESCE(d.state_party, ''), COALESCE(d.state_party_ab, ''),
		       COALESCE(a.schools_total,0), COALESCE(a.supermarkets_total,0), COALESCE(a.coles_count,0),
		       COALESCE(a.woolworths_count,0), COALESCE(a.aldi_count,0), COALESCE(a.iga_count,0),
		       COALESCE(a.pubs_bars,0), COALESCE(a.parks_count,0), COALESCE(a.libraries_count,0),
		       COALESCE(a.nearest_supermarket_km,0), COALESCE(a.amenity_density_score,0),
		       COALESCE(a.hospitals_count,0), COALESCE(a.gp_count,0), COALESCE(a.pharmacy_count,0),
		       COALESCE(a.nearest_train_km,0), COALESCE(a.nearest_hospital_km,0),
		       COALESCE(a.dist_to_coast_km,0),
		       COALESCE(a.schools_gov,0), COALESCE(a.schools_catholic,0), COALESCE(a.schools_independent,0),
		       COALESCE(a.schools_primary,0), COALESCE(a.schools_secondary,0), COALESCE(a.nearest_secondary_km,0),
		       COALESCE(c.dominant_nbn_tech,''), COALESCE(c.connectivity_quality_score,0),
		       cr.break_ins_rank, cr.violent_rank, cr.motor_vehicle_rank,
		       COALESCE(rp.declared_property_count, 0)
		FROM suburb_demographics d
		LEFT JOIN house_price_regions r ON r.sal_code = d.sal_code AND r.region_type = 'suburb'
		LEFT JOIN suburb_amenities a ON a.sal_code = d.sal_code
		LEFT JOIN suburb_connectivity c ON c.sal_code = d.sal_code
		-- Register-of-interests property counts. Read from the MV, never a
		-- per-request aggregate: this query returns ~5,000 rows per state.
		LEFT JOIN mv_register_suburb_property rp ON rp.sal_code = d.sal_code` + listStateSuburbsCrimeJoin + `
		-- Latest median from house_prices directly (NOT the quarterly-only MV) so annual
		-- Valuer-General states (VIC) light up too; YoY computed vs the obs ~1yr prior.
		LEFT JOIN LATERAL (
			SELECT hp.value, hp.period,
			       (hp.value / NULLIF((
			          SELECT p.value FROM house_prices p
			          WHERE p.region_code = r.region_code AND p.measure = 'median_price'
			            AND p.dwelling_type = 'house' AND p.source_licence <> 'proprietary-tos-restricted' AND p.period <= hp.period - INTERVAL '11 months'
			          ORDER BY p.period DESC LIMIT 1), 0) - 1) * 100 AS yoy_pct
			FROM house_prices hp
			WHERE hp.region_code = r.region_code AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
			  AND hp.source_licence <> 'proprietary-tos-restricted'
			ORDER BY hp.period DESC LIMIT 1
		) h ON true
		WHERE d.state_code = $1
		  AND ($2 = '' OR d.sal_name ILIKE '%' || $2 || '%')
		ORDER BY d.sal_name
		LIMIT $3`
	rows, err := s.db.Query(ctx, q, stateCode, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*SuburbSummaryRow
	for rows.Next() {
		var r SuburbSummaryRow
		var breakInsRank, violentRank, motorVehicleRank sql.NullFloat64
		if err := rows.Scan(&r.SALCode, &r.SALName, &r.StateCode, &r.Postcode,
			&r.LatestMedianPrice, &r.LatestPeriod, &r.YoYPct,
			&r.Population, &r.MedianAge, &r.MedianWeeklyHhdIncome, &r.RegionCode,
			&r.PctBornOverseas, &r.TopReligion, &r.TopLanguage, &r.PctTopLanguage,
			&r.FederalDivision, &r.FederalMember, &r.FederalParty, &r.FederalPartyAb, &r.FederalTppAlp,
			&r.StateDistrict, &r.StateMember, &r.StateParty, &r.StatePartyAb,
			&r.SchoolsTotal, &r.SupermarketsTotal, &r.ColesCount, &r.WoolworthsCount, &r.AldiCount, &r.IgaCount,
			&r.PubsBars, &r.ParksCount, &r.LibrariesCount, &r.NearestSupermarketKm, &r.AmenityDensityScore,
			&r.HospitalsCount, &r.GpCount, &r.PharmacyCount, &r.NearestTrainKm, &r.NearestHospitalKm,
			&r.DistToCoastKm,
			&r.SchoolsGov, &r.SchoolsCatholic, &r.SchoolsIndependent, &r.SchoolsPrimary, &r.SchoolsSecondary, &r.NearestSecondaryKm,
			&r.DominantNbnTech, &r.ConnectivityQualityScore,
			&breakInsRank, &violentRank, &motorVehicleRank,
			&r.PoliticianPropertyCount); err != nil {
			return nil, err
		}
		r.CrimeBreakInsRank = displayCrimeRank(breakInsRank)
		r.CrimeViolentRank = displayCrimeRank(violentRank)
		r.CrimeMotorVehicleRank = displayCrimeRank(motorVehicleRank)
		out = append(out, &r)
	}
	return out, rows.Err()
}

// GetSuburbProfile returns one suburb's full demographics + headline price +
// state/national comparison baselines.
func (s *postgresStore) GetSuburbProfile(salCode string) (*SuburbProfileRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const q = `
		SELECT d.sal_code, d.sal_name, d.state_code, COALESCE(d.postcode, ''),
		       COALESCE(h.value, 0), h.period, COALESCE(h.yoy_pct, 0),
		       COALESCE(d.population, 0), COALESCE(d.median_age, 0),
		       COALESCE(d.median_weekly_hhd_income, 0), COALESCE(r.region_code, ''),
		       COALESCE(d.pct_born_overseas, 0), COALESCE(d.top_religion, ''),
		       COALESCE(d.top_language, ''), COALESCE(d.pct_top_language, 0),
		       COALESCE(d.federal_division, ''), COALESCE(d.federal_member, ''),
		       COALESCE(d.federal_party, ''), COALESCE(d.federal_party_ab, ''),
		       COALESCE(d.federal_tpp_alp, 0), COALESCE(d.state_district, ''),
		       COALESCE(d.state_member, ''), COALESCE(d.state_party, ''), COALESCE(d.state_party_ab, ''),
		       COALESCE(a.schools_total,0), COALESCE(a.supermarkets_total,0), COALESCE(a.coles_count,0),
		       COALESCE(a.woolworths_count,0), COALESCE(a.aldi_count,0), COALESCE(a.iga_count,0),
		       COALESCE(a.pubs_bars,0), COALESCE(a.parks_count,0), COALESCE(a.libraries_count,0),
		       COALESCE(a.nearest_supermarket_km,0), COALESCE(a.amenity_density_score,0),
		       COALESCE(a.hospitals_count,0), COALESCE(a.gp_count,0), COALESCE(a.pharmacy_count,0),
		       COALESCE(a.nearest_train_km,0), COALESCE(a.nearest_hospital_km,0),
		       COALESCE(a.dist_to_coast_km,0),
		       COALESCE(a.schools_gov,0), COALESCE(a.schools_catholic,0), COALESCE(a.schools_independent,0),
		       COALESCE(a.schools_primary,0), COALESCE(a.schools_secondary,0), COALESCE(a.nearest_secondary_km,0),
		       COALESCE(c.dominant_nbn_tech,''), COALESCE(c.connectivity_quality_score,0),
		       COALESCE(d.median_weekly_per_income, 0), COALESCE(d.median_weekly_rent, 0),
		       COALESCE(d.median_monthly_mortgage, 0), COALESCE(d.pct_owned_outright, 0),
		       COALESCE(d.pct_owned_mortgage, 0), COALESCE(d.pct_rented, 0),
		       COALESCE(d.dwelling_count, 0), COALESCE(d.census_year, 2021),
		       COALESCE(d.pct_english_only, 0), COALESCE(d.pct_top_religion, 0),
		       COALESCE(d.pct_no_religion, 0),
		       -- state baseline: avg of the LATEST median per priced suburb in the state (covers VIC annual)
		       COALESCE((SELECT avg(latest) FROM (
		                 SELECT DISTINCT ON (hp.region_code) hp.value AS latest
		                 FROM house_prices hp JOIN house_price_regions sr ON sr.region_code = hp.region_code
		                 WHERE sr.state_code = d.state_code AND sr.region_type = 'suburb' AND hp.source_licence <> 'proprietary-tos-restricted'
		                   AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
		                 ORDER BY hp.region_code, hp.period DESC) s), 0),
		       -- national baseline: avg of the latest median across ALL priced suburbs (AUS has no median_price row)
		       COALESCE((SELECT avg(latest) FROM (
		                 SELECT DISTINCT ON (hp.region_code) hp.value AS latest
		                 FROM house_prices hp JOIN house_price_regions sr ON sr.region_code = hp.region_code
		                 WHERE sr.region_type = 'suburb' AND hp.source_licence <> 'proprietary-tos-restricted'
		                   AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
		                 ORDER BY hp.region_code, hp.period DESC) s), 0),
		       COALESCE((SELECT avg(median_weekly_hhd_income) FROM suburb_demographics
		                 WHERE state_code = d.state_code), 0),
		       COALESCE((SELECT avg(median_weekly_hhd_income) FROM suburb_demographics), 0),
		       COALESCE(lg.lga_code24,''), COALESCE(lg.lga_name,''), COALESCE(lg.state_code,''), COALESCE(lg.area_sqkm,0), COALESCE(lg.population,0),
		       COALESCE(lg.fed_fag_aud,0), COALESCE(lg.fed_fag_year,''),
		       COALESCE(lg.avg_rates,0), COALESCE(lg.op_surplus_ratio,0), COALESCE(lg.asset_renewal_ratio,0),
		       COALESCE(lg.fin_source,''), COALESCE(lg.fin_year,''),
		       COALESCE(d.banner_archetype,''), COALESCE(d.banner_blurb,''),
		       COALESCE(d.banner_landmarks, '[]'::jsonb),
		       COALESCE(d.banner_bg_key,''), COALESCE(d.banner_bg_url,''),
		       COALESCE(rp.declared_property_count, 0)
		FROM suburb_demographics d
		LEFT JOIN house_price_regions r ON r.sal_code = d.sal_code AND r.region_type = 'suburb'
		LEFT JOIN suburb_amenities a ON a.sal_code = d.sal_code
		LEFT JOIN suburb_connectivity c ON c.sal_code = d.sal_code
		LEFT JOIN suburb_lga sl ON sl.sal_code = d.sal_code
		LEFT JOIN lga lg ON lg.lga_code24 = sl.lga_code24
		LEFT JOIN mv_register_suburb_property rp ON rp.sal_code = d.sal_code
		LEFT JOIN LATERAL (
			SELECT hp.value, hp.period,
			       (hp.value / NULLIF((
			          SELECT p.value FROM house_prices p
			          WHERE p.region_code = r.region_code AND p.measure = 'median_price'
			            AND p.dwelling_type = 'house' AND p.source_licence <> 'proprietary-tos-restricted' AND p.period <= hp.period - INTERVAL '11 months'
			          ORDER BY p.period DESC LIMIT 1), 0) - 1) * 100 AS yoy_pct
			FROM house_prices hp
			WHERE hp.region_code = r.region_code AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
			  AND hp.source_licence <> 'proprietary-tos-restricted'
			ORDER BY hp.period DESC LIMIT 1
		) h ON true
		WHERE d.sal_code = $1
		LIMIT 1`
	var p SuburbProfileRow
	row := s.db.QueryRow(ctx, q, salCode)
	if err := row.Scan(
		&p.Summary.SALCode, &p.Summary.SALName, &p.Summary.StateCode, &p.Summary.Postcode,
		&p.Summary.LatestMedianPrice, &p.Summary.LatestPeriod, &p.Summary.YoYPct,
		&p.Summary.Population, &p.Summary.MedianAge, &p.Summary.MedianWeeklyHhdIncome, &p.Summary.RegionCode,
		&p.Summary.PctBornOverseas, &p.Summary.TopReligion, &p.Summary.TopLanguage, &p.Summary.PctTopLanguage,
		&p.Summary.FederalDivision, &p.Summary.FederalMember, &p.Summary.FederalParty, &p.Summary.FederalPartyAb, &p.Summary.FederalTppAlp,
		&p.Summary.StateDistrict, &p.Summary.StateMember, &p.Summary.StateParty, &p.Summary.StatePartyAb,
		&p.Summary.SchoolsTotal, &p.Summary.SupermarketsTotal, &p.Summary.ColesCount, &p.Summary.WoolworthsCount, &p.Summary.AldiCount, &p.Summary.IgaCount,
		&p.Summary.PubsBars, &p.Summary.ParksCount, &p.Summary.LibrariesCount, &p.Summary.NearestSupermarketKm, &p.Summary.AmenityDensityScore,
		&p.Summary.HospitalsCount, &p.Summary.GpCount, &p.Summary.PharmacyCount, &p.Summary.NearestTrainKm, &p.Summary.NearestHospitalKm,
		&p.Summary.DistToCoastKm,
		&p.Summary.SchoolsGov, &p.Summary.SchoolsCatholic, &p.Summary.SchoolsIndependent, &p.Summary.SchoolsPrimary, &p.Summary.SchoolsSecondary, &p.Summary.NearestSecondaryKm,
		&p.Summary.DominantNbnTech, &p.Summary.ConnectivityQualityScore,
		&p.MedianWeeklyPerIncome, &p.MedianWeeklyRent, &p.MedianMonthlyMortgage,
		&p.PctOwnedOutright, &p.PctOwnedMortgage, &p.PctRented, &p.DwellingCount, &p.CensusYear,
		&p.PctEnglishOnly, &p.PctTopReligion, &p.PctNoReligion,
		&p.StateMedianPrice, &p.NationalMedianPrice, &p.StateMedianHhdIncome, &p.NationalMedianHhdIncome,
		&p.LgaCode, &p.LgaName, &p.LgaState, &p.LgaAreaSqkm, &p.LgaPopulation,
		&p.LgaFagAud, &p.LgaFagYear,
		&p.LgaAvgRates, &p.LgaOpSurplusRatio, &p.LgaAssetRenewalRatio, &p.LgaFinSource, &p.LgaFinYear,
		&p.BannerArchetype, &p.BannerBlurb, &p.BannerLandmarks, &p.BannerBgKey, &p.BannerBgUrl,
		&p.Summary.PoliticianPropertyCount,
	); err != nil {
		return nil, err
	}
	if sim, err := s.similarSuburbs(ctx, salCode, 6); err == nil {
		p.Similar = sim
	}
	if crime, err := s.suburbCrime(ctx, salCode); err == nil {
		p.Crime = crime
	}
	return &p, nil
}

const suburbCrimeQuery = `
		SELECT crime_type, fy_ending, COALESCE(rate_per_100k, 0),
		       COALESCE(pct_rank, 0), source_jurisdiction, source, source_licence
		FROM mv_suburb_crime_latest
		WHERE sal_code = $1 AND NOT small_pop AND NOT unreliable
		ORDER BY crime_type`

// suburbCrime returns the latest pooled, gated crime stats for one suburb.
// Empty slice means no reliable data (uncovered state or gated small-pop row).
func (s *postgresStore) suburbCrime(ctx context.Context, salCode string) ([]SuburbCrimeStatRow, error) {
	rows, err := s.db.Query(ctx, suburbCrimeQuery, salCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SuburbCrimeStatRow
	for rows.Next() {
		var stat SuburbCrimeStatRow
		if err := rows.Scan(
			&stat.CrimeType, &stat.FYEnding, &stat.RatePer100k, &stat.PctRank,
			&stat.Jurisdiction, &stat.Source, &stat.Licence,
		); err != nil {
			return nil, err
		}
		out = append(out, stat)
	}
	return out, rows.Err()
}

// similarSuburbs finds the k nearest suburbs nationally in a z-scored feature
// space (age, income, born-overseas, amenity density, log-population, and
// distance-to-coast capped at 100km so coastal suburbs cluster together) — the
// knowledge-graph "similar_to" relation, computed at query time.
func (s *postgresStore) similarSuburbs(ctx context.Context, salCode string, limit int32) ([]SimilarSuburbRow, error) {
	const q = `
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
		-- chosen: k probes instead of one per ~15k candidate suburbs.
		SELECT ranked.sal_code, ranked.sal_name, ranked.state_code, COALESCE(h.value,0),
		       COALESCE(r.region_code,''), ranked.dist
		FROM ranked
		LEFT JOIN house_price_regions r ON r.sal_code = ranked.sal_code AND r.region_type = 'suburb'
		LEFT JOIN LATERAL (
			SELECT hp.value FROM house_prices hp
			WHERE hp.region_code = r.region_code AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
			  AND hp.source_licence <> 'proprietary-tos-restricted'
			ORDER BY hp.period DESC LIMIT 1
		) h ON true
		ORDER BY ranked.dist ASC NULLS LAST`
	rows, err := s.db.Query(ctx, q, salCode, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SimilarSuburbRow
	for rows.Next() {
		var r SimilarSuburbRow
		if err := rows.Scan(&r.SALCode, &r.SALName, &r.StateCode, &r.LatestMedianPrice, &r.RegionCode, &r.Distance); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// HousingRegionRow is a selectable house-price region (for the suburb explorer),
// with its latest median price for at-a-glance display + the choropleth.
type HousingRegionRow struct {
	RegionCode   string
	RegionName   string
	RegionType   string
	StateCode    string
	Postcode     string
	LatestValue  float64
	LatestPeriod *time.Time
}

func (s *postgresStore) GetHousingRegions(regionType, stateCode, query string, limit int32) ([]*HousingRegionRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 || limit > 5000 {
		limit = 2000
	}

	// Gate out internal, ToS-restricted REA/Domain/brandbrain rows
	// (source_licence = 'proprietary-tos-restricted'): the latest-median lateral
	// only considers public-licence observations, and the EXISTS guard drops
	// regions whose entire footprint is proprietary so they never surface here.
	const q = `
		SELECT r.region_code, COALESCE(r.region_name, ''), COALESCE(r.region_type, ''),
		       COALESCE(r.state_code, ''), COALESCE(r.postcode, ''),
		       COALESCE(lp.value, 0), lp.period
		FROM house_price_regions r
		LEFT JOIN LATERAL (
			SELECT value, period FROM house_prices hp
			WHERE hp.region_code = r.region_code AND hp.measure = 'median_price'
			  AND hp.source_licence <> 'proprietary-tos-restricted'
			ORDER BY hp.period DESC
			LIMIT 1
		) lp ON true
		WHERE ($1 = '' OR r.region_type = $1)
		  AND ($2 = '' OR r.state_code = $2)
		  AND ($3 = '' OR r.region_name ILIKE '%' || $3 || '%')
		  AND (
		    NOT EXISTS (SELECT 1 FROM house_prices hp WHERE hp.region_code = r.region_code)
		    OR EXISTS (
		      SELECT 1 FROM house_prices hp
		      WHERE hp.region_code = r.region_code
		        AND hp.source_licence <> 'proprietary-tos-restricted'
		    )
		  )
		ORDER BY r.region_name
		LIMIT $4`

	rows, err := s.db.Query(ctx, q, regionType, stateCode, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*HousingRegionRow
	for rows.Next() {
		var r HousingRegionRow
		if err := rows.Scan(&r.RegionCode, &r.RegionName, &r.RegionType, &r.StateCode, &r.Postcode,
			&r.LatestValue, &r.LatestPeriod); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// SuburbPriceDropRow is one suburb's aggregate price-drop signal (from
// mv_suburb_price_drops), joined to its region name/state for display.
type SuburbPriceDropRow struct {
	RegionCode          string
	SALCode             string
	SALName             string
	StateCode           string
	Postcode            string
	DroppedListingCount int32
	AvgDropPct          float64
	MedianDropPct       float64
	MaxDropPct          float64
	MaxDropAbs          float64
	TotalActiveListings int32
	DroppedShare        float64
	ForSaleCount        int32
	AvgAsking           float64
	MedianAsking        float64
	SoldCount           int32
	AvgSold             float64
	MedianSold          float64
	DroppedValue        float64
}

// ListSuburbPriceDrops returns the per-suburb listing board: asking/sold price
// aggregates (mv_suburb_listing_stats) for every suburb with crawled listings,
// LEFT-JOINed to the price-drop signal (mv_suburb_price_drops). Reads ONLY the
// derived aggregates — never the raw, ToS-restricted listing rows.
// sort ∈ {count,avg,max,asking,sold}; default count (most price cuts).
func (s *postgresStore) ListSuburbPriceDrops(stateCode, sort string, limit int32) ([]*SuburbPriceDropRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 || limit > 500 {
		limit = 50
	}
	// Whitelist the sort column (never interpolate user input into SQL).
	orderBy := "COALESCE(d.dropped_listing_count, 0)"
	switch sort {
	case "avg":
		orderBy = "COALESCE(d.avg_drop_pct, 0)"
	case "max":
		orderBy = "COALESCE(d.max_drop_pct, 0)"
	case "asking":
		orderBy = "st.avg_asking"
	case "sold":
		orderBy = "st.avg_sold"
	}

	// dropped_value only exists once migration 000083 has rebuilt
	// mv_suburb_price_drops. Selecting it via a scalar subquery over the MV's
	// row (to_jsonb ->> column) keeps this ONE query that works on both the old
	// and new MV shape, so a code deploy ahead of the manual prod DDL can't
	// break the suburb board.
	query := `
		SELECT st.region_code, COALESCE(r.sal_code, ''),
		       COALESCE(NULLIF(sd.sal_name, ''), r.region_name, '') AS sal_name,
		       COALESCE(r.state_code, ''), COALESCE(r.postcode, ''),
		       COALESCE(d.dropped_listing_count, 0), COALESCE(d.avg_drop_pct, 0),
		       COALESCE(d.median_drop_pct, 0), COALESCE(d.max_drop_pct, 0),
		       COALESCE(d.max_drop_abs, 0), COALESCE(d.total_active_listings, st.for_sale_count),
		       COALESCE(d.dropped_share, 0),
		       st.for_sale_count, COALESCE(st.avg_asking, 0), COALESCE(st.median_asking, 0),
		       st.sold_count, COALESCE(st.avg_sold, 0), COALESCE(st.median_sold, 0),
		       COALESCE((to_jsonb(d) ->> 'dropped_value')::float8, 0)
		FROM mv_suburb_listing_stats st
		JOIN house_price_regions r ON r.region_code = st.region_code
		LEFT JOIN suburb_demographics sd ON sd.sal_code = r.sal_code
		LEFT JOIN mv_suburb_price_drops d ON d.region_code = st.region_code
		WHERE ($1 = '' OR r.state_code = $1)
		ORDER BY ` + orderBy + ` DESC NULLS LAST
		LIMIT $2`

	rows, err := s.db.Query(ctx, query, stateCode, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*SuburbPriceDropRow
	for rows.Next() {
		var d SuburbPriceDropRow
		if err := rows.Scan(&d.RegionCode, &d.SALCode, &d.SALName, &d.StateCode, &d.Postcode,
			&d.DroppedListingCount, &d.AvgDropPct, &d.MedianDropPct, &d.MaxDropPct,
			&d.MaxDropAbs, &d.TotalActiveListings, &d.DroppedShare,
			&d.ForSaleCount, &d.AvgAsking, &d.MedianAsking, &d.SoldCount, &d.AvgSold, &d.MedianSold,
			&d.DroppedValue); err != nil {
			return nil, err
		}
		out = append(out, &d)
	}
	return out, rows.Err()
}

// SuburbDropListingRow is one recently-reduced listing for the per-suburb
// drill-down (deep-links out to the live portal page).
type SuburbDropListingRow struct {
	Source         string
	ListingURL     string
	DisplayAddress string
	PropertyType   string
	Bedrooms       int32
	Bathrooms      int32
	CarSpaces      int32
	PrevPrice      float64
	Price          float64
	DropPct        float64
	DropAbs        float64
	ObservedAt     time.Time
	AddressKey     string
	AgencyName     string
	AgentNames     []string
}

// ListSuburbDropListings returns the largest recent price-drop per active,
// addressable home in a suburb, deep-linking to the selected portal row. It reads the raw
// (proprietary-tos-restricted) listing rows — this is the flag-gated drill-down;
// the handler enforces the feature flag. Stale listings (not seen in ~3 weeks) and
// URL-less rows are filtered so we never surface a dead deep-link.
func (s *postgresStore) ListSuburbDropListings(salCode, regionCode string, windowDays, limit int32) ([]*SuburbDropListingRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if windowDays <= 0 || windowDays > 365 {
		windowDays = 30
	}
	if limit <= 0 || limit > 200 {
		limit = 30
	}

	const query = `
		SELECT t.source, t.listing_url, t.display_address, t.property_type,
		       t.bedrooms, t.bathrooms, t.car_spaces,
		       t.prev_price, t.price, t.drop_pct, t.drop_abs, t.observed_at, t.address_key,
		       t.agency_name, t.agent_names
		FROM (
			SELECT DISTINCT ON (pl.address_key)
			       pl.source, pl.listing_url,
			       COALESCE(pl.display_address, '') AS display_address,
			       COALESCE(pl.property_type, '')   AS property_type,
			       COALESCE(pl.bedrooms, 0)         AS bedrooms,
			       COALESCE(pl.bathrooms, 0)        AS bathrooms,
			       COALESCE(pl.car_spaces, 0)       AS car_spaces,
			       COALESCE(e.prev_price, 0)        AS prev_price,
			       COALESCE(e.price, 0)             AS price,
			       COALESCE(e.drop_pct, 0)          AS drop_pct,
			       COALESCE(e.drop_abs, 0)          AS drop_abs,
			       e.observed_at, e.listing_pk, COALESCE(pl.address_key, '') AS address_key,
			       COALESCE(pl.agency_name, '') AS agency_name,
			       COALESCE(pl.agent_names, '{}') AS agent_names
			FROM property_price_events e
			JOIN property_listings pl ON pl.id = e.listing_pk
			JOIN house_price_regions r ON r.region_code = e.region_code
			WHERE e.event_type = 'price_drop'
			  AND e.observed_at >= now() - make_interval(days => $3)
			  AND ($1 = '' OR r.sal_code = $1)
			  AND ($2 = '' OR e.region_code = $2)
			  AND pl.is_active
			  AND pl.last_seen_at >= now() - interval '21 days'
			  AND pl.listing_url <> ''
			  AND NULLIF(pl.address_key, '') IS NOT NULL
			  -- Same typo-correction sanity cap as the aggregate MVs (000083) so
			  -- the drill-down can't rank a correction above real drops.
			  AND e.drop_pct <= 0.40
			ORDER BY pl.address_key, e.drop_abs DESC, e.observed_at DESC
		) t
		ORDER BY t.drop_pct DESC
		LIMIT $4`

	rows, err := s.db.Query(ctx, query, salCode, regionCode, windowDays, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*SuburbDropListingRow
	for rows.Next() {
		var l SuburbDropListingRow
		if err := rows.Scan(&l.Source, &l.ListingURL, &l.DisplayAddress, &l.PropertyType,
			&l.Bedrooms, &l.Bathrooms, &l.CarSpaces, &l.PrevPrice, &l.Price,
			&l.DropPct, &l.DropAbs, &l.ObservedAt, &l.AddressKey,
			&l.AgencyName, &l.AgentNames); err != nil {
			return nil, err
		}
		out = append(out, &l)
	}
	return out, rows.Err()
}

// PropertyListingSnapshotRow is the current (most-recent) listing at an
// address — the most-recent ACTIVE one, or the most-recent overall if none
// are active.
type PropertyListingSnapshotRow struct {
	Source         string
	ListingID      string
	ListingURL     string
	Price          float64
	PriceDisplay   string
	PriceKind      string
	ListingStatus  string
	IsActive       bool
	Bedrooms       int32
	Bathrooms      int32
	CarSpaces      int32
	LandSizeSqm    float64
	PropertyType   string
	DisplayAddress string
	Suburb         string
	StateCode      string
	Postcode       string
	FirstSeenAt    time.Time
	LastSeenAt     time.Time
	AgencyName     string
	AgentNames     []string
}

// PropertyPriceEventRow is one event in an address's merged price timeline
// (spans every listing/relist detected at that address).
type PropertyPriceEventRow struct {
	ObservedAt    time.Time
	EventType     string
	Source        string
	ListingID     string
	Price         float64
	PrevPrice     float64
	DropAbs       float64
	DropPct       float64
	ListingStatus string
	PrevStatus    string
}

// PropertyHistoryResult is the full per-address price timeline: the current
// listing snapshot plus the merged event history across every listing/relist
// seen at that physical address.
type PropertyHistoryResult struct {
	AddressKey     string
	DisplayAddress string
	Suburb         string
	StateCode      string
	Postcode       string
	Current        *PropertyListingSnapshotRow
	Events         []*PropertyPriceEventRow
	NumListings    int32
	FirstPrice     float64
	CurrentPrice   float64
	// DistinctDwellings counts distinct bed/bath/property_type profiles under
	// this address_key. >1 flags a likely multi-unit over-collapse (portal
	// omitted the unit number), so the UI can warn the timeline may blend units.
	DistinctDwellings int32
}

// PropertyValuationSaleRow is one entry of property_valuations.sales_history.
// JSON tags mirror the collector's saleRecord (crawl_property_extract.go) exactly.
type PropertyValuationSaleRow struct {
	Date   string   `json:"date"`
	Price  *float64 `json:"price"` // nil = undisclosed
	Agency string   `json:"agency"`
	Type   string   `json:"type"`
}

// PropertyValuationRow is the servable slice of a property_valuations row.
// Raw/content_hash/lat/lng deliberately never leave the store layer.
type PropertyValuationRow struct {
	Source                         string
	ProfileURL                     string
	FetchedAt                      time.Time
	EstimateLow                    float64
	EstimateMid                    float64
	EstimateHigh                   float64
	EstimateConfidence             string
	ValuationGranularity           string // 'exact' | 'building'
	RentEstimateMid                float64
	Bedrooms, Bathrooms, CarSpaces int32
	LandSizeSqm, BuildingSizeSqm   float64
	YearBuilt                      int32
	PropertyType                   string
	SalesHistory                   []PropertyValuationSaleRow
}

// GetPropertyHistory returns the full asking-price timeline for a single
// physical address (stable address_key), merging every listing/relist ever
// seen at that address. It reads the raw (proprietary-tos-restricted) listing
// rows — this is the flag-gated drill-down; the handler enforces the feature
// flag (same posture as ListSuburbDropListings). Returns a zero-value result
// (not an error) for an unknown/empty address_key.
func (s *postgresStore) GetPropertyHistory(addressKey string) (*PropertyHistoryResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if addressKey == "" {
		return &PropertyHistoryResult{}, nil
	}

	const currentQuery = `
		SELECT source, listing_id, listing_url, COALESCE(price, 0), COALESCE(price_display, ''),
		       price_kind, listing_status, is_active,
		       COALESCE(bedrooms, 0), COALESCE(bathrooms, 0), COALESCE(car_spaces, 0),
		       COALESCE(land_size_sqm, 0), COALESCE(property_type, ''),
		       COALESCE(display_address, ''), COALESCE(suburb, ''), COALESCE(state_code, ''),
		       COALESCE(postcode, ''), first_seen_at, last_seen_at,
		       COALESCE(agency_name, ''), COALESCE(agent_names, '{}')
		FROM property_listings
		WHERE address_key = $1
		ORDER BY is_active DESC, last_seen_at DESC
		LIMIT 1`

	var cur PropertyListingSnapshotRow
	err := s.db.QueryRow(ctx, currentQuery, addressKey).Scan(
		&cur.Source, &cur.ListingID, &cur.ListingURL, &cur.Price, &cur.PriceDisplay,
		&cur.PriceKind, &cur.ListingStatus, &cur.IsActive,
		&cur.Bedrooms, &cur.Bathrooms, &cur.CarSpaces, &cur.LandSizeSqm, &cur.PropertyType,
		&cur.DisplayAddress, &cur.Suburb, &cur.StateCode, &cur.Postcode,
		&cur.FirstSeenAt, &cur.LastSeenAt, &cur.AgencyName, &cur.AgentNames)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &PropertyHistoryResult{}, nil
		}
		return nil, err
	}

	const eventsQuery = `
		SELECT observed_at, event_type, source, listing_id,
		       COALESCE(price, 0), COALESCE(prev_price, 0), COALESCE(drop_abs, 0), COALESCE(drop_pct, 0),
		       COALESCE(listing_status, ''), COALESCE(prev_status, '')
		FROM property_price_events
		WHERE address_key = $1
		ORDER BY observed_at ASC, id ASC`

	rows, err := s.db.Query(ctx, eventsQuery, addressKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []*PropertyPriceEventRow
	var firstPrice float64
	for rows.Next() {
		var e PropertyPriceEventRow
		if err := rows.Scan(&e.ObservedAt, &e.EventType, &e.Source, &e.ListingID,
			&e.Price, &e.PrevPrice, &e.DropAbs, &e.DropPct, &e.ListingStatus, &e.PrevStatus); err != nil {
			return nil, err
		}
		if firstPrice == 0 && e.Price > 0 {
			firstPrice = e.Price
		}
		events = append(events, &e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// num_listings = distinct portal adverts at this address. distinct_dwellings =
	// distinct KNOWN bedroom counts (a multi-unit over-collapse signal). We count
	// bedrooms only — not raw bed/bath/property_type tuples — and exclude
	// NULL/0 (unextracted) counts, so cross-portal label noise (REA 'House' vs
	// Domain '' / a sweep that missed property_type or bathrooms) does NOT falsely
	// read as separate dwellings. A genuine multi-unit over-collapse (studio vs
	// penthouse) still differs in bedroom count and trips the >1 warning.
	const countQuery = `
		SELECT COUNT(DISTINCT source || ':' || listing_id),
		       COUNT(DISTINCT bedrooms) FILTER (WHERE bedrooms IS NOT NULL AND bedrooms > 0)
		FROM property_listings WHERE address_key = $1`
	var numListings, distinctDwellings int32
	if err := s.db.QueryRow(ctx, countQuery, addressKey).Scan(&numListings, &distinctDwellings); err != nil {
		return nil, err
	}

	return &PropertyHistoryResult{
		AddressKey:        addressKey,
		DisplayAddress:    cur.DisplayAddress,
		Suburb:            cur.Suburb,
		StateCode:         cur.StateCode,
		Postcode:          cur.Postcode,
		Current:           &cur,
		Events:            events,
		NumListings:       numListings,
		FirstPrice:        firstPrice,
		CurrentPrice:      cur.Price,
		DistinctDwellings: distinctDwellings,
	}, nil
}

// GetPropertyValuation returns the AVM snapshot for one address, or nil when
// no successful valuation exists. Only fetch_status='ok' rows are servable;
// blocked/notfound/error rows (and their NULL granularity) never surface.
func (s *postgresStore) GetPropertyValuation(addressKey string) (*PropertyValuationRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	const query = `
		SELECT COALESCE(source, ''), COALESCE(profile_url, ''), fetched_at,
		       COALESCE(estimate_low, 0), COALESCE(estimate_mid, 0), COALESCE(estimate_high, 0),
		       COALESCE(estimate_confidence, ''), COALESCE(valuation_granularity, ''),
		       COALESCE(rent_estimate_mid, 0),
		       COALESCE(bedrooms, 0), COALESCE(bathrooms, 0), COALESCE(car_spaces, 0),
		       COALESCE(land_size_sqm, 0), COALESCE(building_size_sqm, 0),
		       COALESCE(year_built, 0), COALESCE(property_type, ''),
		       COALESCE(sales_history, '[]'::jsonb)
		FROM property_valuations
		WHERE address_key = $1 AND fetch_status = 'ok'`

	var row PropertyValuationRow
	var salesHistory []byte
	err := s.db.QueryRow(ctx, query, addressKey).Scan(
		&row.Source, &row.ProfileURL, &row.FetchedAt,
		&row.EstimateLow, &row.EstimateMid, &row.EstimateHigh,
		&row.EstimateConfidence, &row.ValuationGranularity,
		&row.RentEstimateMid,
		&row.Bedrooms, &row.Bathrooms, &row.CarSpaces,
		&row.LandSizeSqm, &row.BuildingSizeSqm,
		&row.YearBuilt, &row.PropertyType,
		&salesHistory,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	if err := json.Unmarshal(salesHistory, &row.SalesHistory); err != nil {
		log.Warnf("GetPropertyValuation(%s): failed to decode sales_history: %v", addressKey, err)
		row.SalesHistory = []PropertyValuationSaleRow{}
	}

	return &row, nil
}

// AddressPriceDropRow is one physical address (deduped by address_key) whose
// for-sale asking price fell over the window, for the drops-by-address board.
type AddressPriceDropRow struct {
	AddressKey       string
	DisplayAddress   string
	Suburb           string
	StateCode        string
	Postcode         string
	FirstPrice       float64
	CurrentPrice     float64
	DropAbs          float64
	DropPct          float64
	NumListings      int32
	LatestSource     string
	LatestListingURL string
	LastObservedAt   time.Time
	PropertyType     string
	Bedrooms         int32
	Bathrooms        int32
	AgencyName       string
	AgentNames       []string
}

// ListAddressPriceDrops ranks individual physical addresses (deduped by the
// stable address_key) by their asking-price reduction over the last windowDays:
// from the earliest priced observation IN the window (first_price) to the
// current active listing's ask (current_price). It reads the raw
// (proprietary-tos-restricted) listing rows — this is the flag-gated board; the
// handler enforces the feature flag (same posture as ListSuburbDropListings).
// Rows with an empty address_key, no priced observation, a non-positive current
// ask, a dead deep-link, or a stale/inactive current listing are excluded; only
// real drops (>= 3%) are returned, biggest percentage drop first.
func (s *postgresStore) ListAddressPriceDrops(stateCode, sort string, windowDays, limit int32) ([]*AddressPriceDropRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if windowDays <= 0 || windowDays > 365 {
		windowDays = 90
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	// Whitelist the sort → a fixed ORDER BY clause (never interpolate user input).
	// All three reference the output aliases of the final SELECT.
	orderBy := "ORDER BY drop_pct DESC, drop_abs DESC" // default: biggest % cut
	switch sort {
	case "abs":
		orderBy = "ORDER BY drop_abs DESC, drop_pct DESC" // biggest $ cut
	case "recent":
		orderBy = "ORDER BY last_observed_at DESC, drop_pct DESC" // most recently seen
	}

	// cur  = the current (most-recent active, priced, live-URL) listing per address.
	// firstp = earliest positive price observed within the window per address.
	// nlist  = distinct portal adverts per address.
	const baseQuery = `
		WITH cur AS (
			SELECT DISTINCT ON (pl.address_key)
			       pl.address_key,
			       COALESCE(pl.display_address, '') AS display_address,
			       COALESCE(pl.suburb, '')          AS suburb,
			       COALESCE(pl.state_code, '')      AS state_code,
			       COALESCE(pl.postcode, '')        AS postcode,
			       COALESCE(pl.price, 0)            AS current_price,
			       pl.source                        AS latest_source,
			       COALESCE(pl.listing_url, '')     AS latest_listing_url,
			       pl.last_seen_at                  AS last_observed_at,
			       COALESCE(pl.property_type, '')   AS property_type,
			       COALESCE(pl.bedrooms, 0)         AS bedrooms,
			       COALESCE(pl.bathrooms, 0)        AS bathrooms,
			       COALESCE(pl.agency_name, '')     AS agency_name,
			       COALESCE(pl.agent_names, '{}')   AS agent_names
			FROM property_listings pl
			WHERE pl.address_key <> ''
			  AND pl.is_active
			  AND pl.last_seen_at >= now() - interval '21 days'
			  AND pl.listing_url <> ''
			  AND COALESCE(pl.price, 0) > 0
			  AND ($1 = '' OR UPPER(pl.state_code) = UPPER($1))
			ORDER BY pl.address_key, pl.is_active DESC, pl.last_seen_at DESC, pl.price DESC, pl.id DESC
		),
		firstp AS (
			-- first_price is scoped to the CURRENT dwelling: only events whose
			-- listing has the same bedroom count as cur (bedrooms is reliably
			-- extracted on both portals, unlike property_type). This stops a
			-- multi-unit over-collapse (one address_key, several units the portal
			-- listed without a unit number) from feeding another unit's price in
			-- as the "first" ask — which would otherwise fabricate a huge cross-
			-- unit drop and rank it #1. When cur's bedroom count is unknown (0),
			-- fall back to address-wide (best effort). Relists of the SAME
			-- dwelling (new listing_id, same beds) are still unified.
			SELECT c.address_key,
			       (ARRAY_AGG(e.price ORDER BY e.observed_at ASC, e.id ASC)
			          FILTER (WHERE e.price > 0))[1] AS first_price
			FROM cur c
			JOIN property_price_events e ON e.address_key = c.address_key
			JOIN property_listings epl ON epl.id = e.listing_pk
			WHERE e.observed_at >= now() - make_interval(days => $2)
			  AND (c.bedrooms = 0 OR COALESCE(epl.bedrooms, 0) = c.bedrooms)
			GROUP BY c.address_key
		),
		nlist AS (
			SELECT address_key, COUNT(DISTINCT source || ':' || listing_id) AS num_listings
			FROM property_listings
			WHERE address_key <> ''
			GROUP BY address_key
		)
		SELECT c.address_key, c.display_address, c.suburb, c.state_code, c.postcode,
		       f.first_price, c.current_price,
		       (f.first_price - c.current_price)                  AS drop_abs,
		       (f.first_price - c.current_price) / f.first_price  AS drop_pct,
		       COALESCE(n.num_listings, 1)                        AS num_listings,
		       c.latest_source, c.latest_listing_url, c.last_observed_at,
		       c.property_type, c.bedrooms, c.bathrooms, c.agency_name, c.agent_names
		FROM cur c
		JOIN firstp f ON f.address_key = c.address_key
		LEFT JOIN nlist n ON n.address_key = c.address_key
		WHERE f.first_price > 0
		  AND f.first_price > c.current_price
		  AND (f.first_price - c.current_price) / f.first_price >= 0.03
		  -- Sanity cap in the spirit of the aggregate MVs (000083): a >40%
		  -- move is a listing typo correction (e.g. an extra-zero $7.5M ->
		  -- $750k fix), not a vendor discount. NOTE this board's cap is on the
		  -- CUMULATIVE window reduction (first_price -> current), while the MVs
		  -- cap each individual drop event — an address that really fell >40%
		  -- through several capped cuts is excluded here but still counted in
		  -- the aggregates.
		  AND (f.first_price - c.current_price) / f.first_price <= 0.40
		`

	query := baseQuery + orderBy + "\n\t\tLIMIT $3"
	rows, err := s.db.Query(ctx, query, stateCode, windowDays, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*AddressPriceDropRow
	for rows.Next() {
		var r AddressPriceDropRow
		if err := rows.Scan(&r.AddressKey, &r.DisplayAddress, &r.Suburb, &r.StateCode, &r.Postcode,
			&r.FirstPrice, &r.CurrentPrice, &r.DropAbs, &r.DropPct, &r.NumListings,
			&r.LatestSource, &r.LatestListingURL, &r.LastObservedAt,
			&r.PropertyType, &r.Bedrooms, &r.Bathrooms, &r.AgencyName, &r.AgentNames); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// StatePriceDropSummaryRow is one state's (or the 'AU' national) rollup of
// recent asking-price reductions plus asking/sold aggregates, from
// mv_state_price_drops (derived aggregates only).
type StatePriceDropSummaryRow struct {
	StateCode           string
	DroppedCount        int32
	AvgDropPct          float64
	MedianDropPct       float64
	MaxDropPct          float64
	DroppedValue        float64
	TotalActiveListings int32
	DroppedShare        float64
	ForSaleCount        int32
	ForSalePriced       int32
	AvgAsking           float64
	MedianAsking        float64
	SoldCount           int32
	AvgSold             float64
	MedianSold          float64
	SuburbsTracked      int32
}

// GetPriceDropsOverview returns the per-state price-drop + listing-price
// rollup, including the 'AU' national row. Reads ONLY the derived aggregate
// (mv_state_price_drops) — never the raw, ToS-restricted listing rows.
func (s *postgresStore) GetPriceDropsOverview() ([]*StatePriceDropSummaryRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	const query = `
		SELECT state_code, dropped_count, COALESCE(avg_drop_pct, 0),
		       COALESCE(median_drop_pct, 0), COALESCE(max_drop_pct, 0),
		       COALESCE(dropped_value, 0), total_active_listings,
		       COALESCE(dropped_share, 0), for_sale_count, for_sale_priced,
		       COALESCE(avg_asking, 0), COALESCE(median_asking, 0),
		       sold_count, COALESCE(avg_sold, 0), COALESCE(median_sold, 0),
		       suburbs_tracked
		FROM mv_state_price_drops
		ORDER BY (state_code = 'AU') DESC, dropped_count DESC, state_code ASC`

	rows, err := s.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*StatePriceDropSummaryRow
	for rows.Next() {
		var r StatePriceDropSummaryRow
		if err := rows.Scan(&r.StateCode, &r.DroppedCount, &r.AvgDropPct, &r.MedianDropPct,
			&r.MaxDropPct, &r.DroppedValue, &r.TotalActiveListings, &r.DroppedShare,
			&r.ForSaleCount, &r.ForSalePriced, &r.AvgAsking, &r.MedianAsking,
			&r.SoldCount, &r.AvgSold, &r.MedianSold, &r.SuburbsTracked); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// AgencyPriceStatsRow is one agency's aggregate footprint from mv_agency_stats
// (derived aggregates only; >=3 active listings floor baked into the MV).
// Agency identity is per-portal — the same real-world agency may appear once
// per portal.
type AgencyPriceStatsRow struct {
	Source         string
	AgencyID       string
	AgencyName     string
	StateCode      string
	ActiveListings int32
	PricedListings int32
	AvgAsking      float64
	MedianAsking   float64
	SuburbsCovered int32
	DroppedCount   int32
	AvgDropPct     float64
	TotalDropValue float64
	AgentNames     []string
}

// ListAgencyPriceStats ranks agencies by recent asking-price cuts (or listing
// footprint) from mv_agency_stats. Reads ONLY the derived aggregate — never
// the raw, ToS-restricted listing rows. AgentNames remains an empty compatibility
// field; personal names are available only from flag-gated per-listing reads.
// sort ∈ {drops,listings,avg_cut,value}; default drops.
func (s *postgresStore) ListAgencyPriceStats(stateCode, sort string, limit int32) ([]*AgencyPriceStatsRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 || limit > 100 {
		limit = 20
	}
	// Whitelist the sort column (never interpolate user input into SQL).
	orderBy := "dropped_count DESC, total_drop_value DESC, active_listings DESC"
	switch sort {
	case "listings":
		orderBy = "active_listings DESC, dropped_count DESC"
	case "avg_cut":
		orderBy = "avg_drop_pct DESC NULLS LAST, dropped_count DESC"
	case "value":
		orderBy = "total_drop_value DESC, dropped_count DESC"
	}

	query := `
		SELECT source, agency_id, agency_name, state_code,
		       active_listings, priced_listings,
		       COALESCE(avg_asking, 0), COALESCE(median_asking, 0),
		       suburbs_covered, COALESCE(dropped_count, 0), COALESCE(avg_drop_pct, 0),
		       COALESCE(total_drop_value, 0), '{}'::text[] AS agent_names
		FROM mv_agency_stats
		WHERE ($1 = '' OR state_code = UPPER($1))
		ORDER BY ` + orderBy + `
		LIMIT $2`

	rows, err := s.db.Query(ctx, query, stateCode, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*AgencyPriceStatsRow
	for rows.Next() {
		var r AgencyPriceStatsRow
		if err := rows.Scan(&r.Source, &r.AgencyID, &r.AgencyName, &r.StateCode,
			&r.ActiveListings, &r.PricedListings, &r.AvgAsking, &r.MedianAsking,
			&r.SuburbsCovered, &r.DroppedCount, &r.AvgDropPct, &r.TotalDropValue,
			&r.AgentNames); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}
