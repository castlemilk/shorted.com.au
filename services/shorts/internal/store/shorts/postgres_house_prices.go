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
