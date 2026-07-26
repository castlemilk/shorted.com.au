package reportextract

import (
	"context"
	"strings"
	"testing"
)

// The upsert's conflict target and its NULL semantics are a stored-data
// contract: report_url is the dedupe key, and digest_confidence must stay NULL
// when the digest call FAILED (0.0) rather than looking like a genuine
// low-confidence digest.
func TestStoreExtractionSQLShape(t *testing.T) {
	for _, want := range []string{
		"INSERT INTO financial_report_extractions",
		"(stock_code, report_url, report_type, report_title, report_date,",
		"metrics, raw_text_length, extracted_at,",
		"digest, digest_confidence, digest_model, raw_text_gcs_url)",
		"VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
		"ON CONFLICT (report_url) DO UPDATE SET",
		"metrics = EXCLUDED.metrics",
		"digest_confidence = EXCLUDED.digest_confidence",
		"raw_text_gcs_url = EXCLUDED.raw_text_gcs_url",
	} {
		if !strings.Contains(storeExtractionSQL, want) {
			t.Errorf("upsert drifted, missing: %q", want)
		}
	}
	// stock_code and report_url are NOT in the DO UPDATE set — a conflicting row
	// keeps its identity columns.
	if strings.Contains(storeExtractionSQL, "stock_code = EXCLUDED.stock_code") {
		t.Error("the conflict update must not rewrite identity columns")
	}
}

func TestNullIfEmpty(t *testing.T) {
	if nullIfEmpty("") != nil {
		t.Error("empty string must become SQL NULL")
	}
	if got := nullIfEmpty("2025-09-01"); got == nil || *got != "2025-09-01" {
		t.Errorf("non-empty must pass through, got %v", got)
	}
}

// -dry-run must not reach the database at all — the store short-circuits before
// any Exec, which is what lets the nil pool in this test stay nil.
func TestStoreExtractionDryRunWritesNothing(t *testing.T) {
	s := &pgExtractionStore{pool: nil, dryRun: true}
	err := s.StoreExtraction(context.Background(),
		report{StockCode: "BHP", URL: "u"},
		map[string]any{"revenue": map[string]any{"source_text": "r"}},
		1234,
		digestResult{Digest: "A digest.", Confidence: 0.7},
		"gs://b/o.txt")
	if err != nil {
		t.Fatalf("dry run must succeed without a pool: %v", err)
	}
}
