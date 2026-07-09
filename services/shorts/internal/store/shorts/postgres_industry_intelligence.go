package shorts

import (
	"context"
	"fmt"
	"time"
)

type IndustryIntelligenceResult struct {
	Sources      []IndustryIntelligenceSourceRow
	Records      []IndustryIntelligenceRecordRow
	TimeBuckets  []IndustryIntelligenceTimeBucketRow
	EntityTotals []IndustryIntelligenceEntityTotalRow
}

// IndustryIntelligenceTimeBucketRow aggregates one metric of one source per
// Australian financial year (bucketed on COALESCE(period_end, as_of)).
type IndustryIntelligenceTimeBucketRow struct {
	SignalKind     string
	SourceKey      string
	MetricKey      string
	MetricLabel    string
	Unit           string
	FYEndYear      int
	TotalValue     float64
	RecordCount    int32
	EntityCount    int32
	ZeroValueCount int32
}

// IndustryIntelligenceEntityTotalRow is the per-entity total for one metric of
// one source, restricted to the top entities by total value.
type IndustryIntelligenceEntityTotalRow struct {
	SignalKind  string
	SourceKey   string
	MetricKey   string
	StockCode   string
	EntityLabel string
	Unit        string
	TotalValue  float64
	RecordCount int32
	LatestAsOf  time.Time
}

type IndustryIntelligenceSourceRow struct {
	SourceKey   string
	DisplayName string
	SignalKind  string
	Publisher   string
	SourceURL   string
	Licence     string
	Cadence     string
}

type IndustryIntelligenceRecordRow struct {
	SourceKey      string
	SourceRecordID string
	SignalKind     string
	Industry       string
	StockCode      string
	EntityABN      string
	MetricKey      string
	MetricLabel    string
	MetricValue    *float64
	Unit           string
	PeriodStart    *time.Time
	PeriodEnd      *time.Time
	AsOf           time.Time
	Title          string
	Summary        string
	SourceURL      string
	Confidence     float64
}

