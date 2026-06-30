package shorts

import (
	"context"
	"time"
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
		WHERE ($1 = '' OR r.region_type = $1)
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
		       COALESCE(a.nearest_supermarket_km,0), COALESCE(a.amenity_density_score,0)
		FROM suburb_demographics d
		LEFT JOIN house_price_regions r ON r.sal_code = d.sal_code AND r.region_type = 'suburb'
		LEFT JOIN suburb_amenities a ON a.sal_code = d.sal_code
		-- Latest median from house_prices directly (NOT the quarterly-only MV) so annual
		-- Valuer-General states (VIC) light up too; YoY computed vs the obs ~1yr prior.
		LEFT JOIN LATERAL (
			SELECT hp.value, hp.period,
			       (hp.value / NULLIF((
			          SELECT p.value FROM house_prices p
			          WHERE p.region_code = r.region_code AND p.measure = 'median_price'
			            AND p.dwelling_type = 'house' AND p.period <= hp.period - INTERVAL '11 months'
			          ORDER BY p.period DESC LIMIT 1), 0) - 1) * 100 AS yoy_pct
			FROM house_prices hp
			WHERE hp.region_code = r.region_code AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
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
		if err := rows.Scan(&r.SALCode, &r.SALName, &r.StateCode, &r.Postcode,
			&r.LatestMedianPrice, &r.LatestPeriod, &r.YoYPct,
			&r.Population, &r.MedianAge, &r.MedianWeeklyHhdIncome, &r.RegionCode,
			&r.PctBornOverseas, &r.TopReligion, &r.TopLanguage, &r.PctTopLanguage,
			&r.FederalDivision, &r.FederalMember, &r.FederalParty, &r.FederalPartyAb, &r.FederalTppAlp,
			&r.StateDistrict, &r.StateMember, &r.StateParty, &r.StatePartyAb,
			&r.SchoolsTotal, &r.SupermarketsTotal, &r.ColesCount, &r.WoolworthsCount, &r.AldiCount, &r.IgaCount,
			&r.PubsBars, &r.ParksCount, &r.LibrariesCount, &r.NearestSupermarketKm, &r.AmenityDensityScore); err != nil {
			return nil, err
		}
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
		                 WHERE sr.state_code = d.state_code AND sr.region_type = 'suburb'
		                   AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
		                 ORDER BY hp.region_code, hp.period DESC) s), 0),
		       -- national baseline: avg of the latest median across ALL priced suburbs (AUS has no median_price row)
		       COALESCE((SELECT avg(latest) FROM (
		                 SELECT DISTINCT ON (hp.region_code) hp.value AS latest
		                 FROM house_prices hp JOIN house_price_regions sr ON sr.region_code = hp.region_code
		                 WHERE sr.region_type = 'suburb'
		                   AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
		                 ORDER BY hp.region_code, hp.period DESC) s), 0),
		       COALESCE((SELECT avg(median_weekly_hhd_income) FROM suburb_demographics
		                 WHERE state_code = d.state_code), 0),
		       COALESCE((SELECT avg(median_weekly_hhd_income) FROM suburb_demographics), 0)
		FROM suburb_demographics d
		LEFT JOIN house_price_regions r ON r.sal_code = d.sal_code AND r.region_type = 'suburb'
		LEFT JOIN LATERAL (
			SELECT hp.value, hp.period,
			       (hp.value / NULLIF((
			          SELECT p.value FROM house_prices p
			          WHERE p.region_code = r.region_code AND p.measure = 'median_price'
			            AND p.dwelling_type = 'house' AND p.period <= hp.period - INTERVAL '11 months'
			          ORDER BY p.period DESC LIMIT 1), 0) - 1) * 100 AS yoy_pct
			FROM house_prices hp
			WHERE hp.region_code = r.region_code AND hp.measure = 'median_price' AND hp.dwelling_type = 'house'
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
		&p.MedianWeeklyPerIncome, &p.MedianWeeklyRent, &p.MedianMonthlyMortgage,
		&p.PctOwnedOutright, &p.PctOwnedMortgage, &p.PctRented, &p.DwellingCount, &p.CensusYear,
		&p.PctEnglishOnly, &p.PctTopReligion, &p.PctNoReligion,
		&p.StateMedianPrice, &p.NationalMedianPrice, &p.StateMedianHhdIncome, &p.NationalMedianHhdIncome,
	); err != nil {
		return nil, err
	}
	return &p, nil
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
