package announcements

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

// TestDividendRowsFor tests the dividend row extraction policy.
func TestDividendRowsFor(t *testing.T) {
	testsDir := "testdata/dividend_notices"

	// Load test fixtures
	loadFixture := func(filename string) string {
		path := filepath.Join(testsDir, filename)
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("load %s: %v", filename, err)
		}
		return string(b)
	}

	tests := []struct {
		name        string
		notice      DividendNotice
		pending     pendingNotice
		wantRows    int
		wantOutcome string
		wantDetail  string
		checks      func(t *testing.T, rows []dividendRow)
	}{
		{
			name: "CBA final 2026-08-12",
			notice: func() DividendNotice {
				text := loadFixture("cba_final_2026-08-12.txt")
				parsed, _, _ := parseDividendNotice(text)
				return parsed
			}(),
			pending: pendingNotice{
				StockCode:        "CBA",
				AnnouncementDate: "2026-08-12",
				Headline:         "Dividend/Distribution - CBA",
				URL:              "https://www.asx.com.au/download/cba_final.pdf",
			},
			wantRows:    1,
			wantOutcome: "parsed",
			wantDetail:  "1 rows",
			checks: func(t *testing.T, rows []dividendRow) {
				if len(rows) != 1 {
					t.Fatalf("want 1 row, got %d", len(rows))
				}
				r := rows[0]
				if r.StockCode != "CBA" {
					t.Errorf("StockCode: want CBA, got %s", r.StockCode)
				}
				if r.ExDate != "2026-08-19" {
					t.Errorf("ExDate: want 2026-08-19, got %s", r.ExDate)
				}
				if r.RecordDate != "2026-08-20" {
					t.Errorf("RecordDate: want 2026-08-20, got %s", r.RecordDate)
				}
				if r.PaymentDate != "2026-09-29" {
					t.Errorf("PaymentDate: want 2026-09-29, got %s", r.PaymentDate)
				}
				if r.PeriodEnd != "2026-06-30" {
					t.Errorf("PeriodEnd: want 2026-06-30, got %s", r.PeriodEnd)
				}
				if r.AmountAUD != 2.70 {
					t.Errorf("AmountAUD: want 2.70, got %f", r.AmountAUD)
				}
				if r.FrankedPct == nil || *r.FrankedPct != 100 {
					t.Errorf("FrankedPct: want 100, got %v", r.FrankedPct)
				}
				if r.Type != "ordinary" {
					t.Errorf("Type: want ordinary, got %s", r.Type)
				}
				if r.DeclaredCurrency != "AUD" {
					t.Errorf("DeclaredCurrency: want AUD, got %s", r.DeclaredCurrency)
				}
				if r.DeclaredAmount != 2.70 {
					t.Errorf("DeclaredAmount: want 2.70, got %f", r.DeclaredAmount)
				}
				if r.AnnouncedOn != "2026-08-12" {
					t.Errorf("AnnouncedOn: want 2026-08-12, got %s", r.AnnouncedOn)
				}
			},
		},
		{
			name: "SUN final 2026-08-12 (two parts)",
			notice: func() DividendNotice {
				text := loadFixture("sun_final_2026-08-12.txt")
				parsed, _, _ := parseDividendNotice(text)
				return parsed
			}(),
			pending: pendingNotice{
				StockCode:        "SUN",
				AnnouncementDate: "2026-08-12",
				Headline:         "Dividend/Distribution - SUN",
				URL:              "https://www.asx.com.au/download/sun_final.pdf",
			},
			wantRows:    2,
			wantOutcome: "parsed",
			wantDetail:  "2 rows",
			checks: func(t *testing.T, rows []dividendRow) {
				if len(rows) != 2 {
					t.Fatalf("want 2 rows, got %d", len(rows))
				}
				// Row 0: ordinary 0.52, fully franked
				r0 := rows[0]
				if r0.Type != "ordinary" {
					t.Errorf("rows[0].Type: want ordinary, got %s", r0.Type)
				}
				if r0.AmountAUD != 0.52 {
					t.Errorf("rows[0].AmountAUD: want 0.52, got %f", r0.AmountAUD)
				}
				if r0.FrankedPct == nil || *r0.FrankedPct != 100 {
					t.Errorf("rows[0].FrankedPct: want 100, got %v", r0.FrankedPct)
				}
				// Row 1: special 0.10, fully franked
				r1 := rows[1]
				if r1.Type != "special" {
					t.Errorf("rows[1].Type: want special, got %s", r1.Type)
				}
				if r1.AmountAUD != 0.10 {
					t.Errorf("rows[1].AmountAUD: want 0.10, got %f", r1.AmountAUD)
				}
				if r1.FrankedPct == nil || *r1.FrankedPct != 100 {
					t.Errorf("rows[1].FrankedPct: want 100, got %v", r1.FrankedPct)
				}
			},
		},
		{
			name: "BHP final 2026-08-18 (awaiting AUD equivalent)",
			notice: func() DividendNotice {
				text := loadFixture("bhp_final_2026-08-18.txt")
				parsed, _, _ := parseDividendNotice(text)
				return parsed
			}(),
			pending: pendingNotice{
				StockCode:        "BHP",
				AnnouncementDate: "2026-08-18",
				Headline:         "Dividend/Distribution - BHP",
				URL:              "https://www.asx.com.au/download/bhp_final.pdf",
			},
			wantRows:    0,
			wantOutcome: "awaiting_aud_equivalent",
		},
		{
			name: "BHP update 2026-10-08",
			notice: func() DividendNotice {
				text := loadFixture("bhp_update_2026-10-08.txt")
				parsed, _, _ := parseDividendNotice(text)
				return parsed
			}(),
			pending: pendingNotice{
				StockCode:        "BHP",
				AnnouncementDate: "2026-10-08",
				Headline:         "Dividend/Distribution - BHP",
				URL:              "https://www.asx.com.au/download/bhp_update.pdf",
			},
			wantRows:    1,
			wantOutcome: "parsed",
			wantDetail:  "1 rows",
			checks: func(t *testing.T, rows []dividendRow) {
				if len(rows) != 1 {
					t.Fatalf("want 1 row, got %d", len(rows))
				}
				r := rows[0]
				if r.StockCode != "BHP" {
					t.Errorf("StockCode: want BHP, got %s", r.StockCode)
				}
				if r.DeclaredCurrency != "USD" {
					t.Errorf("DeclaredCurrency: want USD, got %s", r.DeclaredCurrency)
				}
				if r.DeclaredAmount != 0.99 {
					t.Errorf("DeclaredAmount: want 0.99, got %f", r.DeclaredAmount)
				}
				if r.AmountAUD != 1.37988710 {
					t.Errorf("AmountAUD: want 1.37988710, got %f", r.AmountAUD)
				}
				if r.ExDate != "2026-09-03" {
					t.Errorf("ExDate: want 2026-09-03, got %s", r.ExDate)
				}
				if r.AnnouncedOn != "2026-10-08" {
					t.Errorf("AnnouncedOn: want 2026-10-08, got %s", r.AnnouncedOn)
				}
			},
		},
		{
			name: "CBAPI 2026-09-17 (CDI listed under CBA)",
			notice: func() DividendNotice {
				text := loadFixture("cbapi_2026-09-17.txt")
				parsed, _, _ := parseDividendNotice(text)
				return parsed
			}(),
			pending: pendingNotice{
				StockCode:        "CBA",
				AnnouncementDate: "2026-09-17",
				Headline:         "Dividend/Distribution - CBA",
				URL:              "https://www.asx.com.au/download/cbapi.pdf",
			},
			wantRows:    1,
			wantOutcome: "parsed",
			wantDetail:  "1 rows",
			checks: func(t *testing.T, rows []dividendRow) {
				if len(rows) != 1 {
					t.Fatalf("want 1 row, got %d", len(rows))
				}
				if rows[0].StockCode != "CBAPI" {
					t.Errorf("StockCode: want CBAPI, got %s", rows[0].StockCode)
				}
			},
		},
		{
			name: "CBA final listed under WBC (code mismatch)",
			notice: func() DividendNotice {
				text := loadFixture("cba_final_2026-08-12.txt")
				parsed, _, _ := parseDividendNotice(text)
				return parsed
			}(),
			pending: pendingNotice{
				StockCode:        "WBC",
				AnnouncementDate: "2026-08-12",
				Headline:         "Dividend/Distribution - WBC",
				URL:              "https://www.asx.com.au/download/cba_final.pdf",
			},
			wantRows:    0,
			wantOutcome: "code_mismatch",
		},
		{
			name: "estimated_only (synthetic)",
			notice: DividendNotice{
				SecurityCode: "TEST",
				ExDate:       "2026-01-01",
				Currency:     "AUD",
				Total:        1.0,
				Parts: []DividendPart{
					{Type: "ordinary", Amount: 1.0, Estimated: true, FrankedPct: nil},
				},
			},
			pending: pendingNotice{
				StockCode:        "TEST",
				AnnouncementDate: "2026-01-01",
				URL:              "https://test.pdf",
			},
			wantRows:    0,
			wantOutcome: "estimated_only",
		},
		{
			name: "MCY final 2026-09-21 (NZD with AUD equivalent)",
			notice: func() DividendNotice {
				text := loadFixture("mcy_final_2026-09-21.txt")
				parsed, _, _ := parseDividendNotice(text)
				return parsed
			}(),
			pending: pendingNotice{
				StockCode:        "MCY",
				AnnouncementDate: "2026-09-21",
				Headline:         "Dividend/Distribution - MCY",
				URL:              "https://www.asx.com.au/download/mcy.pdf",
			},
			wantRows:    1,
			wantOutcome: "parsed",
			wantDetail:  "1 rows",
			checks: func(t *testing.T, rows []dividendRow) {
				if len(rows) != 1 {
					t.Fatalf("want 1 row, got %d", len(rows))
				}
				r := rows[0]
				if r.AmountAUD != 0.136544 {
					t.Errorf("AmountAUD: want 0.136544, got %f", r.AmountAUD)
				}
				if r.DeclaredCurrency != "NZD" {
					t.Errorf("DeclaredCurrency: want NZD, got %s", r.DeclaredCurrency)
				}
				if r.DeclaredAmount != 0.17 {
					t.Errorf("DeclaredAmount: want 0.17, got %f", r.DeclaredAmount)
				}
			},
		},
		{
			name: "SPK dividend 2026-09-17 (NZD with AUD equivalent)",
			notice: func() DividendNotice {
				text := loadFixture("spk_dividend_2026-09-17.txt")
				parsed, _, _ := parseDividendNotice(text)
				return parsed
			}(),
			pending: pendingNotice{
				StockCode:        "SPK",
				AnnouncementDate: "2026-09-17",
				Headline:         "Dividend/Distribution - SPK",
				URL:              "https://www.asx.com.au/download/spk.pdf",
			},
			wantRows:    1,
			wantOutcome: "parsed",
			wantDetail:  "1 rows",
			checks: func(t *testing.T, rows []dividendRow) {
				if len(rows) != 1 {
					t.Fatalf("want 1 row, got %d", len(rows))
				}
				r := rows[0]
				// AmountAUD = 0.08 * (0.07022128 / 0.08705882), rounded to 8 dp
				expectedAUD := 0.06452767
				if r.AmountAUD != expectedAUD {
					t.Errorf("AmountAUD: want %f, got %f", expectedAUD, r.AmountAUD)
				}
			},
		},
		{
			name: "AIA dividend 2026-09-30 (NZD with AUD equivalent)",
			notice: func() DividendNotice {
				text := loadFixture("aia_dividend_2026-09-30.txt")
				parsed, _, _ := parseDividendNotice(text)
				return parsed
			}(),
			pending: pendingNotice{
				StockCode:        "AIA",
				AnnouncementDate: "2026-09-30",
				Headline:         "Dividend/Distribution - AIA",
				URL:              "https://www.asx.com.au/download/aia.pdf",
			},
			wantRows:    1,
			wantOutcome: "parsed",
			wantDetail:  "1 rows",
			checks: func(t *testing.T, rows []dividendRow) {
				if len(rows) != 1 {
					t.Fatalf("want 1 row, got %d", len(rows))
				}
				r := rows[0]
				// AmountAUD = 0.0675 * (0.06411308 / 0.07941176), rounded to 8 dp
				expectedAUD := 0.05449612
				if r.AmountAUD != expectedAUD {
					t.Errorf("AmountAUD: want %f, got %f", expectedAUD, r.AmountAUD)
				}
			},
		},
		{
			name: "synthetic USD notice with 2 parts and AUD equivalent split across them",
			notice: DividendNotice{
				SecurityCode:  "TEST",
				ExDate:        "2026-01-01",
				Currency:      "USD",
				Total:         0.75,
				AUDEquivalent: func() *float64 { f := 1.125; return &f }(),
				Parts: []DividendPart{
					{Type: "ordinary", Amount: 0.50, Estimated: false, FrankedPct: nil},
					{Type: "special", Amount: 0.25, Estimated: false, FrankedPct: nil},
				},
			},
			pending: pendingNotice{
				StockCode:        "TEST",
				AnnouncementDate: "2026-01-01",
				URL:              "https://test.pdf",
			},
			wantRows:    2,
			wantOutcome: "parsed",
			wantDetail:  "2 rows",
			checks: func(t *testing.T, rows []dividendRow) {
				if len(rows) != 2 {
					t.Fatalf("want 2 rows, got %d", len(rows))
				}
				// First part: 0.50 * (1.125 / 0.75) = 0.75
				if rows[0].AmountAUD != 0.75 {
					t.Errorf("rows[0].AmountAUD: want 0.75, got %f", rows[0].AmountAUD)
				}
				if rows[0].Type != "ordinary" {
					t.Errorf("rows[0].Type: want ordinary, got %s", rows[0].Type)
				}
				// Second part: 0.25 * (1.125 / 0.75) = 0.375
				if rows[1].AmountAUD != 0.375 {
					t.Errorf("rows[1].AmountAUD: want 0.375, got %f", rows[1].AmountAUD)
				}
				if rows[1].Type != "special" {
					t.Errorf("rows[1].Type: want special, got %s", rows[1].Type)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rows, outcome, detail := dividendRowsFor(tt.notice, tt.pending)
			if outcome != tt.wantOutcome {
				t.Errorf("outcome: want %q, got %q", tt.wantOutcome, outcome)
			}
			if outcome == "parsed" && detail != tt.wantDetail {
				t.Errorf("detail: want %q, got %q", tt.wantDetail, detail)
			}
			if len(rows) != tt.wantRows {
				t.Errorf("rows: want %d, got %d", tt.wantRows, len(rows))
			}
			if tt.checks != nil {
				tt.checks(t, rows)
			}
		})
	}
}

