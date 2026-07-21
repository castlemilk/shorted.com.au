package shorts

import (
	"context"
	"time"
)

// EconomicSeriesRow is one catalog entry (+ latest period for the list view).
type EconomicSeriesRow struct {
	SeriesKey     string
	Topic         string
	Metric        string
	Product       string
	RegionType    string
	RegionCode    string
	RegionName    string
	Unit          string
	Frequency     string
	Adjustment    string
	SourceKey     string
	SourceLicence string
	LatestPeriod  time.Time
}

// EconomicObservationRow is one (period, value) pair.
type EconomicObservationRow struct {
	Period time.Time
	Value  float64
}

// EconomicSeriesDataRow is a catalog entry plus its observations.
type EconomicSeriesDataRow struct {
	Info   EconomicSeriesRow
	Points []EconomicObservationRow
}

// ListEconomicSeries returns catalog entries matching the optional filters.
func (s *postgresStore) ListEconomicSeries(topic, metric, regionType, regionCode, product string, limit int32) ([]*EconomicSeriesRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if limit <= 0 || limit > 500 {
		limit = 200
	}

	const query = `
		SELECT es.series_key, es.topic, es.metric, COALESCE(es.product, ''),
		       es.region_type, es.region_code, es.region_name, es.unit,
		       es.frequency, es.adjustment, es.source_key, es.licence,
		       COALESCE(lp.latest, '0001-01-01'::date)
		FROM economic_series es
		LEFT JOIN LATERAL (
			SELECT max(period) AS latest FROM economic_observations o WHERE o.series_id = es.id
		) lp ON TRUE
		WHERE ($1 = '' OR es.topic = $1)
		  AND ($2 = '' OR es.metric = $2)
		  AND ($3 = '' OR es.region_type = $3)
		  AND ($4 = '' OR es.region_code = $4)
		  AND ($5 = '' OR es.product = $5)
		ORDER BY es.series_key
		LIMIT $6`

	rows, err := s.db.Query(ctx, query, topic, metric, regionType, regionCode, product, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*EconomicSeriesRow
	for rows.Next() {
		var r EconomicSeriesRow
		if err := rows.Scan(&r.SeriesKey, &r.Topic, &r.Metric, &r.Product,
			&r.RegionType, &r.RegionCode, &r.RegionName, &r.Unit,
			&r.Frequency, &r.Adjustment, &r.SourceKey, &r.SourceLicence,
			&r.LatestPeriod); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// GetEconomicSeries returns observations (oldest first, capped at 600/series)
// for the requested keys. Unknown keys are silently absent from the result.
func (s *postgresStore) GetEconomicSeries(seriesKeys []string, startPeriod time.Time) ([]*EconomicSeriesDataRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if len(seriesKeys) > 50 {
		seriesKeys = seriesKeys[:50]
	}

	const query = `
		SELECT es.series_key, es.topic, es.metric, COALESCE(es.product, ''),
		       es.region_type, es.region_code, es.region_name, es.unit,
		       es.frequency, es.adjustment, es.source_key, es.licence,
		       o.period, o.value
		FROM economic_series es
		JOIN LATERAL (
			SELECT period, value
			FROM economic_observations ob
			WHERE ob.series_id = es.id AND ob.period >= $2
			ORDER BY ob.period DESC
			LIMIT 600
		) o ON TRUE
		WHERE es.series_key = ANY($1)
		ORDER BY es.series_key, o.period ASC`

	rows, err := s.db.Query(ctx, query, seriesKeys, startPeriod)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byKey := map[string]*EconomicSeriesDataRow{}
	var order []string
	for rows.Next() {
		var info EconomicSeriesRow
		var p EconomicObservationRow
		if err := rows.Scan(&info.SeriesKey, &info.Topic, &info.Metric, &info.Product,
			&info.RegionType, &info.RegionCode, &info.RegionName, &info.Unit,
			&info.Frequency, &info.Adjustment, &info.SourceKey, &info.SourceLicence,
			&p.Period, &p.Value); err != nil {
			return nil, err
		}
		d, ok := byKey[info.SeriesKey]
		if !ok {
			d = &EconomicSeriesDataRow{Info: info}
			byKey[info.SeriesKey] = d
			order = append(order, info.SeriesKey)
		}
		d.Points = append(d.Points, p)
	}
	out := make([]*EconomicSeriesDataRow, 0, len(order))
	for _, k := range order {
		d := byKey[k]
		d.Info.LatestPeriod = d.Points[len(d.Points)-1].Period
		out = append(out, d)
	}
	return out, rows.Err()
}
