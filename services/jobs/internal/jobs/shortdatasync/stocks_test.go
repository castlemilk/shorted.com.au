package shortdatasync

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestParseStockCodesNormalises(t *testing.T) {
	got, err := parseStockCodes(" bhp , dro  4dx;bhp ")
	if err != nil {
		t.Fatalf("parseStockCodes: %v", err)
	}
	want := []string{"BHP", "DRO", "4DX"}
	if len(got) != len(want) {
		t.Fatalf("codes = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("codes = %v, want %v (order must follow the operator's input)", got, want)
		}
	}
}

func TestParseStockCodesRejectsBadInput(t *testing.T) {
	for _, raw := range []string{
		"",                     // empty
		"   ",                  // whitespace only
		"BHP;DROP TABLE",       // spaces make two fields; "TABLE" is 5 ok but "DROP" ok — see below
		"bh-p",                 // punctuation
		"TOOLONGCODE",          // >5
		"BHP,'; DELETE FROM x", // quote/semicolon soup
	} {
		if _, err := parseStockCodes(raw); err == nil {
			// "BHP;DROP TABLE" splits to BHP/DROP/TABLE which are all legal
			// shapes — that is FINE: the point of the pattern is that nothing
			// unsafe can survive it, not that every phrase is rejected.
			if raw == "BHP;DROP TABLE" {
				continue
			}
			t.Fatalf("parseStockCodes(%q) must fail", raw)
		}
	}
}

func TestParseStockCodesCap(t *testing.T) {
	codes := make([]string, 0, maxStockCodes+1)
	for i := 0; i <= maxStockCodes; i++ {
		codes = append(codes, string(rune('A'+i%26))+string(rune('A'+(i/26)%26))+string(rune('0'+i%10)))
	}
	if _, err := parseStockCodes(strings.Join(codes, ",")); err == nil {
		t.Fatalf("more than %d codes must be refused", maxStockCodes)
	}
}

// TestStocksRequiresShadow is the flag's safety property: a scoped LIVE run is
// impossible, because -stocks scopes the REPORT, never the writes.
func TestStocksRequiresShadow(t *testing.T) {
	if _, err := parseConfig(context.Background(), []string{"-stocks", "BHP"}); err == nil {
		t.Fatal("-stocks without -shadow must be refused")
	} else if !strings.Contains(err.Error(), "-shadow") {
		t.Fatalf("the error must name -shadow, got %v", err)
	}

	cfg, err := parseConfig(context.Background(), []string{"-shadow", "-stocks", "bhp,dro"})
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if !cfg.shadow || !cfg.dryRun {
		t.Fatalf("a -stocks run must be shadow AND dry-run: %+v", cfg)
	}
	if len(cfg.stocks) != 2 || cfg.stocks[0] != "BHP" {
		t.Fatalf("stocks = %v", cfg.stocks)
	}
}

func TestParseConfigRejectsInvalidStock(t *testing.T) {
	if _, err := parseConfig(context.Background(), []string{"-shadow", "-stocks", "BH_P"}); err == nil {
		t.Fatal("an invalid code must fail the whole run, not be silently dropped")
	}
}

// day is a small helper for the report tests.
func day(d int) time.Time { return time.Date(2026, 8, d, 0, 0, 0, 0, time.UTC) }

func TestBuildStocksReportDiffStatuses(t *testing.T) {
	files := []stockFileRows{
		{
			Date: day(14),
			File: "RR20260814-001-SSDailyAggShortPos.csv",
			Rows: []shortsRow{
				{Date: day(14), Product: "BHP LTD", ProductCode: "BHP", ReportedShortPositions: 100, TotalProductInIssue: 1000, Percent: 10},
				{Date: day(14), Product: "DRONE LTD", ProductCode: "DRO", ReportedShortPositions: 5, TotalProductInIssue: 50, Percent: 10},
			},
		},
		{
			Date: day(15),
			File: "RR20260815-001-SSDailyAggShortPos.csv",
			Rows: []shortsRow{
				{Date: day(15), Product: "BHP LTD", ProductCode: "BHP", ReportedShortPositions: 200, TotalProductInIssue: 1000, Percent: 20},
			},
		},
	}
	db := map[string]shortsRow{
		// unchanged
		rowKey(day(14), "BHP"): {Date: day(14), Product: "BHP LTD", ProductCode: "BHP", ReportedShortPositions: 100, TotalProductInIssue: 1000, Percent: 10},
		// changed (positions differ)
		rowKey(day(14), "DRO"): {Date: day(14), Product: "DRONE LTD", ProductCode: "DRO", ReportedShortPositions: 4, TotalProductInIssue: 50, Percent: 8},
		// present in DB for the 15th but absent from that file → missing-from-file
		rowKey(day(15), "DRO"): {Date: day(15), Product: "DRONE LTD", ProductCode: "DRO", ReportedShortPositions: 4, TotalProductInIssue: 50, Percent: 8},
	}

	rep := buildStocksReport([]string{"BHP", "DRO", "XYZ"}, files, db)

	if len(rep.NotFound) != 1 || rep.NotFound[0] != "XYZ" {
		t.Fatalf("not_found = %v, want [XYZ] — a code in no file must be reported explicitly", rep.NotFound)
	}
	byKey := map[string]stockObservation{}
	for _, o := range rep.Observations {
		byKey[o.Code+"|"+o.Date] = o
	}
	if got := byKey["BHP|2026-08-14"]; got.Status != statusUnchanged || !got.WouldUpdate || got.WouldInsert {
		t.Fatalf("BHP 14th = %+v, want unchanged/would-update", got)
	}
	if got := byKey["BHP|2026-08-15"]; got.Status != statusNew || !got.WouldInsert {
		t.Fatalf("BHP 15th = %+v, want new/would-insert", got)
	}
	dro := byKey["DRO|2026-08-14"]
	if dro.Status != statusChanged {
		t.Fatalf("DRO 14th = %+v, want changed", dro)
	}
	if len(dro.ChangedFields) != 2 {
		t.Fatalf("DRO changed fields = %v, want positions + percent", dro.ChangedFields)
	}
	if dro.FileValues == nil || dro.DBValues == nil {
		t.Fatal("a changed row must carry BOTH sides so an operator can see the delta")
	}
	miss := byKey["DRO|2026-08-15"]
	if miss.Status != statusMissingFromFile || !miss.WouldSkip || miss.FileValues != nil {
		t.Fatalf("DRO 15th = %+v, want missing-from-file with no file values", miss)
	}
	if rep.Counts[statusChanged] != 1 || rep.Counts[statusNew] != 1 || rep.Counts[statusUnchanged] != 1 || rep.Counts[statusMissingFromFile] != 1 {
		t.Fatalf("counts = %v", rep.Counts)
	}
	if rep.DBRowsInWindow != 3 {
		t.Fatalf("db_rows_in_window = %d, want 3", rep.DBRowsInWindow)
	}
}

// TestBuildStocksReportIgnoresProductRename encodes the upsert's actual
// semantics: ON CONFLICT does not refresh PRODUCT, so a renamed product is not
// a change the sync would make.
func TestBuildStocksReportIgnoresProductRename(t *testing.T) {
	files := []stockFileRows{{
		Date: day(14),
		File: "f.csv",
		Rows: []shortsRow{{Date: day(14), Product: "NEW NAME", ProductCode: "BHP", ReportedShortPositions: 1, TotalProductInIssue: 2, Percent: 3}},
	}}
	db := map[string]shortsRow{
		rowKey(day(14), "BHP"): {Date: day(14), Product: "OLD NAME", ProductCode: "BHP", ReportedShortPositions: 1, TotalProductInIssue: 2, Percent: 3},
	}
	rep := buildStocksReport([]string{"BHP"}, files, db)
	if rep.Observations[0].Status != statusUnchanged {
		t.Fatalf("a product rename must not count as changed: %+v", rep.Observations[0])
	}
	if rep.Observations[0].FileValues.Product != "NEW NAME" || rep.Observations[0].DBValues.Product != "OLD NAME" {
		t.Fatal("both product names must still be visible in the report")
	}
}

func TestBuildStocksReportEmptyWindow(t *testing.T) {
	rep := buildStocksReport([]string{"BHP"}, nil, map[string]shortsRow{})
	if len(rep.NotFound) != 1 {
		t.Fatalf("with no files every requested code is not-found: %+v", rep)
	}
	// Empty slices, never nulls — the report is rendered by a UI that must not
	// have to special-case null.
	b, err := json.Marshal(rep)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(b), "null") {
		t.Fatalf("report must not contain nulls: %s", b)
	}
}

