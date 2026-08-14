package influence

import (
	"regexp"
	"strings"
	"testing"
	"time"
)

// Fixture mirrors a real labels=both SDMX-CSV response from
// ABS,MERCH_EXP,1.0.0 (columns + "code: label" cells verified 2026-07-09).
const absTradeExportFixture = `DATAFLOW,COMMODITY_SITC,COUNTRY_DEST,STATE_ORIGIN,FREQ,TIME_PERIOD,OBS_VALUE,UNIT_MEASURE,UNIT_MULT,OBS_STATUS,OBS_COMMENT
ABS:MERCH_EXP(1.0.0),28: Metalliferous ores and metal scrap,TOT: Total,TOT: Total,M: Monthly,2025-03,15025448,AUD: Australian Dollars,3: Thousands,,
"ABS:MERCH_EXP(1.0.0)","32: Coal, coke and briquettes",TOT: Total,TOT: Total,M: Monthly,2025-03,5717034,AUD: Australian Dollars,3: Thousands,,
ABS:MERCH_EXP(1.0.0),54: Medicinal and pharmaceutical products,TOT: Total,TOT: Total,M: Monthly,2025-03,575625,AUD: Australian Dollars,3: Thousands,,
ABS:MERCH_EXP(1.0.0),97: Gold,TOT: Total,TOT: Total,M: Monthly,2025-03,,AUD: Australian Dollars,3: Thousands,,
ABS:MERCH_EXP(1.0.0),28: Metalliferous ores and metal scrap,TOT: Total,TOT: Total,M: Monthly,2025-04,14000000,AUD: Australian Dollars,3: Thousands,,
`

func TestABSTradeIndustryMapIntegrity(t *testing.T) {
	if len(absTradeIndustryMap) == 0 {
		t.Fatal("crosswalk is empty")
	}
	codeRe := regexp.MustCompile(`^\d{2,3}$`)
	seen := map[string]bool{}
	for _, m := range absTradeIndustryMap {
		if !codeRe.MatchString(m.Code) {
			t.Errorf("code %q: not a 2- or 3-digit SITC code", m.Code)
		}
		if seen[m.Code] {
			t.Errorf("code %q: duplicate crosswalk entry", m.Code)
		}
		seen[m.Code] = true
		if strings.TrimSpace(m.Industry) == "" {
			t.Errorf("code %q: empty industry", m.Code)
		}
		if strings.TrimSpace(m.Label) == "" {
			t.Errorf("code %q: empty commodity label", m.Code)
		}
		if strings.TrimSpace(m.Rationale) == "" {
			t.Errorf("code %q: empty rationale", m.Code)
		}
	}

	key := absTradeCommodityKey()
	if got := len(strings.Split(key, "+")); got != len(absTradeIndustryMap) {
		t.Fatalf("commodity key has %d codes, want %d", got, len(absTradeIndustryMap))
	}
	if strings.ContainsAny(key, " ,") {
		t.Fatalf("commodity key contains invalid characters: %q", key)
	}
}

func TestParseABSTradeCSV(t *testing.T) {
	rows, err := parseABSTradeCSV([]byte(absTradeExportFixture), tradeDirectionExport)
	if err != nil {
		t.Fatalf("parseABSTradeCSV: %v", err)
	}
	// The blank-OBS_VALUE gold row is skipped.
	if len(rows) != 4 {
		t.Fatalf("want 4 rows, got %d: %+v", len(rows), rows)
	}

	first := rows[0]
	if first.Direction != tradeDirectionExport {
		t.Fatalf("direction = %q", first.Direction)
	}
	if first.CommodityCode != "28" {
		t.Fatalf("commodity code = %q", first.CommodityCode)
	}
	if first.CommodityLabel != "Metalliferous ores and metal scrap" {
		t.Fatalf("commodity label = %q", first.CommodityLabel)
	}
	if first.Period != "2025-03" {
		t.Fatalf("period = %q", first.Period)
	}
	// 15,025,448 thousands (UNIT_MULT=3) → raw AUD.
	if first.Value != 15025448000 {
		t.Fatalf("value = %v, want 15025448000", first.Value)
	}
	if first.Unit != "AUD" {
		t.Fatalf("unit = %q", first.Unit)
	}

	if rows[1].CommodityCode != "32" || rows[1].CommodityLabel != "Coal, coke and briquettes" {
		t.Fatalf("quoted commodity cell parsed as %q / %q", rows[1].CommodityCode, rows[1].CommodityLabel)
	}
}

func TestParseABSTradeCSVRejectsMissingColumns(t *testing.T) {
	data := []byte("DATAFLOW,TIME_PERIOD,OBS_VALUE\nABS:MERCH_EXP(1.0.0),2025-03,100\n")
	if _, err := parseABSTradeCSV(data, tradeDirectionExport); err == nil {
		t.Fatal("expected missing-column error")
	}
}