// fakeStore implements dividendNoticeStore for testing.
type fakeStore struct {
	pending  []pendingNotice
	upserts  []dividendRow
	attempts []noticeAttempt
	failURL  string // if set, UpsertDividends fails for this URL
	// evidence is what EstimateEvidence returns, by notice URL; asked records
	// the security code and URL of every call.
	evidence map[string]estimateEvidence
	asked    []string
	// confirmed records UpsertConfirmedEstimates' rows; declaredArrived makes
	// it write none, as when a declared row lands after the evidence is read.
	confirmed       []dividendRow
	declaredArrived bool
}

func (s *fakeStore) EstimateEvidence(_ context.Context, n DividendNotice, p pendingNotice) (estimateEvidence, error) {
	s.asked = append(s.asked, n.SecurityCode+" "+p.URL)
	return s.evidence[p.URL], nil
}

func (s *fakeStore) UpsertConfirmedEstimates(_ context.Context, rows []dividendRow) (int, error) {
	if s.declaredArrived {
		return 0, nil
	}
	s.confirmed = append(s.confirmed, rows...)
	return len(rows), nil
}

func (s *fakeStore) PendingDividendNotices(ctx context.Context, limit int, parserVersion int) ([]pendingNotice, error) {
	return s.pending, nil
}

func (s *fakeStore) UpsertDividends(ctx context.Context, rows []dividendRow) (int, error) {
	// If any row matches failURL, fail
	for _, r := range rows {
		if r.AnnouncementURL == s.failURL {
			return 0, fmt.Errorf("simulated error for %s", s.failURL)
		}
	}
	s.upserts = append(s.upserts, rows...)
	return len(rows), nil
}

func (s *fakeStore) RecordNoticeAttempt(ctx context.Context, a noticeAttempt) error {
	s.attempts = append(s.attempts, a)
	return nil
}

// TestRunDividendNoticePass tests the full pass with a fake store.
func TestRunDividendNoticePass(t *testing.T) {
	testsDir := "testdata/dividend_notices"

	loadFixture := func(filename string) string {
		path := filepath.Join(testsDir, filename)
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("load %s: %v", filename, err)
		}
		return string(b)
	}

	// Create fake store
	fakeStoreImpl := &fakeStore{
		pending: []pendingNotice{
			{
				StockCode:        "CBA",
				AnnouncementDate: "2026-08-12",
				Headline:         "Dividend/Distribution - CBA",
				URL:              "https://cba_final.pdf",
			},
			{
				StockCode:        "TST",
				AnnouncementDate: "2026-09-01",
				Headline:         "Dividend/Distribution - TST",
				URL:              "https://vanguard.pdf", // Known to be Vanguard letter, not 3A.1
			},
			{
				StockCode:        "TST",
				AnnouncementDate: "2026-09-02",
				Headline:         "Dividend/Distribution - TST",
				URL:              "https://empty.pdf", // Will return empty text
			},
			{
				StockCode:        "BHP",
				AnnouncementDate: "2026-08-18",
				Headline:         "Dividend/Distribution - BHP",
				URL:              "https://bhp_final.pdf",
			},
			{
				StockCode:        "SUN",
				AnnouncementDate: "2026-08-12",
				Headline:         "Dividend/Distribution - SUN",
				URL:              "https://sun_final.pdf",
			},
		},
	}

	store := dividendNoticeStore(fakeStoreImpl)

	// Mock text fetcher that returns fixture content
	textFunc := func(ctx context.Context, url string) string {
		if strings.Contains(url, "cba_final") {
			return loadFixture("cba_final_2026-08-12.txt")
		}
		if strings.Contains(url, "vanguard") {
			return "Vanguard Group Inc" // Not a 3A.1, will fail parse
		}
		if strings.Contains(url, "empty") {
			return ""
		}
		if strings.Contains(url, "bhp_final") {
			return loadFixture("bhp_final_2026-08-18.txt")
		}
		if strings.Contains(url, "sun_final") {
			return loadFixture("sun_final_2026-08-12.txt")
		}
		return ""
	}

	result, err := runDividendNoticePass(context.Background(), store, textFunc, 10, 1, 0, false, t.Logf)
	if err != nil {
		t.Fatalf("runDividendNoticePass: %v", err)
	}

	// Verify result counts
	if result.Selected != 5 {
		t.Errorf("Selected: want 5, got %d", result.Selected)
	}
	if result.Parsed != 2 {
		t.Errorf("Parsed: want 2, got %d", result.Parsed)
	}
	if result.Rows != 3 { // CBA (1) + SUN (2)
		t.Errorf("Rows: want 3, got %d", result.Rows)
	}

	// Verify outcomes
	expectedOutcomes := map[string]int{
		"parsed":                  2,
		"not_appendix_3a1":        1,
		"no_text":                 1,
		"awaiting_aud_equivalent": 1,
	}
	if len(result.Outcomes) != len(expectedOutcomes) {
		t.Errorf("outcomes count: want %d, got %d", len(expectedOutcomes), len(result.Outcomes))
	}
	for outcome, want := range expectedOutcomes {
		if got, ok := result.Outcomes[outcome]; !ok || got != want {
			t.Errorf("outcomes[%s]: want %d, got %d", outcome, want, got)
		}
	}

	// Verify no store_error (all succeeded or were recorded)
	if err, ok := result.Outcomes["store_error"]; ok && err > 0 {
		t.Errorf("store_error: want 0, got %d", err)
	}

	// Verify upserts happened for CBA and SUN
	if len(fakeStoreImpl.upserts) != 3 { // 1 + 2
		t.Errorf("upserts: want 3 rows, got %d", len(fakeStoreImpl.upserts))
	}

	// Verify 5 attempts recorded (one per notice)
	if len(fakeStoreImpl.attempts) != 5 {
		t.Errorf("attempts: want 5, got %d", len(fakeStoreImpl.attempts))
	}
}

// TestDividendNoticeSQL validates the SQL consts match expected shapes.
func TestDividendNoticeSQL(t *testing.T) {
	// Verify pending query excludes recent no_text attempts
	if !strings.Contains(pendingNoticesSql, "t.outcome = 'no_text' AND t.attempted_at < now() - interval '7 days'") {
		t.Error("pending SQL missing 7-day no_text exclusion")
	}

	// Verify pending query checks parser_version for retryable outcomes
	if !strings.Contains(pendingNoticesSql, "t.parser_version < $2") {
		t.Error("pending SQL missing parser_version check")
	}

	// Every failure an older parser recorded is read again, not a named few
	// (a list once missed foreign_multi_part, the outcome version 2 removed).
	// A notice paid only in securities is final, like a cancellation.
	if !strings.Contains(pendingNoticesSql, "t.outcome NOT IN ('parsed', 'cancellation', 'scrip_only', 'no_text') AND t.parser_version < $2") {
		t.Error("pending SQL must re-select every failure recorded by an older parser version")
	}

	// Verify pending orders by date DESC
	if !strings.Contains(pendingNoticesSql, "ORDER BY announcement_date DESC") {
		t.Error("pending SQL not ordering by announcement_date DESC")
	}

	// Every code that listed a PDF travels with it, for listedAs.
	if !strings.Contains(pendingNoticesSql, "array_agg(a.stock_code) OVER (PARTITION BY a.pdf_url) AS listed_codes") {
		t.Error("pending SQL must carry every code that listed the notice")
	}

	// Verify attempt SQL writes parser_version
	if !strings.Contains(recordAttemptSql, "parser_version") {
		t.Error("recordAttempt SQL missing parser_version")
	}

	// Verify upsert has announced_on comparison
	if !strings.Contains(upsertDividendSql, "EXCLUDED.announced_on >= dividend_history.announced_on") {
		t.Error("upsert SQL missing announced_on comparison")
	}

	// An estimated_only notice is read again once its due date has passed and
	// a results document of its code has been extracted since; a detail with
	// no due date never selects it.
	for _, want := range []string{
		"AND NOT (t.outcome = 'estimated_only'",
		"COALESCE(substring(t.detail from 'due ([0-9]{4}-[0-9]{2}-[0-9]{2})') < to_char(current_date, 'YYYY-MM-DD'), false)",
		"e.stock_code = t.stock_code AND e.extracted_at > t.attempted_at",
		"e.metrics ? 'dividend' AND e.document_meta ? 'period_end'",
	} {
		if !strings.Contains(pendingNoticesSql, want) {
			t.Errorf("pending SQL lacks %q", want)
		}
	}

	// A confirmed estimate replaces only its own row or an earlier confirmed
	// estimate: never a declared row, NULL announced_on included.
	for _, want := range []string{
		"WHERE dividend_history.announcement_url = EXCLUDED.announcement_url",
		"dividend_history.announced_on < EXCLUDED.announced_on",
		"t.outcome = 'parsed' AND t.detail LIKE '%estimate confirmed by%'",
	} {
		if !strings.Contains(upsertConfirmedEstimateSql, want) {
			t.Errorf("confirmed-estimate upsert lacks %q", want)
		}
	}
	if strings.Contains(upsertConfirmedEstimateSql, "IS NULL") || strings.Contains(upsertConfirmedEstimateSql, ">=") {
		t.Error("the confirmed-estimate upsert must not replace a row with no announced_on or one announced the same day")
	}
	// The documents are the notice's own security code's, never a listing's.
	if !strings.Contains(estimateDocumentsSql, "WHERE e.stock_code = $1 AND e.metrics ? 'dividend'") {
		t.Error("estimate documents must be read by the notice's security code")
	}
	if !strings.Contains(estimateStoredSql, "t.detail LIKE '%estimate confirmed by%'") {
		t.Error("stored rows must say whether they are confirmed estimates")
	}
	// Exercised against Postgres in TestEstimateEvidenceAgainstPostgres; these
	// pin the predicates where no database is set.
	for _, want := range []string{
		"WHERE d.stock_code = $1 AND (d.ex_date = $2::date OR d.period_end = NULLIF($3, '')::date)",
		"d.ex_date::text",
	} {
		if !strings.Contains(estimateStoredSql, want) {
			t.Errorf("stored rows SQL lacks %q", want)
		}
	}
	for _, want := range []string{
		"a.announcement_date >= $3::date",
		"a.pdf_url <> $1",
		"max(a.announcement_date) AS announced",
		"d.announcement_url = l.pdf_url AND d.stock_code = $2",
		"(d.ex_date = $4::date OR d.period_end = NULLIF($5, '')::date AND d.dividend_type = ANY($6::text[]))",
	} {
		if !strings.Contains(estimateLaterNoticesSql, want) {
			t.Errorf("later notices SQL lacks %q", want)
		}
	}

	// GMG's v5 attempt (2026-10-12 11:29 UTC) is later than its 4E's
	// extraction (2026-10-11 14:12 UTC): the re-read trigger alone never
	// selects it, the bump to 6 does.
	if dividendNoticeParserVersion < 6 {
		t.Errorf("dividendNoticeParserVersion = %d; parser 6 must re-read every estimated_only notice", dividendNoticeParserVersion)
	}
}