func (s *postgresStore) GetIndustryIntelligence(industry string, recordLimit int32) (*IndustryIntelligenceResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	limit := recordLimit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	const sourcesQuery = `
		SELECT DISTINCT
			s.source_key,
			s.display_name,
			s.signal_kind,
			s.publisher,
			s.source_url,
			s.licence,
			s.cadence
		FROM industry_intelligence_sources s
		JOIN industry_intelligence_records r ON r.source_key = s.source_key
		WHERE s.public_enabled
		  AND ($1 = '' OR r.industry = $1)
		ORDER BY s.signal_kind, s.display_name`

	sourceRows, err := s.db.Query(ctx, sourcesQuery, industry)
	if err != nil {
		return nil, fmt.Errorf("failed to query industry intelligence sources: %w", err)
	}
	defer sourceRows.Close()

	result := &IndustryIntelligenceResult{}
	for sourceRows.Next() {
		var row IndustryIntelligenceSourceRow
		if err := sourceRows.Scan(
			&row.SourceKey,
			&row.DisplayName,
			&row.SignalKind,
			&row.Publisher,
			&row.SourceURL,
			&row.Licence,
			&row.Cadence,
		); err != nil {
			return nil, fmt.Errorf("failed to scan industry intelligence source: %w", err)
		}
		result.Sources = append(result.Sources, row)
	}
	if err := sourceRows.Err(); err != nil {
		return nil, fmt.Errorf("failed iterating industry intelligence sources: %w", err)
	}

	const recordsQuery = `
		SELECT
			r.source_key,
			r.source_record_id,
			r.signal_kind,
			r.industry,
			COALESCE(r.stock_code, ''),
			COALESCE(r.entity_abn, ''),
			r.metric_key,
			r.metric_label,
			r.metric_value::double precision,
			r.unit,
			r.period_start,
			r.period_end,
			r.as_of,
			r.title,
			r.summary,
			r.source_url,
			r.confidence
		FROM industry_intelligence_records r
		JOIN industry_intelligence_sources s ON s.source_key = r.source_key
		WHERE s.public_enabled
		  AND ($1 = '' OR r.industry = $1)
		ORDER BY r.as_of DESC, r.signal_kind, r.source_key, r.metric_key
		LIMIT $2`

	recordRows, err := s.db.Query(ctx, recordsQuery, industry, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query industry intelligence records: %w", err)
	}
	defer recordRows.Close()

	for recordRows.Next() {
		var row IndustryIntelligenceRecordRow
		if err := recordRows.Scan(
			&row.SourceKey,
			&row.SourceRecordID,
			&row.SignalKind,
			&row.Industry,
			&row.StockCode,
			&row.EntityABN,
			&row.MetricKey,
			&row.MetricLabel,
			&row.MetricValue,
			&row.Unit,
			&row.PeriodStart,
			&row.PeriodEnd,
			&row.AsOf,
			&row.Title,
			&row.Summary,
			&row.SourceURL,
			&row.Confidence,
		); err != nil {
			return nil, fmt.Errorf("failed to scan industry intelligence record: %w", err)
		}
		result.Records = append(result.Records, row)
	}
	if err := recordRows.Err(); err != nil {
		return nil, fmt.Errorf("failed iterating industry intelligence records: %w", err)
	}

	// Australian financial year bucketing: months >= July roll into the FY that
	// ends the following June (period_end 2024-06-30 -> FY ending 2024).
	const timeBucketsQuery = `
		SELECT
			r.signal_kind,
			r.source_key,
			r.metric_key,
			MIN(r.metric_label),
			r.unit,
			(EXTRACT(YEAR FROM COALESCE(r.period_end, r.as_of))::int
				+ CASE WHEN EXTRACT(MONTH FROM COALESCE(r.period_end, r.as_of)) >= 7 THEN 1 ELSE 0 END) AS fy_end,
			SUM(r.metric_value)::double precision,
			COUNT(*)::int,
			COUNT(DISTINCT NULLIF(r.stock_code, ''))::int,
			COUNT(*) FILTER (WHERE r.metric_value = 0)::int
		FROM industry_intelligence_records r
		JOIN industry_intelligence_sources s ON s.source_key = r.source_key
		WHERE s.public_enabled
		  AND ($1 = '' OR r.industry = $1)
		  AND r.metric_value IS NOT NULL
		GROUP BY r.signal_kind, r.source_key, r.metric_key, r.unit, fy_end
		ORDER BY r.signal_kind, r.source_key, r.metric_key, fy_end`

	bucketRows, err := s.db.Query(ctx, timeBucketsQuery, industry)
	if err != nil {
		return nil, fmt.Errorf("failed to query industry intelligence time buckets: %w", err)
	}
	defer bucketRows.Close()

	for bucketRows.Next() {
		var row IndustryIntelligenceTimeBucketRow
		if err := bucketRows.Scan(
			&row.SignalKind,
			&row.SourceKey,
			&row.MetricKey,
			&row.MetricLabel,
			&row.Unit,
			&row.FYEndYear,
			&row.TotalValue,
			&row.RecordCount,
			&row.EntityCount,
			&row.ZeroValueCount,
		); err != nil {
			return nil, fmt.Errorf("failed to scan industry intelligence time bucket: %w", err)
		}
		result.TimeBuckets = append(result.TimeBuckets, row)
	}
	if err := bucketRows.Err(); err != nil {
		return nil, fmt.Errorf("failed iterating industry intelligence time buckets: %w", err)
	}

	const entityTotalsQuery = `
		WITH totals AS (
			SELECT
				r.signal_kind,
				r.source_key,
				r.metric_key,
				r.stock_code,
				r.unit,
				SUM(r.metric_value)::double precision AS total_value,
				COUNT(*)::int AS record_count,
				MAX(r.as_of) AS latest_as_of,
				ROW_NUMBER() OVER (
					PARTITION BY r.signal_kind, r.source_key, r.metric_key
					ORDER BY SUM(r.metric_value) DESC
				) AS rank
			FROM industry_intelligence_records r
			JOIN industry_intelligence_sources s ON s.source_key = r.source_key
			WHERE s.public_enabled
			  AND ($1 = '' OR r.industry = $1)
			  AND r.metric_value IS NOT NULL
			  AND COALESCE(r.stock_code, '') <> ''
			GROUP BY r.signal_kind, r.source_key, r.metric_key, r.stock_code, r.unit
		)
		SELECT
			t.signal_kind,
			t.source_key,
			t.metric_key,
			t.stock_code,
			COALESCE(NULLIF(cm.company_name, ''), t.stock_code),
			t.unit,
			t.total_value,
			t.record_count,
			t.latest_as_of
		FROM totals t
		LEFT JOIN "company-metadata" cm ON cm.stock_code = t.stock_code
		WHERE t.rank <= 8
		ORDER BY t.signal_kind, t.source_key, t.metric_key, t.total_value DESC`

	entityRows, err := s.db.Query(ctx, entityTotalsQuery, industry)
	if err != nil {
		return nil, fmt.Errorf("failed to query industry intelligence entity totals: %w", err)
	}
	defer entityRows.Close()

	for entityRows.Next() {
		var row IndustryIntelligenceEntityTotalRow
		if err := entityRows.Scan(
			&row.SignalKind,
			&row.SourceKey,
			&row.MetricKey,
			&row.StockCode,
			&row.EntityLabel,
			&row.Unit,
			&row.TotalValue,
			&row.RecordCount,
			&row.LatestAsOf,
		); err != nil {
			return nil, fmt.Errorf("failed to scan industry intelligence entity total: %w", err)
		}
		result.EntityTotals = append(result.EntityTotals, row)
	}
	if err := entityRows.Err(); err != nil {
		return nil, fmt.Errorf("failed iterating industry intelligence entity totals: %w", err)
	}

	return result, nil
}
