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
	Population             int32
	MedianAge             float64
	MedianWeeklyHhdIncome float64
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
		       COALESCE(d.median_weekly_hhd_income, 0)
		FROM suburb_demographics d
		LEFT JOIN house_price_regions r ON r.sal_code = d.sal_code AND r.region_type = 'suburb'
		LEFT JOIN mv_housing_headline h ON h.region_code = r.region_code
		       AND h.measure = 'median_price'
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
			&r.Population, &r.MedianAge, &r.MedianWeeklyHhdIncome); err != nil {
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
		       COALESCE(d.median_weekly_hhd_income, 0),
		       COALESCE(d.median_weekly_per_income, 0), COALESCE(d.median_weekly_rent, 0),
		       COALESCE(d.median_monthly_mortgage, 0), COALESCE(d.pct_owned_outright, 0),
		       COALESCE(d.pct_owned_mortgage, 0), COALESCE(d.pct_rented, 0),
		       COALESCE(d.dwelling_count, 0), COALESCE(d.census_year, 2021),
		       COALESCE((SELECT avg(value) FROM mv_housing_headline sh JOIN house_price_regions sr
		                 ON sr.region_code = sh.region_code
		                 WHERE sr.state_code = d.state_code AND sr.region_type = 'suburb'
		                 AND sh.measure = 'median_price'), 0),
		       COALESCE((SELECT value FROM mv_housing_headline WHERE region_code = 'AUS'
		                 AND measure = 'median_price' LIMIT 1), 0),
		       COALESCE((SELECT avg(median_weekly_hhd_income) FROM suburb_demographics
		                 WHERE state_code = d.state_code), 0),
		       COALESCE((SELECT avg(median_weekly_hhd_income) FROM suburb_demographics), 0)
		FROM suburb_demographics d
		LEFT JOIN house_price_regions r ON r.sal_code = d.sal_code AND r.region_type = 'suburb'
		LEFT JOIN mv_housing_headline h ON h.region_code = r.region_code AND h.measure = 'median_price'
		WHERE d.sal_code = $1
		LIMIT 1`
	var p SuburbProfileRow
	row := s.db.QueryRow(ctx, q, salCode)
	if err := row.Scan(
		&p.Summary.SALCode, &p.Summary.SALName, &p.Summary.StateCode, &p.Summary.Postcode,
		&p.Summary.LatestMedianPrice, &p.Summary.LatestPeriod, &p.Summary.YoYPct,
		&p.Summary.Population, &p.Summary.MedianAge, &p.Summary.MedianWeeklyHhdIncome,
		&p.MedianWeeklyPerIncome, &p.MedianWeeklyRent, &p.MedianMonthlyMortgage,
		&p.PctOwnedOutright, &p.PctOwnedMortgage, &p.PctRented, &p.DwellingCount, &p.CensusYear,
		&p.StateMedianPrice, &p.NationalMedianPrice, &p.StateMedianHhdIncome, &p.NationalMedianHhdIncome,
	); err != nil {
		return nil, err
	}
	return &p, nil
}