// A notice that waits on its update records the ex-date and the date the
// notice promises the update by, which the data review reads: BHP's USD final
// (2A.9b, its AUD equivalent) and DN1's estimate (3A.1a(i), its actual amount).
func TestWaitingNoticesRecordTheirPromisedDates(t *testing.T) {
	for _, tc := range []struct{ file, outcome, detail string }{
		{"bhp_final_2026-08-18.txt", "awaiting_aud_equivalent", "ex 2026-09-03; AUD equivalent due 2026-09-07"},
		{"dn1_estimated_2026-09-07.txt", "estimated_only", "ex 2026-09-11; actual amount due 2026-09-18"},
		// LRT's final update answers "Actual" once and "Estimated" once, with
		// 3A.1b blank: its amount stays an estimate (estimatesAreActual).
		{"lrt_update_2026-07-31.txt", "estimated_only", "ex 2026-06-30; actual amount due 2026-07-31"},
	} {
		body, err := os.ReadFile(filepath.Join("testdata", "dividend_notices", tc.file))
		if err != nil {
			t.Fatal(err)
		}
		n, parsed, why := parseDividendNotice(string(body))
		if parsed != noticeParsed {
			t.Fatalf("%s: %s (%s)", tc.file, parsed, why)
		}
		rows, outcome, detail := dividendRowsFor(n, pendingNotice{StockCode: n.SecurityCode, URL: tc.file})
		if len(rows) != 0 || outcome != tc.outcome || detail != tc.detail {
			t.Errorf("%s: %d rows, %q, %q; want 0, %q, %q", tc.file, len(rows), outcome, detail, tc.outcome, tc.detail)
		}
	}
	// A notice that states no date still names its ex-date.
	if got := waitingDetail(DividendNotice{ExDate: "2026-10-12"}, "actual amount", ""); got != "ex 2026-10-12" {
		t.Errorf("waitingDetail without a date = %q", got)
	}
}

// ASX lists a renamed company's announcements under its old code and its new
// one: Rivco Australia's notice (RIV, formerly Duxton Water, D2O) under both.
// Read under D2O it is stored under RIV, and its attempt names RIV. A notice
// whose code no listing shares is still withheld, naming every listing.
func TestNoticeIsReadUnderTheCodeItNames(t *testing.T) {
	for _, tc := range []struct {
		security string
		p        pendingNotice
		want     string
	}{
		{"CBAPI", pendingNotice{StockCode: "CBA"}, "CBA"},
		{"RIV", pendingNotice{StockCode: "D2O", ListedCodes: []string{"D2O", "RIV"}}, "RIV"},
		{"WPL", pendingNotice{StockCode: "WDS", ListedCodes: []string{"WDS", "WPL"}}, "WPL"}, // an old notice names the old code
		{"CBA", pendingNotice{StockCode: "WBC", ListedCodes: []string{"WBC"}}, "WBC"},
	} {
		if got := tc.p.listedAs(tc.security).StockCode; got != tc.want {
			t.Errorf("%s listed under %v: read under %s, want %s", tc.security, tc.p.ListedCodes, got, tc.want)
		}
	}

	load := func(name string) string {
		b, err := os.ReadFile(filepath.Join("testdata", "dividend_notices", name))
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	riv, cba := load("riv_dividend_2026-08-28.txt"), load("cba_final_2026-08-12.txt")
	store := &fakeStore{pending: []pendingNotice{
		{StockCode: "D2O", ListedCodes: []string{"D2O", "RIV"}, AnnouncementDate: "2026-08-28", URL: "https://riv.pdf"},
		{StockCode: "NNC", ListedCodes: []string{"NNC", "WBC"}, AnnouncementDate: "2026-08-12", URL: "https://cba.pdf"},
	}}
	text := func(_ context.Context, url string) string {
		if strings.Contains(url, "riv") {
			return riv
		}
		return cba
	}
	if _, err := runDividendNoticePass(context.Background(), store, text, 10, 1, 0, false, t.Logf); err != nil {
		t.Fatal(err)
	}
	if len(store.upserts) != 1 {
		t.Fatalf("want RIV's one row, got %+v", store.upserts)
	}
	if r := store.upserts[0]; r.StockCode != "RIV" || r.ExDate != "2026-10-15" || r.AmountAUD != 0.018 {
		t.Errorf("row = %s ex %s A$%v, want RIV ex 2026-10-15 A$0.018", r.StockCode, r.ExDate, r.AmountAUD)
	}
	want := []noticeAttempt{
		{URL: "https://riv.pdf", StockCode: "RIV", Outcome: "parsed", Detail: "1 rows", ParserVersion: dividendNoticeParserVersion},
		{URL: "https://cba.pdf", StockCode: "NNC", Outcome: "code_mismatch", Detail: "notice is for CBA, listed under NNC, WBC", ParserVersion: dividendNoticeParserVersion},
	}
	if !slices.Equal(store.attempts, want) {
		t.Errorf("attempts = %+v\nwant %+v", store.attempts, want)
	}
}

// Parser 5's notices, end to end: what each stores and what its attempt
// records. LED's finalisation and Storage King's update state no security
// code and are listed under the old code first; AFP's total leaves its NZ
// supplementary out; BCN pays cash and Forrestania shares, and only the cash
// is a dividend; VMC pays only in shares.
func TestWhatParser5NoticesStore(t *testing.T) {
	franked := func(f float64) *float64 { return &f }
	for _, tc := range []struct {
		file    string
		p       pendingNotice
		rows    []dividendRow
		attempt noticeAttempt
	}{
		{
			file: "led_update_2026-08-26.txt",
			p:    pendingNotice{StockCode: "ECF", ListedCodes: []string{"ECF", "LED"}, AnnouncementDate: "2026-08-26", URL: "led"},
			rows: []dividendRow{{StockCode: "LED", ExDate: "2026-06-30", RecordDate: "2026-07-01", PaymentDate: "2026-08-31", PeriodEnd: "2026-06-30",
				AmountAUD: 0.01625, FrankedPct: franked(0), Type: "ordinary", DeclaredCurrency: "AUD", DeclaredAmount: 0.01625, AnnouncementURL: "led", AnnouncedOn: "2026-08-26"}},
			attempt: noticeAttempt{URL: "led", StockCode: "LED", Outcome: "parsed", Detail: "1 rows"},
		},
		{
			file: "skg_update_2026-08-14.txt",
			p:    pendingNotice{StockCode: "ASK", ListedCodes: []string{"ASK", "SKG"}, AnnouncementDate: "2026-08-14", URL: "skg"},
			rows: []dividendRow{{StockCode: "SKG", ExDate: "2026-06-30", RecordDate: "2026-07-01", PaymentDate: "2026-08-31", PeriodEnd: "2026-06-30",
				AmountAUD: 0.031, FrankedPct: franked(25), Type: "ordinary", DeclaredCurrency: "AUD", DeclaredAmount: 0.031, AnnouncementURL: "skg", AnnouncedOn: "2026-08-14"}},
			attempt: noticeAttempt{URL: "skg", StockCode: "SKG", Outcome: "parsed", Detail: "1 rows"},
		},
		{
			file: "afp_update_2026-06-24.txt",
			p:    pendingNotice{StockCode: "AFP", ListedCodes: []string{"AFP"}, AnnouncementDate: "2026-06-24", URL: "afp"},
			rows: []dividendRow{{StockCode: "AFP", ExDate: "2026-06-18", RecordDate: "2026-06-19", PaymentDate: "2026-07-03", PeriodEnd: "2026-03-31",
				AmountAUD: 0.0201525, FrankedPct: franked(0), Type: "ordinary", DeclaredCurrency: "NZD", DeclaredAmount: 0.025, AnnouncementURL: "afp", AnnouncedOn: "2026-06-24"}},
			attempt: noticeAttempt{URL: "afp", StockCode: "AFP", Outcome: "parsed", Detail: "1 rows"},
		},
		{
			file: "bcn_update_2026-07-16.txt",
			p:    pendingNotice{StockCode: "BCN", ListedCodes: []string{"BCN"}, AnnouncementDate: "2026-07-16", URL: "bcn"},
			rows: []dividendRow{{StockCode: "BCN", ExDate: "2026-07-13", RecordDate: "2026-07-14", PaymentDate: "2026-07-21", PeriodEnd: "2026-06-30",
				AmountAUD: 0.10, FrankedPct: franked(100), Type: "ordinary", DeclaredCurrency: "AUD", DeclaredAmount: 0.10, AnnouncementURL: "bcn", AnnouncedOn: "2026-07-16"}},
			attempt: noticeAttempt{URL: "bcn", StockCode: "BCN", Outcome: "parsed", Detail: "1 rows"},
		},
		{
			file:    "vmc_dividend_2026-07-06.txt",
			p:       pendingNotice{StockCode: "VMC", ListedCodes: []string{"VMC"}, AnnouncementDate: "2026-07-06", URL: "vmc"},
			attempt: noticeAttempt{URL: "vmc", StockCode: "VMC", Outcome: "scrip_only", Detail: "paid in securities: AUD 0.046961 a security"},
		},
	} {
		body, err := os.ReadFile(filepath.Join("testdata", "dividend_notices", tc.file))
		if err != nil {
			t.Fatal(err)
		}
		store := &fakeStore{pending: []pendingNotice{tc.p}}
		text := func(context.Context, string) string { return string(body) }
		if _, err := runDividendNoticePass(context.Background(), store, text, 10, 1, 0, false, t.Logf); err != nil {
			t.Fatal(err)
		}
		if len(store.upserts) != len(tc.rows) {
			t.Errorf("%s: rows = %+v, want %+v", tc.file, store.upserts, tc.rows)
		}
		for i := range min(len(store.upserts), len(tc.rows)) {
			got, want := store.upserts[i], tc.rows[i]
			if (got.FrankedPct == nil) != (want.FrankedPct == nil) || got.FrankedPct != nil && *got.FrankedPct != *want.FrankedPct {
				t.Errorf("%s: franked %v, want %v", tc.file, got.FrankedPct, want.FrankedPct)
			}
			got.FrankedPct, want.FrankedPct = nil, nil
			if got != want {
				t.Errorf("%s: row\n got %+v\nwant %+v", tc.file, got, want)
			}
		}
		tc.attempt.ParserVersion = dividendNoticeParserVersion
		if !slices.Equal(store.attempts, []noticeAttempt{tc.attempt}) {
			t.Errorf("%s: attempts = %+v, want %+v", tc.file, store.attempts, tc.attempt)
		}
	}
}

// A hybrid's notice is filed under its own code (CBAPI). With 1.6 and the
// summary's security line blank, it is not filed under its issuer's code,
// though 1.3 names CBA and it has a Part 3A: it would read as CBA's ordinary
// dividend.
func TestAHybridWithoutASecurityCodeIsNotFiledUnderItsIssuer(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("testdata", "dividend_notices", "cbapi_2026-09-17.txt"))
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Replace(string(body), "CBAPI - CAP NOTE 3-BBSW+3.00% PERP NON-CUM RED T-04-27", "", 1)
	text = strings.Replace(text, "1.6 ASX +Security Code\nCBAPI", "1.6 ASX +Security Code\n", 1)
	if text == string(body) || strings.Contains(text, "\nCBAPI\n") {
		t.Fatal("the fixture changed: blank its security code another way")
	}
	if _, outcome, detail := parseDividendNotice(text); outcome != noticeMissingField || detail != "security code" {
		t.Errorf("outcome %s (%s), want missing_field (security code)", outcome, detail)
	}
}

// Parser 6: an estimate is stored once the issuer's own results document
// confirms it. The notices and documents are prod's (testdata/dividend_notices,
// and testdata/results_documents: financial_report_extractions rows as stored,
// 2026-10-13).

const asxAnnouncement = "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId="

func loadNotice(t *testing.T, file string) DividendNotice {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "dividend_notices", file))
	if err != nil {
		t.Fatal(err)
	}
	n, outcome, why := parseDividendNotice(string(b))
	if outcome != noticeParsed {
		t.Fatalf("%s: %s (%s)", file, outcome, why)
	}
	return n
}

