package reportextract

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// storeExtractionSQL is extract.py's store_extraction upsert, verbatim (psycopg2
// %s → pgx $n). report_url is the conflict target (it carries the table's UNIQUE
// constraint), so a re-extraction REPLACES the metrics/digest for that report.
const storeExtractionSQL = `
        INSERT INTO financial_report_extractions
            (stock_code, report_url, report_type, report_title, report_date,
             metrics, raw_text_length, extracted_at,
             digest, digest_confidence, digest_model, raw_text_gcs_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (report_url) DO UPDATE SET
            metrics = EXCLUDED.metrics,
            raw_text_length = EXCLUDED.raw_text_length,
            extracted_at = EXCLUDED.extracted_at,
            digest = EXCLUDED.digest,
            digest_confidence = EXCLUDED.digest_confidence,
            digest_model = EXCLUDED.digest_model,
            raw_text_gcs_url = EXCLUDED.raw_text_gcs_url
        `

// extractionStore is the write side of the report pipeline.
type extractionStore interface {
	StoreExtraction(ctx context.Context, r report, metrics map[string]any, rawTextLength int, digest digestResult, rawTextGCSURL string) error
}

// pgExtractionStore writes through the shared pgx pool.
type pgExtractionStore struct {
	pool   *pgxpool.Pool
	dryRun bool
}

// StoreExtraction persists one extraction row.
//
// NULL semantics are load-bearing and copied exactly:
//   - digest: "" → NULL
//   - digest_confidence: only persisted ALONGSIDE an actual digest, so a 0.0 from
//     a FAILED digest call stays NULL and is never confused with a genuine
//     low-confidence one.
//   - digest_model: NULL unless a digest was produced.
//   - report_date: "" → NULL (the column is DATE; psycopg2 sent Python's empty
//     string, which Postgres rejects — see the divergence note).
func (s *pgExtractionStore) StoreExtraction(ctx context.Context, r report, metrics map[string]any, rawTextLength int, digest digestResult, rawTextGCSURL string) error {
	if s.dryRun {
		log.Printf("  [DRY RUN] Would store %d metrics for %s", len(metrics), r.StockCode)
		if digest.Digest != "" {
			log.Printf("  [DRY RUN] Digest: %.120s", digest.Digest)
		}
		return nil
	}

	if metrics == nil {
		metrics = map[string]any{}
	}
	metricsJSON, err := json.Marshal(metrics)
	if err != nil {
		return fmt.Errorf("marshal metrics for %s: %w", r.StockCode, err)
	}

	var (
		digestValue     *string
		confidenceValue *float64
		modelValue      *string
	)
	if digest.Digest != "" {
		d := digest.Digest
		c := digest.Confidence
		m := digestModel
		digestValue, confidenceValue, modelValue = &d, &c, &m
	}

	_, err = s.pool.Exec(ctx, storeExtractionSQL,
		r.StockCode,
		r.URL,
		nullIfEmpty(r.Type),
		nullIfEmpty(r.Title),
		nullIfEmpty(r.Date),
		string(metricsJSON),
		rawTextLength,
		time.Now().UTC(),
		digestValue,
		confidenceValue,
		modelValue,
		nullIfEmpty(rawTextGCSURL),
	)
	if err != nil {
		return fmt.Errorf("store extraction for %s: %w", r.StockCode, err)
	}
	return nil
}

// nullIfEmpty maps "" to a SQL NULL. Python passed the empty strings straight
// through; report_date is a DATE column, so an empty `date` field in the
// financial_reports JSON raised a psycopg2 DataError there and now writes NULL.
// That is a bug fix, not a silent change of stored values — no non-empty value
// behaves differently.
func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
