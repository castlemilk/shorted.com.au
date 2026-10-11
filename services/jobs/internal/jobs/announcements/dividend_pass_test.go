package announcements

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	if !strings.Contains(pendingNoticesSql, "t.outcome NOT IN ('parsed', 'cancellation', 'no_text') AND t.parser_version < $2") {
		t.Error("pending SQL must re-select every failure recorded by an older parser version")
	}

	// Verify pending orders by date DESC
	if !strings.Contains(pendingNoticesSql, "ORDER BY announcement_date DESC") {
		t.Error("pending SQL not ordering by announcement_date DESC")
	}

	// Verify attempt SQL writes parser_version
	if !strings.Contains(recordAttemptSql, "parser_version") {
		t.Error("recordAttempt SQL missing parser_version")
	}

	// Verify upsert has announced_on comparison
	if !strings.Contains(upsertDividendSql, "EXCLUDED.announced_on >= dividend_history.announced_on") {
		t.Error("upsert SQL missing announced_on comparison")
	}
}

// A notice that waits on its update records the ex-date and the date the
// notice promises the update by, which the data review reads: BHP's USD final
// (2A.9b, its AUD equivalent) and DN1's estimate (3A.1a(i), its actual amount).
func TestWaitingNoticesRecordTheirPromisedDates(t *testing.T) {
	for _, tc := range []struct{ file, outcome, detail string }{
		{"bhp_final_2026-08-18.txt", "awaiting_aud_equivalent", "ex 2026-09-03; AUD equivalent due 2026-09-07"},
		{"dn1_estimated_2026-09-07.txt", "estimated_only", "ex 2026-09-11; actual amount due 2026-09-18"},
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