func loadResultsDocument(t *testing.T, file string) ResultsDocument {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "results_documents", file))
	if err != nil {
		t.Fatal(err)
	}
	var d ResultsDocument
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatalf("%s: %v", file, err)
	}
	return d
}

// asEstimate is a real notice turned into an estimate whose actual amount is
// due on due: a case prod has no estimate for (a hybrid, a special with no
// 2A.3, a notice whose results document states the comparative year).
func asEstimate(n DividendNotice, due string) DividendNotice {
	n.ActualDue = due
	n.Parts = slices.Clone(n.Parts)
	for i := range n.Parts {
		n.Parts[i].Estimated = true
	}
	return n
}

// withEntries is a document whose dividend class holds entries.
func withEntries(t *testing.T, d ResultsDocument, entries ...map[string]any) ResultsDocument {
	t.Helper()
	b, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	d.Dividend = b
	return d
}

// withMeta is a document whose document_meta is meta.
func withMeta(d ResultsDocument, meta string) ResultsDocument {
	d.DocumentMeta = json.RawMessage(meta)
	return d
}

// agreed is a dividend entry as the extractor writes one both models agree on.
func agreed(quote, cents string) map[string]any {
	return map[string]any{"unit": "cents", "basis": "statutory", "consensus": "agree", "alignment": "match_fuzzy",
		"source_text": quote, "value_cents": cents}
}

// GMG lodges one estimate a half and never an update. Its notice of
// 2026-06-16 estimates AUD 0.15, unfranked, actual due 2026-08-20; its
// Appendix 4E of that day states "Final dividend and distribution proposed
// per GMG security (cents) 15.0". The estimate is stored, the attempt names
// the 4E, and the store is asked about GMG's own code.
func TestAnEstimateItsResultsDocumentConfirmsIsStored(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("testdata", "dividend_notices", "gmg_estimate_2026-06-16.txt"))
	if err != nil {
		t.Fatal(err)
	}
	notice := asxAnnouncement + "03104557"
	fourE := loadResultsDocument(t, "gmg_03127287.json")
	store := &fakeStore{
		pending:  []pendingNotice{{StockCode: "GMG", ListedCodes: []string{"GMG"}, AnnouncementDate: "2026-06-16", URL: notice}},
		evidence: map[string]estimateEvidence{notice: {Documents: []ResultsDocument{fourE}}},
	}
	res, err := runDividendNoticePass(context.Background(), store, func(context.Context, string) string { return string(body) }, 10, 1, 0, false, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	if res.Parsed != 1 || res.Rows != 1 || len(store.upserts) != 0 {
		t.Errorf("parsed %d (%d rows), declared upserts %+v; want 1 (1 row) and none", res.Parsed, res.Rows, store.upserts)
	}
	if len(store.confirmed) != 1 {
		t.Fatalf("confirmed rows = %+v, want GMG's one", store.confirmed)
	}
	got := store.confirmed[0]
	if got.FrankedPct == nil || *got.FrankedPct != 0 {
		t.Errorf("franked %v, want 0", got.FrankedPct)
	}
	got.FrankedPct = nil
	want := dividendRow{StockCode: "GMG", ExDate: "2026-06-29", RecordDate: "2026-06-30", PaymentDate: "2026-08-26", PeriodEnd: "2026-06-30",
		AmountAUD: 0.15, Type: "ordinary", DeclaredCurrency: "AUD", DeclaredAmount: 0.15, AnnouncementURL: notice, AnnouncedOn: "2026-06-16"}
	if got != want {
		t.Errorf("row\n got %+v\nwant %+v", got, want)
	}
	attempt := noticeAttempt{URL: notice, StockCode: "GMG", Outcome: "parsed",
		Detail:        "1 rows; estimate confirmed by " + asxAnnouncement + "03127287; actual amount due 2026-08-20",
		ParserVersion: dividendNoticeParserVersion}
	if !slices.Equal(store.attempts, []noticeAttempt{attempt}) {
		t.Errorf("attempts = %+v\nwant %+v", store.attempts, attempt)
	}
	if !slices.Equal(store.asked, []string{"GMG " + notice}) {
		t.Errorf("evidence asked for %q, want GMG's own code", store.asked)
	}

	// Dry run: the same decision, logged, nothing written.
	store = &fakeStore{pending: store.pending, evidence: store.evidence}
	var logged []string
	logf := func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) }
	if _, err := runDividendNoticePass(context.Background(), store, func(context.Context, string) string { return string(body) }, 10, 1, 0, true, logf); err != nil {
		t.Fatal(err)
	}
	if len(store.confirmed)+len(store.upserts)+len(store.attempts) != 0 {
		t.Errorf("dry run wrote %+v %+v %+v", store.confirmed, store.upserts, store.attempts)
	}
	if !slices.ContainsFunc(logged, func(l string) bool {
		return strings.HasPrefix(l, "DRY-RUN dividend: GMG ordinary ex 2026-06-29 A$0.150000") && strings.Contains(l, "estimate confirmed by "+asxAnnouncement+"03127287")
	}) {
		t.Errorf("dry run logged %q", logged)
	}
}

// Estimates a document must not confirm, and the gates that withhold them.
// Every reason is the one its gate gives, so a case that passed for another
// reason would fail.
func TestWhatConfirmsAnEstimate(t *testing.T) {
	const notConfirmed = "no agreed entry in a results document names the ordinary distribution for the period ending 2026-06-30"
	const noGMGDocument = "no document of GMG states period end 2026-06-30 and was filed from 2026-08-20 to 2026-10-31"
	gmg := loadNotice(t, "gmg_estimate_2026-06-16.txt")
	fourE := loadResultsDocument(t, "gmg_03127287.json")
	interim := agreed("Interim distribution per GMG security (cents)\n15.0", "15")
	final := agreed("Final dividend and distribution proposed per GMG security (cents)\n15.0", "15")
	gmgWith := func(change func(n *DividendNotice)) DividendNotice {
		n := gmg
		n.Parts = slices.Clone(gmg.Parts)
		change(&n)
		return n
	}
	gmgAt := func(amount float64) DividendNotice {
		return gmgWith(func(n *DividendNotice) { n.Parts[0].Amount, n.Total = amount, amount })
	}
	filed := func(d ResultsDocument, day string) ResultsDocument { d.ReportDate = day; return d }

	// A CBA final turned into an estimate due the day its results were filed;
	// read as CBAPI's, the code a hybrid's notice states while ASX lists it
	// under CBA.
	cba := asEstimate(loadNotice(t, "cba_final_2026-08-12.txt"), "2026-08-12")
	hybrid := cba
	hybrid.SecurityCode = "CBAPI"
	// CGS's June 2025 final, as an estimate of the A$0.04 its FY26 4E states
	// under the period end it gives, 2025-06-30: the comparative year's.
	cgs := asEstimate(loadNotice(t, "cgs_final_2025-08-22.txt"), "2025-08-22")
	cgs.Parts[0].Amount, cgs.Total = 0.04, 0.04
	// MOT estimated 2.88c at 0% franked and paid 3.00% franked; its 4E holds
	// only the year's 15.52. MOT-like: an entry for the June distribution that
	// states its franking.
	mot := loadNotice(t, "mot_estimate_2026-06-24.txt")
	motWith := func(franking string) ResultsDocument {
		e := agreed("Final distribution for June 2026 (cents per unit)\n2.88", "2.88")
		e["franking"] = franking
		return withEntries(t, loadResultsDocument(t, "mot_03148072.json"), e)
	}

	for _, tc := range []struct {
		name string
		n    DividendNotice
		docs []ResultsDocument
		want string // the reason; "" = confirmed
	}{
		{"GMG: its 4E's final distribution", gmg, []ResultsDocument{fourE}, ""},
		{"DXI: only its 30 September quarter's 4.150, a majority's", loadNotice(t, "dxi_estimate_2026-06-19.txt"),
			[]ResultsDocument{loadResultsDocument(t, "dxi_03124191.json")}, notConfirmed},
		{"DXS: an agreed 31 December entry and a majority's 30 June", loadNotice(t, "dxs_estimate_2026-06-23.txt"),
			[]ResultsDocument{loadResultsDocument(t, "dxs_03127378.json")}, notConfirmed},
		{"ABG: no entry names its own period's distribution", loadNotice(t, "abg_estimate_2026-06-18.txt"),
			[]ResultsDocument{loadResultsDocument(t, "abg_03129649.json")}, notConfirmed},
		{"LRT: one model's entry, in dollars, naming no period", loadNotice(t, "lrt_update_2026-07-31.txt"),
			[]ResultsDocument{loadResultsDocument(t, "lrt_03128332.json")}, notConfirmed},
		{"APA: the notice states no franking", loadNotice(t, "apa_estimate_2026-06-19.txt"),
			[]ResultsDocument{loadResultsDocument(t, "apa_03127268.json")}, "franking not stated (the API would serve it as 0%)"},
		{"the issuer's own code", cba, []ResultsDocument{loadResultsDocument(t, "cba_03124123.json")}, ""},
		{"a hybrid, against its issuer's results", hybrid, []ResultsDocument{loadResultsDocument(t, "cba_03124123.json")},
			"no document of CBAPI states period end 2026-06-30 and was filed from 2026-08-12 to 2026-10-31"},
		{"a special with no 2A.3", asEstimate(loadNotice(t, "waf_special_2026-09-09.txt"), "2026-09-30"), nil, "no 2A.3 period end"},
		{"a document whose period end is the comparative year's", cgs, []ResultsDocument{loadResultsDocument(t, "cgs_03126159.json")},
			"no document of CGS states period end 2025-06-30 and was filed from 2025-08-22 to 2025-10-31"},
		{"MOT-like: franked, where the notice says 0%", mot, []ResultsDocument{motWith("3% franked")},
			`03148072 states "Final distribution for June 2026 (cents per unit) 2.88", which states 3% franked, the notice 0%`},
		{"MOT-like: franking the rule cannot read", mot, []ResultsDocument{motWith("partially franked")},
			`03148072 states "Final distribution for June 2026 (cents per unit) 2.88", which states franking this rule cannot read`},
		{"MOT-like: an entry that states no franking (accepted)", mot, []ResultsDocument{motWith("null")}, ""},
		// Franking the quote states, where the notice says 0% (AMP's 4D: "Interim
		// dividend payable – franked at 20% 3.0 cents per share").
		{"a quote that says fully franked", gmg, []ResultsDocument{withEntries(t, fourE, agreed("Final dividend - fully franked (cents per share)\n15.0", "15"))},
			`03127287 states "Final dividend - fully franked (cents per share) 15.0", which states 100% franked, the notice 0%`},
		{"a quote that says franked at 20%", gmg, []ResultsDocument{withEntries(t, fourE, agreed("Final dividend payable – franked at 20% 15.0 cents per security", "15"))},
			`03127287 states "Final dividend payable – franked at 20% 15.0 cents per security", which states 20% franked, the notice 0%`},

		// The notice's gates: what no document can confirm.
		{"declared in NZD", gmgWith(func(n *DividendNotice) { n.Currency = "NZD" }), []ResultsDocument{fourE}, "declared in NZD, not AUD"},
		{"no date the actual amount is due", gmgWith(func(n *DividendNotice) { n.ActualDue = "" }), []ResultsDocument{fourE}, "no date the actual amount is due"},
		{"a part paid in securities", gmgWith(func(n *DividendNotice) { n.Scrip = 0.01 }), []ResultsDocument{fourE}, "part paid in securities"},
		{"a part that is actual", gmgWith(func(n *DividendNotice) { n.Parts[0].Estimated = false }), []ResultsDocument{fourE}, "a part is actual"},
		{"no amount", gmgAt(0), []ResultsDocument{fourE}, "no amount"},

		// The label gate, through the whole rule: last year's final, paid
		// before the period end, at the estimate's amount (TWD's FY26 4E states
		// "Final Dividend Paid 10 December 2025 10.5 cents").
		{"a final paid before the period end", gmg, []ResultsDocument{withEntries(t, fourE, agreed("Final Dividend Paid 10 December 2025 15.0 cents", "15"))}, notConfirmed},

		// Amounts compare as exact decimals: 1.3 cents is AUD 0.013 (MXT's
		// September 2026 distribution), which float64 does not see.
		{"1.3 cents is AUD 0.013", gmgAt(0.013), []ResultsDocument{withEntries(t, fourE, agreed("Final distribution per GMG security (cents)\n1.3", "1.3"))}, ""},
		{"1.3 cents is not AUD 0.0131", gmgAt(0.0131), []ResultsDocument{withEntries(t, fourE, agreed("Final distribution per GMG security (cents)\n1.3", "1.3"))},
			`03127287 states "Final distribution per GMG security (cents) 1.3": 0.01300000 a security, not the estimate's 0.01310000`},

		// The contradiction gate: every agreed entry that names the
		// distribution, in every qualifying document.
		{"an interim at another amount is another distribution", gmg,
			[]ResultsDocument{withEntries(t, fourE, agreed("Interim distribution per GMG security (cents)\n14.0", "14"), final)}, ""},
		{"another agreed final at another amount", gmg,
			[]ResultsDocument{withEntries(t, fourE, interim, final, agreed("Final distribution per GMG security (cents)\n15.5", "15.5"))},
			`03127287 states "Final distribution per GMG security (cents) 15.5": 0.15500000 a security, not the estimate's 0.15000000`},
		// ...also per "fully paid" security, a class and no payment: were the
		// label gate to withhold it, it would not count against the estimate.
		{"another agreed final at another amount, per fully paid security", gmg,
			[]ResultsDocument{withEntries(t, fourE, interim, final,
				agreed("Final distribution of 15.5 cents per fully paid stapled security for the year ended 30 June 2026", "15.5"))},
			`03127287 states "Final distribution of 15.5 cents per fully paid stapled security for the year e…": ` +
				`0.15500000 a security, not the estimate's 0.15000000`},
		{"a majority's final at another amount does not count", gmg,
			[]ResultsDocument{withEntries(t, fourE, final, map[string]any{"unit": "cents", "consensus": "majority",
				"source_text": "Final distribution per GMG security (cents)\n15.5", "value_cents": "15.5"})}, ""},
		{"a final with no amount per security", gmg,
			[]ResultsDocument{withEntries(t, fourE, final, map[string]any{"unit": "dollars", "consensus": "agree",
				"source_text": "Final distribution\n$0.16", "value_dollars": "0.16"})},
			`03127287 states "Final distribution $0.16" with no amount per security`},
		{"an annual report of the same year contradicts its 4E", gmg,
			[]ResultsDocument{fourE, withEntries(t, filed(fourE, "2026-09-16"), agreed("Final distribution per GMG security (cents)\n16.0", "16"))},
			`03127287 states "Final distribution per GMG security (cents) 16.0": 0.16000000 a security, not the estimate's 0.15000000`},
		{"one model's final only", gmg, []ResultsDocument{withEntries(t, fourE, map[string]any{"unit": "cents", "consensus": "primary_only",
			"source_text": "Final dividend and distribution proposed per GMG security (cents)\n15.0", "value_cents": "15"})}, notConfirmed},
		{"a legacy entry with no consensus", gmg, []ResultsDocument{withEntries(t, fourE, map[string]any{
			"source_text": "Final dividend and distribution proposed per GMG security (cents)\n15.0", "value_cents": "15"})}, notConfirmed},
		{"an unaligned entry", gmg, []ResultsDocument{withEntries(t, fourE, map[string]any{"unit": "cents", "consensus": "agree", "alignment": "unaligned",
			"source_text": "Final dividend and distribution proposed per GMG security (cents)\n15.0", "value_cents": "15"})}, notConfirmed},
		{"a presentation's entry contradicts but never confirms", gmg,
			[]ResultsDocument{func() ResultsDocument { d := fourE; d.Title = "FY26 Results Presentation"; return d }()}, notConfirmed},

		// The document's gates.
		{"filed the day before the due date", gmg, []ResultsDocument{filed(fourE, "2026-08-19")}, noGMGDocument},
		{"filed 124 days after the period end", gmg, []ResultsDocument{filed(fourE, "2026-11-01")}, noGMGDocument},
		{"filed 123 days after the period end", gmg, []ResultsDocument{filed(fourE, "2026-10-31")}, ""},
		{"no filing date", gmg, []ResultsDocument{filed(fourE, "")}, noGMGDocument},
		{"another period end", gmg, []ResultsDocument{withMeta(fourE, `{"period_end": "2025-06-30", "period_type": "annual", "report_kind": "appendix_4e"}`)}, noGMGDocument},
		{"no period end", gmg, []ResultsDocument{withMeta(fourE, `{"period_type": "annual", "report_kind": "appendix_4e"}`)}, noGMGDocument},
		{"no document_meta", gmg, []ResultsDocument{withMeta(fourE, `null`)}, noGMGDocument},
		{"another entity's document", gmg, []ResultsDocument{withMeta(fourE, `{"entity": "Charter Hall Limited", "period_end": "2026-06-30", "period_type": "annual", "report_kind": "appendix_4e"}`)}, noGMGDocument},
		{"its own entity", gmg, []ResultsDocument{withMeta(fourE, `{"entity": "Goodman Group", "period_end": "2026-06-30", "period_type": "annual", "report_kind": "appendix_4e"}`)}, ""},
		{"stated in US dollars", gmg, []ResultsDocument{withMeta(fourE, `{"currency": "USD", "period_end": "2026-06-30", "period_type": "annual", "report_kind": "appendix_4e"}`)}, noGMGDocument},
		{"another code's document", gmg, []ResultsDocument{func() ResultsDocument { d := fourE; d.StockCode = "GMGO"; return d }()}, noGMGDocument},
		{"a half-year document's final", gmg, []ResultsDocument{withMeta(withEntries(t, fourE, final), `{"period_end": "2026-06-30", "period_type": "half", "report_kind": "appendix_4d"}`)}, notConfirmed},
		{"a half-year document's interim", gmg, []ResultsDocument{withMeta(withEntries(t, fourE, interim), `{"period_end": "2026-06-30", "period_type": "half", "report_kind": "appendix_4d"}`)}, ""},
		{"a document whose period is not stated", gmg, []ResultsDocument{withMeta(fourE, `{"period_end": "2026-06-30"}`)}, notConfirmed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := ConfirmEstimate(tc.n, tc.docs)
			if c.Reason != tc.want {
				t.Errorf("reason %q\n       want %q", c.Reason, tc.want)
			}
			if c.Confirmed() != (tc.want == "") {
				t.Errorf("confirmed %v with reason %q", c.Confirmed(), c.Reason)
			}
		})
	}

	// What confirmed GMG: the final, never the interim it equals.
	c := ConfirmEstimate(gmg, []ResultsDocument{fourE})
	if want := []EstimateMatch{{Type: "ordinary", Document: fourE.URL, Quote: "Final dividend and distribution proposed per GMG security (cents)\n15.0"}}; !slices.Equal(c.Matches, want) {
		t.Errorf("matches %+v, want %+v", c.Matches, want)
	}
}