func TestBuildTradeIndustryRecords(t *testing.T) {
	rows := []TradeRow{
		{Direction: tradeDirectionExport, CommodityCode: "28", CommodityLabel: "Metalliferous ores and metal scrap", Period: "2025-03", Value: 15_025_448_000, Unit: "AUD"},
		{Direction: tradeDirectionExport, CommodityCode: "97", CommodityLabel: "Gold, non-monetary", Period: "2025-03", Value: 4_000_000_000, Unit: "AUD"},
		{Direction: tradeDirectionImport, CommodityCode: "32", CommodityLabel: "Coal, coke and briquettes", Period: "2025-03", Value: 100_000_000, Unit: "AUD"},
		{Direction: tradeDirectionExport, CommodityCode: "999", CommodityLabel: "Unmapped commodity", Period: "2025-03", Value: 1, Unit: "AUD"},
	}

	records, skipped := buildTradeIndustryRecords(rows)
	if skipped != 1 {
		t.Fatalf("skipped = %d, want 1 (the unmapped commodity)", skipped)
	}
	if len(records) != 2 {
		t.Fatalf("want 2 aggregated records, got %d: %+v", len(records), records)
	}

	// Sorted by industry: Energy import first, then Materials export.
	energy := records[0]
	if energy.Industry != "Energy" || energy.MetricKey != "import_value" {
		t.Fatalf("first record = %s/%s", energy.Industry, energy.MetricKey)
	}
	if energy.MetricLabel != "Merchandise imports (mapped commodities)" {
		t.Fatalf("import metric label = %q", energy.MetricLabel)
	}

	materials := records[1]
	if materials.Industry != "Materials" || materials.MetricKey != "export_value" {
		t.Fatalf("second record = %s/%s", materials.Industry, materials.MetricKey)
	}
	if materials.SourceKey != tradeSource || materials.SignalKind != "trade_exposure" {
		t.Fatalf("source/signal = %s/%s", materials.SourceKey, materials.SignalKind)
	}
	// Industry-level: never a company claim.
	if materials.StockCode != "" || materials.EntityABN != "" {
		t.Fatalf("industry-level record carries entity fields: stock=%q abn=%q", materials.StockCode, materials.EntityABN)
	}
	if materials.MetricValue == nil || *materials.MetricValue != 19_025_448_000 {
		t.Fatalf("materials export sum = %v, want 19025448000", materials.MetricValue)
	}
	if materials.Unit != "AUD" {
		t.Fatalf("unit = %q", materials.Unit)
	}
	wantStart := time.Date(2025, time.March, 1, 0, 0, 0, 0, time.UTC)
	wantEnd := time.Date(2025, time.March, 31, 0, 0, 0, 0, time.UTC)
	if materials.PeriodStart == nil || !materials.PeriodStart.Equal(wantStart) {
		t.Fatalf("period start = %v", materials.PeriodStart)
	}
	if materials.PeriodEnd == nil || !materials.PeriodEnd.Equal(wantEnd) {
		t.Fatalf("period end = %v", materials.PeriodEnd)
	}
	if !materials.AsOf.Equal(wantEnd) {
		t.Fatalf("as_of = %v, want period end", materials.AsOf)
	}
	if materials.SourceRecordID != "abs-trade:export:materials:2025-03" {
		t.Fatalf("record ID = %q", materials.SourceRecordID)
	}
	if materials.Title != "Materials merchandise exports: March 2025" {
		t.Fatalf("title = %q", materials.Title)
	}
	wantSummary := "ABS reported $19,025.4m of merchandise exports across commodities mapped to Materials for March 2025."
	if materials.Summary != wantSummary {
		t.Fatalf("summary = %q", materials.Summary)
	}
	if materials.SourceURL != tradeSourceURL {
		t.Fatalf("source URL = %q", materials.SourceURL)
	}

	codes, ok := materials.Metadata["commodity_codes"].([]string)
	if !ok {
		t.Fatalf("metadata commodity_codes type = %T", materials.Metadata["commodity_codes"])
	}
	if len(codes) != 2 || codes[0] != "28" || codes[1] != "97" {
		t.Fatalf("metadata commodity codes = %v", codes)
	}
	if materials.Metadata["valuation_basis"] != "free on board (FOB)" {
		t.Fatalf("export valuation basis = %v", materials.Metadata["valuation_basis"])
	}
	if energy.Metadata["valuation_basis"] != "customs value" {
		t.Fatalf("import valuation basis = %v", energy.Metadata["valuation_basis"])
	}
}

func TestMonthPeriodDates(t *testing.T) {
	start, end, err := monthPeriodDates("2026-02")
	if err != nil {
		t.Fatalf("monthPeriodDates: %v", err)
	}
	if start != time.Date(2026, time.February, 1, 0, 0, 0, 0, time.UTC) {
		t.Fatalf("start = %v", start)
	}
	if end != time.Date(2026, time.February, 28, 0, 0, 0, 0, time.UTC) {
		t.Fatalf("end = %v", end)
	}
	for _, bad := range []string{"2026", "2026-Q1", "2026-02-01", "junk"} {
		if _, _, err := monthPeriodDates(bad); err == nil {
			t.Fatalf("monthPeriodDates(%q): expected error", bad)
		}
	}
}

func TestFormatMillions(t *testing.T) {
	cases := map[float64]string{
		15_025_448_000: "15,025.4",
		575_625_000:    "575.6",
		1_000_000:      "1.0",
		250_000:        "0.2", // FormatFloat rounds half to even
	}
	for in, want := range cases {
		if got := formatMillions(in); got != want {
			t.Fatalf("formatMillions(%v) = %q, want %q", in, got, want)
		}
	}
}
