package shorts

import (
	"context"
	"fmt"
	"time"
)

type IndustryIntelligenceResult struct {
	Sources []IndustryIntelligenceSourceRow
	Records []IndustryIntelligenceRecordRow
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

	return result, nil
}