// What only the store knows: the notice is the latest for its dividend, and
// no row of it was stored from a declared amount.
func TestAStoredOrLaterDividendKeepsTheEstimateWaiting(t *testing.T) {
	gmg := loadNotice(t, "gmg_estimate_2026-06-16.txt")
	p := pendingNotice{StockCode: "GMG", AnnouncementDate: "2026-06-16", URL: asxAnnouncement + "03104557"}
	docs := []ResultsDocument{loadResultsDocument(t, "gmg_03127287.json")}
	later := func(outcome, detail string, stored bool) []laterNotice {
		return []laterNotice{{URL: asxAnnouncement + "03199999", AnnouncedOn: "2026-06-20", Outcome: outcome, Detail: detail, StoredDividend: stored}}
	}
	sameDay := func(ids string) []laterNotice {
		return []laterNotice{{URL: asxAnnouncement + ids, AnnouncedOn: "2026-06-16", Outcome: "estimated_only", Detail: "ex 2026-06-29; actual amount due 2026-08-20"}}
	}
	stored := func(ids, exDate, announcedOn string, confirmed bool) []storedDividend {
		return []storedDividend{{Type: "ordinary", ExDate: exDate, AnnouncementURL: asxAnnouncement + ids, AnnouncedOn: announcedOn, ConfirmedEstimate: confirmed}}
	}
	for _, tc := range []struct {
		name   string
		later  []laterNotice
		stored []storedDividend
		want   string // the reason; "" = stored
	}{
		{"nothing since", nil, nil, ""},
		// A day's notices are ordered by their ASX idsId (PCI lodged 03143304
		// and its update 03143500 on 2026-09-24).
		{"a notice lodged after it the same day", sameDay("03104558"), nil, "later notice 03104558 is estimated_only for the same ex-date"},
		{"a notice lodged before it the same day", sameDay("03104556"), nil, ""},
		{"a notice the same day whose idsId cannot be read", []laterNotice{{URL: "https://example.com/notice.pdf", AnnouncedOn: "2026-06-16", Outcome: "estimated_only",
			Detail: "ex 2026-06-29; actual amount due 2026-08-20"}}, nil, "later notice https://example.com/notice.pdf is estimated_only for the same ex-date"},
		{"a notice whose day is not known", []laterNotice{{URL: asxAnnouncement + "03104556", Outcome: "estimated_only", Detail: "ex 2026-06-29; actual amount due 2026-08-20"}}, nil,
			"later notice 03104556 is estimated_only for the same ex-date"},
		// LRT lodged three notices for one ex-date, each still an estimate:
		// only the last is ever confirmed.
		{"a later estimate of the same dividend", later("estimated_only", "ex 2026-06-29; actual amount due 2026-08-20", false), nil,
			"later notice 03199999 is estimated_only for the same ex-date"},
		{"the next half's estimate", later("estimated_only", "ex 2026-12-30; actual amount due 2027-02-18", false), nil, ""},
		{"a later notice not read yet", later("", "", false), nil, "later notice 03199999 has not been read"},
		{"a later notice that stored the dividend", later("parsed", "1 rows", true), nil, "later notice 03199999 stored the same dividend"},
		{"a later notice of another dividend", later("parsed", "1 rows", false), nil, ""},
		{"a later cancellation", later("cancellation", "", false), nil, "later notice 03199999 is cancellation, for an ex-date not recorded"},
		{"a later notice the parser could not read", later("inconsistent", "parts sum 0.14 != total 0.15", false), nil,
			"later notice 03199999 is inconsistent, for an ex-date not recorded"},
		{"a later notice of another security", later("code_mismatch", "notice is for GMGO, listed under GMG", false), nil, ""},
		{"a waiting notice recorded before parser 3", later("awaiting_aud_equivalent", "", false), nil,
			"later notice 03199999 is awaiting_aud_equivalent with no ex-date recorded"},
		// Change 11: a row stored from a declared amount is never replaced.
		{"the dividend stored from its update", nil, stored("03117622", "2026-06-29", "2026-07-23", false), "the ordinary dividend is stored from 03117622"},
		{"stored from an earlier declared notice", nil, stored("03100001", "2026-06-29", "2026-06-01", false), "the ordinary dividend is stored from 03100001"},
		{"a special stored for the same ex-date", nil, []storedDividend{{Type: "special", ExDate: "2026-06-29", AnnouncementURL: asxAnnouncement + "03100001", AnnouncedOn: "2026-06-01"}}, ""},
		{"an earlier confirmed estimate", nil, stored("03100001", "2026-06-29", "2026-06-01", true), ""},
		{"a confirmed estimate announced the same day", nil, stored("03104556", "2026-06-29", "2026-06-16", true), "the ordinary dividend is stored from 03104556"},
		{"a later confirmed estimate", nil, stored("03199999", "2026-06-29", "2026-06-20", true), "the ordinary dividend is stored from 03199999"},
		{"its own row", nil, []storedDividend{{Type: "ordinary", ExDate: "2026-06-29", AnnouncementURL: p.URL, AnnouncedOn: "2026-06-16", ConfirmedEstimate: true}}, ""},
		// The period's dividend under another ex-date: a re-lodged notice that
		// moved it (KME's 2026-09-30 and 10-01 are both stored). Writing would
		// store it twice, whichever notice stored the other row.
		{"the period's dividend stored under a moved ex-date", nil, stored("03117622", "2026-06-30", "2026-07-23", false),
			"the ordinary dividend for the period ending 2026-06-30 is stored from 03117622 (ex 2026-06-30)"},
		{"an earlier confirmed estimate under another ex-date", nil, stored("03100001", "2026-06-30", "2026-06-01", true),
			"the ordinary dividend for the period ending 2026-06-30 is stored from 03100001 (ex 2026-06-30)"},
		{"the period's special under another ex-date", nil, []storedDividend{{Type: "special", ExDate: "2026-06-30", AnnouncementURL: asxAnnouncement + "03117622", AnnouncedOn: "2026-07-23"}}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows, detail, why := confirmEstimatedNotice(gmg, p, estimateEvidence{Documents: docs, Stored: tc.stored, Later: tc.later})
			if why != tc.want {
				t.Errorf("reason %q, want %q", why, tc.want)
			}
			if stored := tc.want == ""; stored != (len(rows) == 1 && strings.HasPrefix(detail, "1 rows; estimate confirmed by ")) {
				t.Errorf("rows %+v, detail %q", rows, detail)
			}
		})
	}
}