func TestFilterRowsKeepsOnlyRequested(t *testing.T) {
	got := filterRows(sampleRows(), codeSet([]string{"BBB"}))
	if len(got) != 1 || got[0].ProductCode != "BBB" {
		t.Fatalf("filterRows = %+v", got)
	}
	if filterRows(sampleRows(), nil) != nil {
		t.Fatal("no filter means capture nothing (a plain shadow run)")
	}
}

// TestValidationLineIsOneParsableLine is the retrieval contract: Cloud Logging
// splits stdout per newline, so the validation payload MUST be a single line
// carrying the agreed prefix.
func TestValidationLineIsOneParsableLine(t *testing.T) {
	sum := newShadowSummary(time.Date(2026, 8, 20, 1, 2, 3, 0, time.UTC), 7)
	rep := buildStocksReport([]string{"BHP"}, nil, map[string]shortsRow{})
	sum.Stocks = &rep

	var buf strings.Builder
	if err := sum.writeValidationLine(&buf); err != nil {
		t.Fatalf("writeValidationLine: %v", err)
	}
	out := buf.String()
	if strings.Count(strings.TrimSuffix(out, "\n"), "\n") != 0 {
		t.Fatalf("payload must be exactly one line:\n%s", out)
	}
	if !strings.HasPrefix(out, "SHORTED_VALIDATION_JSON ") {
		t.Fatalf("prefix changed — the jobmonitor reader carries a copy of this literal: %q", out[:40])
	}
	var back shadowSummary
	if err := json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(out), validationLinePrefix)), &back); err != nil {
		t.Fatalf("payload must parse: %v", err)
	}
	if back.SchemaVersion != shadowSchemaVersion || back.Stocks == nil {
		t.Fatalf("round trip lost the contract: %+v", back)
	}
}

// TestPlainShadowHasNoStocksSection keeps the existing parity artefact
// byte-compatible: `stocks` is omitted entirely unless it was asked for.
func TestPlainShadowHasNoStocksSection(t *testing.T) {
	var buf strings.Builder
	if err := newShadowSummary(time.Now(), 7).writeJSON(&buf); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}
	if strings.Contains(buf.String(), `"stocks"`) {
		t.Fatalf("a plain shadow run must not emit a stocks section:\n%s", buf.String())
	}
	if !strings.Contains(buf.String(), `"schema_version": 1`) {
		t.Fatalf("schema_version must be present on every summary:\n%s", buf.String())
	}
}

func TestSameFloatTolerance(t *testing.T) {
	if !sameFloat(1e9, 1e9+0.5e-9*1e9) {
		t.Fatal("a relative epsilon must absorb float8 round-trip noise at scale")
	}
	if sameFloat(100, 101) {
		t.Fatal("a real difference must not be absorbed")
	}
	if !sameFloat(0, 0) {
		t.Fatal("zero equals zero")
	}
}
