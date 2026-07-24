package shorts

import (
	"context"
	"strings"
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

// SeriesCorrelationRow is a precomputed correlation plus its overlay catalog metadata.
type SeriesCorrelationRow struct {
	Overlay    EconomicSeriesRow
	R          float64
	N          int32
	LastPeriod time.Time
}

const getEconomicSeriesQuery = `
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
		LIMIT $3
	) o ON TRUE
	WHERE es.series_key = ANY($1)
	ORDER BY es.series_key, o.period ASC`

const listSeriesCorrelationsQuery = `
	SELECT c.overlay_series_key, c.r, c.n, c.last_period,
	       es.topic, es.metric, COALESCE(es.product, ''),
	       es.region_type, es.region_code, es.region_name, es.unit,
	       es.frequency, es.adjustment, es.source_key, es.licence
	FROM economic_correlations c
	JOIN economic_series es ON es.series_key = c.overlay_series_key
	WHERE c.base_series_key = $1
	  AND c.window_months = $2
	  AND c.abs_r >= $3
	ORDER BY c.abs_r DESC, c.overlay_series_key
	LIMIT $4`

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

// GetEconomicSeries returns observations oldest-first for the requested keys,
// capped per series by maxObservations. Unknown keys are silently absent.
func (s *postgresStore) GetEconomicSeries(seriesKeys []string, startPeriod time.Time, maxObservations int32) ([]*EconomicSeriesDataRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if len(seriesKeys) > 50 {
		seriesKeys = seriesKeys[:50]
	}
	maxObservations = normalizeMaxObservations(maxObservations)

	rows, err := s.db.Query(ctx, getEconomicSeriesQuery, seriesKeys, startPeriod, maxObservations)
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

// ListSeriesCorrelations returns precomputed overlays ranked by absolute
// correlation, including catalog metadata needed by clients to label results.
func (s *postgresStore) ListSeriesCorrelations(baseSeriesKey string, windowMonths int32, minAbsR float64, limit int32) ([]*SeriesCorrelationRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	baseSeriesKey = strings.ToLower(strings.TrimSpace(baseSeriesKey))
	if windowMonths <= 0 {
		windowMonths = 24
	}
	if minAbsR < 0 {
		minAbsR = 0
	} else if minAbsR > 1 {
		minAbsR = 1
	}
	if limit <= 0 {
		limit = 100
	} else if limit > 100 {
		limit = 100
	}

	rows, err := s.db.Query(ctx, listSeriesCorrelationsQuery, baseSeriesKey, windowMonths, minAbsR, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*SeriesCorrelationRow
	for rows.Next() {
		var row SeriesCorrelationRow
		if err := rows.Scan(
			&row.Overlay.SeriesKey, &row.R, &row.N, &row.LastPeriod,
			&row.Overlay.Topic, &row.Overlay.Metric, &row.Overlay.Product,
			&row.Overlay.RegionType, &row.Overlay.RegionCode, &row.Overlay.RegionName,
			&row.Overlay.Unit, &row.Overlay.Frequency, &row.Overlay.Adjustment,
			&row.Overlay.SourceKey, &row.Overlay.SourceLicence,
		); err != nil {
			return nil, err
		}
		out = append(out, &row)
	}
	return out, rows.Err()
}

func normalizeMaxObservations(maxObservations int32) int32 {
	switch {
	case maxObservations == 0:
		return 600
	case maxObservations < 1:
		return 1
	case maxObservations > 600:
		return 600
	default:
		return maxObservations
	}
}