// PCI lodged an estimate (03143304) and an update that is still an estimate
// (03143500, correcting the DRP election date) on 2026-09-24. Without an order
// within the day each counted as later than the other, and neither could ever
// be stored: the update is the later one by its idsId, so it withholds the
// first, and the first does not withhold it (it waits on its documents).
func TestNoticesLodgedTheSameDayAreOrderedByIdsId(t *testing.T) {
	estimate, update := asxAnnouncement+"03143304", asxAnnouncement+"03143500"
	texts := map[string]string{}
	for url, file := range map[string]string{estimate: "pci_estimate_2026-09-24.txt", update: "pci_update_2026-09-24.txt"} {
		b, err := os.ReadFile(filepath.Join("testdata", "dividend_notices", file))
		if err != nil {
			t.Fatal(err)
		}
		texts[url] = string(b)
	}
	waiting := "ex 2026-09-29; actual amount due " + loadNotice(t, "pci_update_2026-09-24.txt").ActualDue
	store := &fakeStore{
		pending: []pendingNotice{
			{StockCode: "PCI", ListedCodes: []string{"PCI"}, AnnouncementDate: "2026-09-24", URL: update},
			{StockCode: "PCI", ListedCodes: []string{"PCI"}, AnnouncementDate: "2026-09-24", URL: estimate},
		},
		evidence: map[string]estimateEvidence{
			estimate: {Later: []laterNotice{{URL: update, AnnouncedOn: "2026-09-24", Outcome: "estimated_only", Detail: waiting}}},
			update:   {Later: []laterNotice{{URL: estimate, AnnouncedOn: "2026-09-24", Outcome: "estimated_only", Detail: waiting}}},
		},
	}
	var logged []string
	logf := func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) }
	if _, err := runDividendNoticePass(context.Background(), store, func(_ context.Context, url string) string { return texts[url] }, 10, 1, 0, false, logf); err != nil {
		t.Fatal(err)
	}
	for url, want := range map[string]string{
		estimate: "not stored: later notice 03143500 is estimated_only for the same ex-date",
		update:   "not stored: no document of PCI states period end 2026-09-30",
	} {
		if !slices.ContainsFunc(logged, func(l string) bool {
			return strings.HasPrefix(l, "dividend notice "+url+": ") && strings.Contains(l, want)
		}) {
			t.Errorf("%s: logged %q, want a line with %q", documentRef(url), logged, want)
		}
	}

	p := pendingNotice{AnnouncementDate: "2026-09-24", URL: estimate}
	for _, tc := range []struct {
		name string
		l    laterNotice
		want bool
	}{
		{"its update, lodged after it", laterNotice{URL: update, AnnouncedOn: "2026-09-24"}, true},
		{"a notice of the next day", laterNotice{URL: asxAnnouncement + "03143001", AnnouncedOn: "2026-09-25"}, true},
		{"a notice lodged before it", laterNotice{URL: asxAnnouncement + "03143001", AnnouncedOn: "2026-09-24"}, false},
		{"a notice of the day before", laterNotice{URL: update, AnnouncedOn: "2026-09-23"}, false},
		{"a notice whose idsId cannot be read", laterNotice{URL: "https://example.com/notice.pdf", AnnouncedOn: "2026-09-24"}, true},
		{"a notice whose day is not known", laterNotice{URL: asxAnnouncement + "03143001"}, true},
	} {
		if got := lodgedAfter(tc.l, p); got != tc.want {
			t.Errorf("%s: lodgedAfter = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// recordingDB answers every query with no rows and records each statement
// with its arguments.
type recordingDB struct{ calls []recordedStatement }

type recordedStatement struct {
	SQL  string
	Args []any
}

func (db *recordingDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	db.calls = append(db.calls, recordedStatement{sql, args})
	return noRows{}, nil
}

func (db *recordingDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	db.calls = append(db.calls, recordedStatement{sql, args})
	return pgconn.CommandTag{}, nil
}

// noRows is a pgx.Rows with no rows.
type noRows struct{}

func (noRows) Close()                                       {}
func (noRows) Err() error                                   { return nil }
func (noRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (noRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (noRows) Next() bool                                   { return false }
func (noRows) Scan(...any) error                            { return nil }
func (noRows) Values() ([]any, error)                       { return nil, nil }
func (noRows) RawValues() [][]byte                          { return nil }
func (noRows) TypeMap() *pgtype.Map                         { return pgtype.NewMap() }
func (noRows) Conn() *pgx.Conn                              { return nil }

// What EstimateEvidence asks, without a database: the documents and rows of
// the notice's own security code (a hybrid's, never the code it is listed
// under), the rows under its ex-date or for its 2A.3 period end, and the
// issuer's notices since the day it was listed (not the day the notice
// states: SUN's is listed here the day after), with the type of every part.
// A "" period end or an empty type list matches no row for the period; only
// the env-gated Postgres test would otherwise see it.
func TestEstimateEvidenceArguments(t *testing.T) {
	sun := asEstimate(loadNotice(t, "sun_final_2026-08-12.txt"), "2026-08-12") // an ordinary and a special part
	cbapi := asEstimate(loadNotice(t, "cbapi_2026-09-17.txt"), "2026-12-15")   // a hybrid, listed under CBA
	for _, tc := range []struct {
		name string
		n    DividendNotice
		p    pendingNotice
		want []recordedStatement
	}{
		{"SUN's final and special", sun, pendingNotice{StockCode: "SUN", AnnouncementDate: "2026-08-13", URL: "https://sun_final.pdf"}, []recordedStatement{
			{estimateDocumentsSql, []any{"SUN"}},
			{estimateStoredSql, []any{"SUN", "2026-08-17", "2026-06-30"}},
			{estimateLaterNoticesSql, []any{"https://sun_final.pdf", "SUN", "2026-08-13", "2026-08-17", "2026-06-30", []string{"ordinary", "special"}}},
		}},
		{"CBAPI, listed under CBA", cbapi, pendingNotice{StockCode: "CBA", AnnouncementDate: "2026-09-17", URL: "https://cbapi.pdf"}, []recordedStatement{
			{estimateDocumentsSql, []any{"CBAPI"}},
			{estimateStoredSql, []any{"CBAPI", "2026-12-04", "2026-12-15"}},
			{estimateLaterNoticesSql, []any{"https://cbapi.pdf", "CBAPI", "2026-09-17", "2026-12-04", "2026-12-15", []string{"ordinary"}}},
		}},
	} {
		db := &recordingDB{}
		if _, err := (&postgresDividendNoticeStore{db: db}).EstimateEvidence(context.Background(), tc.n, tc.p); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if !reflect.DeepEqual(db.calls, tc.want) {
			t.Errorf("%s: statements\n got %v\nwant %v", tc.name, db.calls, tc.want)
		}
	}
}

// A notice the documents do not confirm keeps its estimated_only attempt and
// the detail the data review reads; so does one whose row a declared notice
// stored after its evidence was read.
func TestAnEstimateNotStoredStillWaits(t *testing.T) {
	for _, tc := range []struct {
		name            string
		file, doc       string
		declaredArrived bool
		detail, logged  string
		asked           int
	}{
		{"DXI", "dxi_estimate_2026-06-19.txt", "dxi_03124191.json", false, "ex 2026-06-29; actual amount due 2026-08-12",
			"DXI's estimate ex 2026-06-29 not stored: no agreed entry in a results document names the ordinary distribution for the period ending 2026-06-30", 1},
		// No franking stated: no document can confirm it, so none is read.
		{"APA", "apa_estimate_2026-06-19.txt", "apa_03127268.json", false, "ex 2026-06-29; actual amount due 2026-08-20",
			"APA's estimate ex 2026-06-29 not stored: franking not stated (the API would serve it as 0%)", 0},
		{"a declared row stored meanwhile", "gmg_estimate_2026-06-16.txt", "gmg_03127287.json", true, "ex 2026-06-29; actual amount due 2026-08-20",
			"GMG's estimate ex 2026-06-29 confirmed by its results document", 1},
	} {
		body, err := os.ReadFile(filepath.Join("testdata", "dividend_notices", tc.file))
		if err != nil {
			t.Fatal(err)
		}
		n := pendingNotice{StockCode: strings.ToUpper(tc.file[:3]), AnnouncementDate: "2026-06-19", URL: "notice"}
		store := &fakeStore{
			pending:         []pendingNotice{n},
			evidence:        map[string]estimateEvidence{"notice": {Documents: []ResultsDocument{loadResultsDocument(t, tc.doc)}}},
			declaredArrived: tc.declaredArrived,
		}
		var logged []string
		logf := func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) }
		res, err := runDividendNoticePass(context.Background(), store, func(context.Context, string) string { return string(body) }, 10, 1, 0, false, logf)
		if err != nil {
			t.Fatal(err)
		}
		want := noticeAttempt{URL: "notice", StockCode: n.StockCode, Outcome: "estimated_only", Detail: tc.detail, ParserVersion: dividendNoticeParserVersion}
		if !slices.Equal(store.attempts, []noticeAttempt{want}) || res.Outcomes["estimated_only"] != 1 || res.Parsed != 0 {
			t.Errorf("%s: attempts %+v, outcomes %v; want %+v", tc.name, store.attempts, res.Outcomes, want)
		}
		if !slices.ContainsFunc(logged, func(l string) bool { return strings.Contains(l, tc.logged) }) {
			t.Errorf("%s: logged %q, want a line with %q", tc.name, logged, tc.logged)
		}
		if len(store.asked) != tc.asked {
			t.Errorf("%s: evidence read %d times, want %d", tc.name, len(store.asked), tc.asked)
		}
	}
}

// The label gate, on prod quotes (the documents behind the review's twelve
// candidate confirmations, and dollar entries).
func TestDistributionLabel(t *testing.T) {
	june26 := time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC)
	jul26 := time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC)
	dec25 := time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)
	dec26 := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		quote     string
		periodEnd time.Time
		kind      documentKind
		partType  string
		want      bool
	}{
		{"Final dividend and distribution proposed per GMG security (cents)\n15.0", june26, periodAnnual, "ordinary", true},
		{"Interim distribution per GMG security (cents)\n15.0", june26, periodAnnual, "ordinary", false},
		{"final distribution of \n9.83 cents per security", june26, periodAnnual, "ordinary", true},
		{"interim distribution of \n9.58 cents per security", june26, periodAnnual, "ordinary", false},
		{"total FY26 distributions to \n19.41 cents per security", june26, periodAnnual, "ordinary", false},
		{"Distribution per security for the period ending:\n30 September\n \n4.150", june26, periodAnnual, "ordinary", false},
		{"Distribution per security for the period ending5\n31 December\n \n19.3", june26, periodAnnual, "ordinary", false},
		{"2.50 cents per security for final \nFY26 distribution.", june26, periodAnnual, "ordinary", true},
		{"Combined \nwith the 2.50 cents per \nsecurity interim distribution, \ntotal distributions for FY26 \nof 5.00 cents per security.", june26, periodAnnual, "ordinary", false},
		{"Final distribution payable on 31 August 2026\n30 June 2026 \n4.8", june26, periodAnnual, "ordinary", true},
		{"Interim distribution paid on 26 February 2026\n31 December 2025 \n   4.7", june26, periodAnnual, "ordinary", false},
		{"Dividend/distributions for the period ended 30 June 2026\n9.215", june26, periodHalf, "ordinary", true},
		{"Final dividend/distribution \n16.2 ¢", june26, periodAnnual, "ordinary", true},
		{"Interim dividend/distribution \n9.0 ¢", june26, periodAnnual, "ordinary", false},
		{"June 2026 quarterly \ndistribution \n0.75", june26, periodAnnual, "ordinary", true},
		{"September 2025 quarterly \ndistribution  \n0.75", june26, periodAnnual, "ordinary", false},
		{"March 2026 quarterly \ndistribution \n0.75", june26, periodAnnual, "ordinary", false},
		{"Distribution\nper stapled security\n4.25 cents", june26, periodAnnual, "ordinary", false},
		{"Distribution per security (cents - including proposed distribution)\n8.50", june26, periodAnnual, "ordinary", false},
		{"A $0.1432/unit distribution to unitholders was announced", june26, periodAnnual, "ordinary", false},
		{"Final dividend – FY25 (paid on 24 October 2025)  | $0.0050", june26, periodAnnual, "ordinary", false},
		{"Final 2026 dividend declared (to be paid 25 September 2026) | 0.70", june26, periodAnnual, "ordinary", true},
		{"Final dividend - fully franked (cents per share) \n  \n270", june26, periodAnnual, "ordinary", true},
		{"Interim dividend - fully franked (cents per share) \n  \n 235", june26, periodAnnual, "ordinary", false},
		{"2026 Final ordinary dividend – payable  | 22 September 2026  | $0.5200", june26, periodAnnual, "ordinary", true},
		{"2026 Final ordinary dividend – payable  | 22 September 2026  | $0.5200", june26, periodAnnual, "special", false},
		{"2026 Special dividend – payable  | 22 September 2026  | $0.1000", june26, periodAnnual, "ordinary", false},
		{"Final special dividend of 10 cents per share", june26, periodAnnual, "special", true},
		{"Final dividend per share 1H26 15c", june26, periodAnnual, "ordinary", false},
		{"Final dividend (H1FY26) 15c", june26, periodAnnual, "ordinary", false},
		{"Final dividend 15c (pcp: 14c)", june26, periodAnnual, "ordinary", false},
		{"Interim dividend corresponding period 14.0", dec26, periodHalf, "ordinary", false},
		{"Final dividend 15c, up from the prior year", june26, periodAnnual, "ordinary", false},
		{"Full year dividend 30c", june26, periodAnnual, "ordinary", false},
		{"FY27 distribution guidance of 15.0 cents", june26, periodAnnual, "ordinary", false},
		{"Expected final distribution 15.0 cents", june26, periodAnnual, "ordinary", false},
		{"Final distribution FY2026 15.0 cents", june26, periodAnnual, "ordinary", true},
		{"Final distribution Jun-26 15.0 cents", june26, periodAnnual, "ordinary", true},
		{"Final distribution Sept 2026 15.0 cents", june26, periodAnnual, "ordinary", false},
		{"Interim dividend 15 cents per share", dec25, periodHalf, "ordinary", true},
		{"Final dividend 15 cents per share", dec25, periodHalf, "ordinary", false},
		{"2H25 dividend 15 cents per share", dec25, periodHalf, "ordinary", false},
		{"Distribution for the quarter ended 30 June 2026 4.15", june26, periodUnknown, "ordinary", true},
		{"Final distribution 4.15", june26, periodUnknown, "ordinary", false},
		{"Interim distribution for June 2026 4.15", june26, periodUnknown, "ordinary", false},

		// A distribution paid on or before the period end is another one: the
		// FY25 finals in EZZ's (03133775) and TWD's (03129054) FY26 documents,
		// and MEC's March quarter (03126542; its June quarter's was 1.4c). Only
		// payment dates after the period end are removed.
		{"Final dividend paid on 23 December 2025 2.00 2.00", june26, periodAnnual, "ordinary", false},
		{"Final Dividend Paid 10 December 2025 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid in June 2026 (cents per share) 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid in March 2026 (cents per share) 1.00", june26, periodAnnual, "ordinary", false},
		{"Final distribution paid on 28 August 2025 15.0 cents per unit", june26, periodAnnual, "ordinary", false},
		{"June 2026 monthly dividend paid 30 June 2026 \n0.47", june26, periodAnnual, "ordinary", false}, // SNC 03130533: paid on the period end itself
		{"Final distribution paid on 28 August 2026 15.0 cents per unit", june26, periodAnnual, "ordinary", true},
		{"2026 Final distribution paid on 16 July 2026 1.30", june26, periodAnnual, "ordinary", true}, // PCX
		{"On 22 June 2026, the Directors of the responsible entity of GemLife Trust declared an interim distribution to be paid on 28 August 2026 1.1",
			june26, periodHalf, "ordinary", true}, // GLF
		{"Final dividend payment date 15/09/2026 4.8", june26, periodAnnual, "ordinary", true},
		{"Final dividend payment date 20/03/2026 4.8", june26, periodAnnual, "ordinary", false},
		{"Final dividend payment date 31/09/2026 4.8", june26, periodAnnual, "ordinary", false}, // not a date
		{"Final dividend paid on 20 December 15c", dec25, periodAnnual, "ordinary", false},
		{"Final dividend paid in December 15c", dec25, periodAnnual, "ordinary", false},
		{"Final dividend payable on 20 March 15c", dec25, periodAnnual, "ordinary", false}, // March, with no year: not placed
		{"Final dividend paid during the year (cents per share) 15.0", june26, periodAnnual, "ordinary", false},
		{"Dividends declared and paid during the current financial period (declared on 03 October \n2025 and paid on 1 December 2025) \n0.30",
			june26, periodAnnual, "ordinary", false}, // N1H 03132612
		{"Final dividend paid during the half 15c", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid during the period 15c", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid during June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Final dividend payable in June 2026 15c", june26, periodAnnual, "ordinary", false},
		// A payment the rule cannot place withholds the entry: each of these
		// would otherwise read as the period's own (MEC's quote without "in").
		{"Quarterly dividend paid June 2026 (cents per share) 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid Jun-26 1.00", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid 15/09/25 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid 15-03-2026 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend payment date: 15/09/25 4.8", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid during FY26 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid in FY26 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Interim dividend paid in 1H FY26 15c", dec25, periodHalf, "ordinary", false},
		{"Interim dividend paid in 1H26 15c", dec25, periodHalf, "ordinary", false},
		{"Final dividend paid on 23rd December 2025", dec25, periodAnnual, "ordinary", false},
		{"Final dividend paid on December 23, 2025", dec25, periodAnnual, "ordinary", false},
		// Whatever the words between, a month or a year within 40 characters of
		// a payment word: TBR's (03146209), RMC's (03130317) and SRH's
		// (03142911) entries as stored, the same shapes in the period end's
		// month, where nothing else withholds them, and the review's other
		// spellings of an earlier payment.
		{"A dividend of 20 cents per ordinary share was paid to shareholders on 24 November 2025", june26, periodAnnual, "ordinary", false},
		{"Special dividend paid (24 March 2026) \n \n9.00", june26, periodAnnual, "special", false},
		{"declared a final dividend of 0.5 cents per share to be paid on the 28 September 2026", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid to shareholders on 24 June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid (24 June 2026) 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly distribution paid to unitholders in June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Special dividend paid (24 June 2026) 9.00", june26, periodAnnual, "special", false},
		{"Final dividend to be paid on the 28 June 2026 4.0", june26, periodAnnual, "ordinary", false},
		{"Interim dividend paid to shareholders on 18 December 2025 4.0", dec25, periodHalf, "ordinary", false},
		{"Quarterly dividend paid to shareholders of the company on 24 June 2026 1.00", june26, periodAnnual, "ordinary", false}, // seven words: not four
		{"Quarterly dividend paid on the 23rd of June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid on the 23 June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid on Tuesday 23 June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid on Tuesday, 23 June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend payment date – 23 June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend payment date (23 June 2026) 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid on or about 23 June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid 2026-03-20 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid 23-Jun-2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid 23-Jun-26 1.00", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid during 2026 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid during the 2026 financial year 15.0", june26, periodAnnual, "ordinary", false},
		{"Distribution paid (June 2026) 1.00", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid – June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid | June 2026 | 10.5", june26, periodAnnual, "ordinary", false},
		{"Final dividend payable June 2026 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid on 1st June 2026 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid on 2nd June 2026 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid on 30th June 2026 10.5 cents", june26, periodAnnual, "ordinary", false},
		// Paid in or during the year, the period, a half or a quarter.
		{"Quarterly dividend paid in the June quarter 1.00", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid in the year (cents per share) 15.0", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid in the period 15.0", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid in the financial year 15.0", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid in the current financial year 15c", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid in the second half 15c", june26, periodAnnual, "ordinary", false},
		{"Final dividend payable during the last quarter 15c", june26, periodAnnual, "ordinary", false},
		{"Final dividend payment in the year 15c", june26, periodAnnual, "ordinary", false},
		// A fiscal year or half after a payment word, each spelling in a
		// document where nothing else withholds it.
		{"Interim dividend paid in H1 26 15c", dec25, periodHalf, "ordinary", false},
		{"Interim dividend paid in HY26 15c", dec25, periodHalf, "ordinary", false},
		{"Interim dividend paid in 1H 26 15c", dec25, periodHalf, "ordinary", false},
		{"Interim dividend paid in 1H-26 15c", dec25, periodHalf, "ordinary", false},
		{"Interim dividend paid in 1HY26 15c", dec25, periodHalf, "ordinary", false},
		{"Interim dividend paid in H1'26 15c", dec25, periodHalf, "ordinary", false},
		{"Final dividend paid in FY'26 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid in FY-26 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid in H2 FY26 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid in F26 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid | FY26 | 10.5", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid: FY26 10.5", june26, periodAnnual, "ordinary", false},
		// An ordinal day, or a numeric date with a two-digit year, with no month
		// near it.
		{"Final dividend payable on 1st business day after the record date 4.8", june26, periodAnnual, "ordinary", false},
		{"Final dividend payable on 2nd business day after the record date 4.8", june26, periodAnnual, "ordinary", false},
		{"Final dividend payable on 3rd business day after the record date 4.8", june26, periodAnnual, "ordinary", false},
		{"Final dividend payable on 15th business day after the record date 4.8", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid 15.09.25 10.5 cents", june26, periodAnnual, "ordinary", false},
		{"Final dividend paid 15-09-25 10.5 cents", june26, periodAnnual, "ordinary", false},
		// What says what was paid, not when, is no payment date; nor is a
		// payment word with no date (FWD's 03130802 entry as stored). Later
		// payments written with dots or dashes are read like slashed ones.
		{"Distribution paid in respect of the June 2026 quarter 1.00", june26, periodAnnual, "ordinary", true},
		{"Distribution paid for the quarter ended 30 June 2026 1.00", june26, periodAnnual, "ordinary", true},
		{"Final dividend payable / paid per security (cents) \n9.50", june26, periodAnnual, "ordinary", true},
		{"Final dividend payable on 26.08.2026 15.0", june26, periodAnnual, "ordinary", true},
		{"Final dividend payment date 15-09-2026 4.8", june26, periodAnnual, "ordinary", true},
		{"Final dividend paid 15.09.2025 4.8", june26, periodAnnual, "ordinary", false},
		// Nor is the class of security an amount is per, which would put the
		// period end within 40 characters of "paid".
		{"Final dividend of 15.0 cents per fully paid ordinary share for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final distribution of 15.0 cents per fully-paid stapled security for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Interim dividend per partly paid share for the half-year ended 31 December 2025 2.0", dec25, periodHalf, "ordinary", true},
		{"Final distribution of 15.0 cents per fully paid ordinary unit for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final distribution of 1.00 cent per fully paid units for the quarter ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per fully paid up share for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per fully paid up ordinary share, year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per fully paid-up shares for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per fully paid preference share for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final distribution of 15.0 cents per fully paid ordinary stapled securities for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final distribution of 15.0 cents per fully paid securities, year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per fully-\npaid ordinary share for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per partially paid share for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per ordinary fully paid share for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per fully paid CDI for the year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per fully paid CDIs, year ended 30 June 2026", june26, periodAnnual, "ordinary", true},
		// Other spellings of a class are not skipped, which fails safe for the
		// entry itself.
		{"Final dividend of 15.0 cents per fully paid stock unit for the year ended 30 June 2026", june26, periodAnnual, "ordinary", false},
		// Only that phrase is skipped, and only before its period's own end: a
		// payment after it is still read, and before any other date, or with
		// no "per", "fully paid" is a payment word.
		{"Final dividend of 15.0 cents per fully paid ordinary share paid on 24 June 2026", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend 1.00 cent per fully paid share paid to shareholders on 24 June 2026", june26, periodAnnual, "ordinary", false},
		{"Quarterly dividend paid to the registered holders of fully paid ordinary shares in the Company on 24 June 2026 1.00", june26, periodAnnual, "ordinary", false},
		{"The Company paid a fully franked dividend of 2.0 cents per fully paid ordinary share on 24 June 2026", june26, periodAnnual, "ordinary", false},
		{"The Company paid a fully franked interim dividend of 2.0 cents per fully paid ordinary share on 24 December 2025", dec25, periodHalf, "ordinary", false},
		{"Interim dividend 2.0 cents per fully paid ordinary share (24 December 2025)", dec25, periodHalf, "ordinary", false},
		{"Quarterly dividend of 1.00 cent per fully paid CDI on 30 June 2026", june26, periodAnnual, "ordinary", false},
		{"Final dividend of 15.0 cents per fully paid ordinary share for the year ended 30 June 2026, paid to shareholders on 24 June 2026", june26, periodAnnual, "ordinary", false},
		// The period phrase may end "ended", "ending", "end" or "to"; the first
		// date after the class must be in it, and it must be the period end's
		// own day.
		{"Interim dividend of 2.0 cents per fully paid share for the six months to 31 December 2025", dec25, periodHalf, "ordinary", true},
		{"Final distribution of 1.00 cent per fully paid unit for the period ending 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per fully paid share, year end 30 June 2026", june26, periodAnnual, "ordinary", true},
		{"Final dividend of 15.0 cents per fully paid share on 24 June 2026 for the year ended 30 June 2026", june26, periodAnnual, "ordinary", false},
		{"Final distribution of 1.00 cent per fully paid unit for the period ended 15 June 2026", june26, periodAnnual, "ordinary", false},
		{"Interim dividend of 2.0 cents per fully paid share in 2025", dec25, periodHalf, "ordinary", false},
		// Two qualifiers before "fully", or a word the class's noun only starts,
		// are not a class: withheld.
		{"Final distribution of 15.0 cents per stapled ordinary fully paid security for the year ended 30 June 2026", june26, periodAnnual, "ordinary", false},
		{"Final dividend of 15.0 cents per fully paid shareholding for the year ended 30 June 2026", june26, periodAnnual, "ordinary", false},
		// An ordinal day after "on the" or "date the"; elsewhere "the 2nd" is no
		// day. A payment in an ordinal quarter or half is one in a quarter or
		// half, which the rule cannot place.
		{"Final dividend paid on the 24th 15.0", june26, periodAnnual, "ordinary", false},
		{"Final dividend payment date: the 1st 15.0", june26, periodAnnual, "ordinary", false},
		{"Final dividend 15.0 cents; the Company paid the 2nd highest dividend in its history", june26, periodAnnual, "ordinary", true},
		{"Final dividend payable during the 4th quarter 15.0", june26, periodAnnual, "ordinary", false},
		{"Final dividend 15.0 cents payable in the 1st quarter of the next financial year", june26, periodAnnual, "ordinary", false},

		// A year or fiscal year that is not the document's own.
		{"Final distribution 30 June 2025 15.0", june26, periodAnnual, "ordinary", false},
		{"Final dividend FY27 15c", june26, periodAnnual, "ordinary", false},
		{"FY 2026 final dividend 15c", june26, periodAnnual, "ordinary", true},
		{"Interim dividend for FY26 10.0 cents", june26, periodHalf, "ordinary", true}, // TPG: a December-year issuer's half
		{"Interim dividend for FY27 10.0 cents", june26, periodHalf, "ordinary", false},
		// A June-year issuer's half to 31 December 2026 is 1H FY27, and FY26
		// there is the comparative half's; so for every half ending July to
		// December (a January-year issuer's half to 31 July 2026 is FY27's).
		{"Interim dividend 1H FY26 15 cents per share", dec25, periodHalf, "ordinary", true},
		{"Interim dividend 1H FY25", dec25, periodHalf, "ordinary", false},
		{"Interim distribution 1H FY27 per security (cents) 15.0", dec26, periodHalf, "ordinary", true},
		{"Interim distribution 1HFY27 per security (cents) 15.0", dec26, periodHalf, "ordinary", true},
		{"Interim distribution FY 2027 per security (cents) 15.0", dec26, periodHalf, "ordinary", true},
		{"Interim distribution 1H FY26 per security (cents) 14.0", dec26, periodHalf, "ordinary", false},
		{"Interim dividend FY26 (cents) 14.0", dec26, periodHalf, "ordinary", false},
		{"Interim distribution 1HFY25 per security (cents) 15.0", dec26, periodHalf, "ordinary", false},
		{"Interim distribution FY28 per security (cents) 15.0", dec26, periodHalf, "ordinary", false},
		{"Interim distribution 2027 per security (cents) 15.0", dec26, periodHalf, "ordinary", false}, // a calendar year
		{"Interim distribution 1H FY27 per security (cents) 15.0", dec26, periodUnknown, "ordinary", false},
		{"Interim dividend 1H FY27 4.0 cents", jul26, periodHalf, "ordinary", true},
		{"Interim dividend 1H FY26 4.0 cents", jul26, periodHalf, "ordinary", false},
		{"Final dividend FY27 15c", dec26, periodAnnual, "ordinary", false}, // a December-year issuer's year to 2026-12-31 is FY26
		// A half label's digits are a fiscal year too.
		{"Interim dividend 1H26 15 cents per share", dec25, periodHalf, "ordinary", true},
		{"Interim dividend 1H25 15 cents per share", dec25, periodHalf, "ordinary", false},
		{"Interim dividend H1 25 15 cents per share", dec25, periodHalf, "ordinary", false},
		{"Interim dividend 1H 2026 15 cents per share", dec26, periodHalf, "ordinary", false},
		{"Interim dividend 1H 2027 15 cents per share", dec26, periodHalf, "ordinary", true}, // like "FY 2027": not calendar 2027
		{"Interim dividend HY2027 15 cents per share", dec26, periodHalf, "ordinary", true},
		{"Interim dividend HY2026 15 cents per share", dec26, periodHalf, "ordinary", false},
		{"Final dividend 2H26 15c", june26, periodAnnual, "ordinary", true},
		{"Final dividend 2H25 15c", june26, periodAnnual, "ordinary", false},
		{"Interim dividend H1 25.0 cents per share", june26, periodHalf, "ordinary", true}, // 25.0 is the amount
		{"Interim dividend 1H'25 15 cents per share", dec25, periodHalf, "ordinary", false},
		{"Interim dividend declared for 1H25. 15 cents per share", dec25, periodHalf, "ordinary", false}, // "." alone: not an amount
		// A label joined to its digits by a dash, "1HY26", and Woolworths' and
		// TWE's "F25" ("H1 F26").
		{"Final dividend FY-25 15c", june26, periodAnnual, "ordinary", false},
		{"Final dividend 2H-25 15c", june26, periodAnnual, "ordinary", false},
		{"Interim dividend 1H-26 14.0", dec26, periodHalf, "ordinary", false},
		{"Interim dividend 1HY26 14.0", dec26, periodHalf, "ordinary", false},
		{"Interim dividend 1HY27 14.0", dec26, periodHalf, "ordinary", true},
		{"Final dividend F25 15c", june26, periodAnnual, "ordinary", false},
		{"Final dividend F26 15c", june26, periodAnnual, "ordinary", true},
		{"Interim dividend H1 F26 14.0", dec26, periodHalf, "ordinary", false},
		// A document whose period is not stated reads only FY(year), even when
		// it ends July to December.
		{"Distribution for December 2026 FY27 4.15", dec26, periodUnknown, "ordinary", false},
		// A month's two-digit year: the comparative year's ("Jun-25") is
		// another distribution. Two digits followed by decimals are an amount
		// (DXS's 03127378 entry as stored, read against its own half), and
		// followed by a year a day.
		{"Final distribution Jun-25 15.0 cents", june26, periodAnnual, "ordinary", false},
		{"Final distribution June 25 15.0 cents", june26, periodAnnual, "ordinary", false},
		{"Final distribution 30-Jun-25 15.0", june26, periodAnnual, "ordinary", false},
		{"Interim dividend Dec-25 14.0", dec26, periodHalf, "ordinary", false},
		{"Interim dividend Dec '25 14.0", dec26, periodHalf, "ordinary", false},
		{"Interim dividend Dec'25 14.0", dec26, periodHalf, "ordinary", false},
		{"Final distribution Jun/25 15.0", june26, periodAnnual, "ordinary", false},
		{"Interim dividend 6 months to Dec-25 14.0", dec26, periodHalf, "ordinary", false},
		{"Interim dividend Dec-26 14.0", dec26, periodHalf, "ordinary", true},
		{"Distribution per security for the period ending5\n31 December\n \n19.3", dec25, periodHalf, "ordinary", true},
		{"Final distribution for the year ended June 30, 2026 15.0", june26, periodAnnual, "ordinary", true},

		// What only a half-year document's own checks reject.
		{"Final dividend 31 December 2025 15c", dec25, periodHalf, "ordinary", false},
		{"Distribution per security 4.25", dec25, periodHalf, "ordinary", false},
		{"Interim distribution 4.15 cents and 2H distribution 4.20 cents per unit", june26, periodHalf, "ordinary", false},
	} {
		if got, why := distributionLabel(tc.quote, tc.periodEnd, tc.kind, tc.partType); got != tc.want {
			t.Errorf("%q (%s, %v, %s) = %v (%s), want %v", tc.quote, tc.periodEnd.Format(time.DateOnly), tc.kind, tc.partType, got, why, tc.want)
		}
	}
}

// Franking an entry states, from prod's franking attributes (443 entries
// carry one) and quotes.
func TestEntryFranking(t *testing.T) {
	for _, tc := range []struct {
		attr       any
		pct        float64
		stated, ok bool
	}{
		{nil, 0, false, true},
		{"null", 0, false, true},
		{"", 0, false, true},
		{"N/A", 0, false, true},
		{"not specified", 0, false, true},
		{"not applicable", 0, false, true},
		{"fully franked", 100, true, true},
		{"Fully franked", 100, true, true},
		{"fully-franked", 100, true, true},
		{"100%", 100, true, true},
		{"100% franked", 100, true, true},
		{"100", 100, true, true},
		{"unfranked", 0, true, true},
		{"not franked", 0, true, true},
		{"Nil", 0, true, true},
		{"0", 0, true, true},
		{"70% franked", 70, true, true},
		{"partially franked at 70%", 70, true, true},
		{"20%", 20, true, true},
		{"partially franked", 0, true, false},
		{"4.50 cents franked", 0, true, false},
		{"fully franked at the 30% tax rate", 0, true, false},
		{100.0, 0, true, false},
	} {
		entry := map[string]any{}
		if tc.attr != nil {
			entry["franking"] = tc.attr
		}
		pct, stated, ok := attributeFranking(entry)
		if pct != tc.pct || stated != tc.stated || ok != tc.ok {
			t.Errorf("franking %#v = %v, %v, %v; want %v, %v, %v", tc.attr, pct, stated, ok, tc.pct, tc.stated, tc.ok)
		}
	}
	for _, tc := range []struct {
		quote      string
		pct        float64
		stated, ok bool
	}{
		{"Final dividend and distribution proposed per GMG security (cents)\n15.0", 0, false, true},
		{"Final dividend - fully franked (cents per share) \n  \n270", 100, true, true},
		{"A fully franked dividend of $0.04 per share", 100, true, true},
		{"Final distribution, unfranked, 4.8 cents", 0, true, true},
		{"Final dividend 3.00% franked", 3, true, true},
		{"Final dividend, partially franked", 0, true, false},
		{"Final dividend 10c fully franked and 5c unfranked", 0, true, false},
		{"Interim dividend payable – franked at 20% 3.0 cents per share", 20, true, true}, // AMP 03122406
		{"Final dividend, partially franked at 70%", 70, true, true},
		{"Final dividend fully franked at 30% 15c", 100, true, true}, // 30%: the credits' tax rate
		{"Final dividend franked at 30% corporate tax rate 15c", 0, true, false},
	} {
		pct, stated, ok := quoteFranking(tc.quote)
		if pct != tc.pct || stated != tc.stated || ok != tc.ok {
			t.Errorf("quote %q = %v, %v, %v; want %v, %v, %v", tc.quote, pct, stated, ok, tc.pct, tc.stated, tc.ok)
		}
	}
}

// The data review reads the documents and due date back from the detail.
func TestConfirmedEstimateDetail(t *testing.T) {
	c := EstimateConfirmation{Matches: []EstimateMatch{
		{Type: "ordinary", Document: asxAnnouncement + "03127287"},
		{Type: "special", Document: asxAnnouncement + "03140019"},
	}}
	detail := confirmedEstimateDetail(2, c, "2026-08-20")
	if want := "2 rows; estimate confirmed by " + asxAnnouncement + "03127287 " + asxAnnouncement + "03140019; actual amount due 2026-08-20"; detail != want {
		t.Errorf("detail %q, want %q", detail, want)
	}
	docs, due, ok := ConfirmedEstimateDetail(detail)
	if !ok || due != "2026-08-20" || !slices.Equal(docs, []string{asxAnnouncement + "03127287", asxAnnouncement + "03140019"}) {
		t.Errorf("read back %q, %q, %v", docs, due, ok)
	}
	for _, other := range []string{"1 rows", "ex 2026-06-29; actual amount due 2026-08-20", ""} {
		if _, _, ok := ConfirmedEstimateDetail(other); ok {
			t.Errorf("%q read as a confirmed estimate", other)
		}
	}
}
