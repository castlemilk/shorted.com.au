package influence

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type EntityMapping struct {
	ABN         string
	StockCode   string
	Industry    string
	CompanyName string
	Confidence  float64
}

type IndustryRecord struct {
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
	Metadata       map[string]any
}

var nonAlphaNumeric = regexp.MustCompile(`[^a-z0-9]+`)

func loadEntityMappings(ctx context.Context, pool *pgxpool.Pool) (map[string]EntityMapping, error) {
	const q = `
		SELECT
			eam.abn,
			eam.stock_code,
			COALESCE(NULLIF(cm.industry, ''), 'Unclassified') AS industry,
			COALESCE(NULLIF(cm.company_name, ''), eam.entity_name, eam.stock_code) AS company_name,
			eam.confidence
		FROM entity_asx_map eam
		LEFT JOIN "company-metadata" cm ON cm.stock_code = eam.stock_code`
	rows, err := pool.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	mappings := map[string]EntityMapping{}
	for rows.Next() {
		var mapping EntityMapping
		if err := rows.Scan(&mapping.ABN, &mapping.StockCode, &mapping.Industry, &mapping.CompanyName, &mapping.Confidence); err != nil {
			return nil, err
		}
		mappings[abnDigits.ReplaceAllString(mapping.ABN, "")] = mapping
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return mappings, nil
}

func upsertIndustryRecords(ctx context.Context, pool *pgxpool.Pool, sourceKey string, records []IndustryRecord) (int, error) {
	if len(records) == 0 {
		return 0, nil
	}

	const q = `
		INSERT INTO industry_intelligence_records
			(source_key, source_record_id, signal_kind, industry, stock_code, entity_abn,
			 metric_key, metric_label, metric_value, unit, period_start, period_end, as_of,
			 title, summary, source_url, confidence, metadata)
		VALUES
			($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''),
			 $7, $8, $9, $10, $11, $12, $13,
			 $14, $15, $16, $17, $18::jsonb)
		ON CONFLICT (source_key, source_record_id) DO UPDATE SET
			signal_kind = EXCLUDED.signal_kind,
			industry = EXCLUDED.industry,
			stock_code = EXCLUDED.stock_code,
			entity_abn = EXCLUDED.entity_abn,
			metric_key = EXCLUDED.metric_key,
			metric_label = EXCLUDED.metric_label,
			metric_value = EXCLUDED.metric_value,
			unit = EXCLUDED.unit,
			period_start = EXCLUDED.period_start,
			period_end = EXCLUDED.period_end,
			as_of = EXCLUDED.as_of,
			title = EXCLUDED.title,
			summary = EXCLUDED.summary,
			source_url = EXCLUDED.source_url,
			confidence = EXCLUDED.confidence,
			metadata = EXCLUDED.metadata,
			updated_at = now()`

	batch := &pgx.Batch{}
	industries := map[string]bool{}
	for _, record := range records {
		metadataJSON := "{}"
		if record.Metadata != nil {
			b, err := json.Marshal(record.Metadata)
			if err != nil {
				return 0, fmt.Errorf("marshal record metadata for %s: %w", record.SourceRecordID, err)
			}
			metadataJSON = string(b)
		}
		batch.Queue(q,
			record.SourceKey,
			record.SourceRecordID,
			record.SignalKind,
			record.Industry,
			record.StockCode,
			record.EntityABN,
			record.MetricKey,
			record.MetricLabel,
			record.MetricValue,
			record.Unit,
			record.PeriodStart,
			record.PeriodEnd,
			record.AsOf,
			record.Title,
			record.Summary,
			record.SourceURL,
			record.Confidence,
			metadataJSON,
		)
		industries[record.Industry] = true
	}

	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	n := 0
	for range records {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	if err := markIndustrySourcePublic(ctx, pool, sourceKey, industries); err != nil {
		return n, err
	}
	return n, nil
}

func markIndustrySourcePublic(ctx context.Context, pool *pgxpool.Pool, sourceKey string, industries map[string]bool) error {
	if _, err := pool.Exec(ctx, `UPDATE industry_intelligence_sources SET public_enabled = TRUE, updated_at = now() WHERE source_key = $1`, sourceKey); err != nil {
		return err
	}

	const q = `
		INSERT INTO industry_intelligence_industry_sources
			(industry, source_key, enabled, public_enabled, reviewed_at, reviewed_by, notes)
		VALUES ($1, $2, TRUE, TRUE, now(), 'influence-collector', 'Exact ABN-matched public source records imported by collector.')
		ON CONFLICT (industry, source_key) DO UPDATE SET
			enabled = EXCLUDED.enabled,
			public_enabled = EXCLUDED.public_enabled,
			reviewed_at = EXCLUDED.reviewed_at,
			reviewed_by = EXCLUDED.reviewed_by,
			notes = EXCLUDED.notes,
			updated_at = now()`
	batch := &pgx.Batch{}
	for industry := range industries {
		batch.Queue(q, industry, sourceKey)
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	for range industries {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

func normalizedHeader(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = nonAlphaNumeric.ReplaceAllString(s, " ")
	return strings.Join(strings.Fields(s), " ")
}

func columnIndex(headers []string, candidates ...string) int {
	normalized := make([]string, len(headers))
	for i, header := range headers {
		normalized[i] = normalizedHeader(header)
	}
	for _, candidate := range candidates {
		want := normalizedHeader(candidate)
		for i, header := range normalized {
			if header == want {
				return i
			}
		}
	}
	return -1
}

func readColumn(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[idx])
}

func stableRecordID(prefix string, parts ...string) string {
	h := sha1.New() //nolint:gosec // Stable non-security identifier for source rows.
	for _, part := range parts {
		_, _ = h.Write([]byte(strings.TrimSpace(part)))
		_, _ = h.Write([]byte{0})
	}
	return prefix + ":" + hex.EncodeToString(h.Sum(nil))[:20]
}

func financialYearDates(yearEnd int) (*time.Time, *time.Time, time.Time) {
	start := time.Date(yearEnd-1, time.July, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(yearEnd, time.June, 30, 0, 0, 0, 0, time.UTC)
	return &start, &end, end
}

func yearEndFromText(s string) (int, bool) {
	year, ok := incomeYearFromResource(ckanResource{Name: s, Description: s, URL: s})
	return year, ok
}
