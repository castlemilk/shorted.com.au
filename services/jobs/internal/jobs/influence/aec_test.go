package influence

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

const aecDonationsFixture = "\xef\xbb\xbf" + `"Financial Year","Donor Name","Donation Made To","Date","Value"
"2024-25","Woodside Energy Group Ltd","Australian Labor Party (ALP)","18/07/2024","12000"
"2024-25","          Allianz Australia Limited ","National Party of Australia (WA) Inc","","3300"
"1998-1999","Old Format Co Pty Ltd","Liberal Party of Australia","24/09/1998","10000"
"2024-25","Zero Value Donor","Some Party","01/07/2024","0"
"2024-25","","Some Party","01/07/2024","5000"
"2024-25","Repeat Donor Pty Ltd","Advance Australia","02/07/2024","1000"
"2024-25","Repeat Donor Pty Ltd","Advance Australia","02/07/2024","1000"
`

const aecReceiptsFixture = `"Financial Year","Return Type","Recipient Name","Received From","Receipt Type","Value"
"2024-25","Political Party Return","Australian Labor Party","TABCORP HOLDINGS LIMITED","Donation Received","13000"
"2026-27","Political Party Return","A Party","Woodside Energy Group Ltd","Other Receipt","6000"
"2024-25","Significant Third Party Return","Advance Australia","","Donation Received","1000"
`

func TestParseAECDonationsMadeCSV(t *testing.T) {
	rows, err := parseAECDonationsMadeCSV([]byte(aecDonationsFixture), "https://example.test/AllAnnualData")
	if err != nil {
		t.Fatalf("parseAECDonationsMadeCSV: %v", err)
	}
	// Zero-value and blank-donor rows are skipped; duplicates are kept.
	if len(rows) != 5 {
		t.Fatalf("want 5 rows, got %d: %+v", len(rows), rows)
	}

	first := rows[0]
	if first.RecordKind != aecKindDonationMade {
		t.Fatalf("record kind = %q", first.RecordKind)
	}
	if first.EntityName != "Woodside Energy Group Ltd" || first.CounterpartyName != "Australian Labor Party (ALP)" {
		t.Fatalf("entity/counterparty = %q / %q", first.EntityName, first.CounterpartyName)
	}
	if first.FinancialYear != "2024-25" || first.FinancialYearEnd != 2025 {
		t.Fatalf("financial year = %q (%d)", first.FinancialYear, first.FinancialYearEnd)
	}
	if first.Value != 12000 {
		t.Fatalf("value = %v", first.Value)
	}
	if first.TransactionDate == nil || first.TransactionDate.Format("2006-01-02") != "2024-07-18" {
		t.Fatalf("transaction date = %v", first.TransactionDate)
	}
	if first.ReturnType != aecDonorReturnType {
		t.Fatalf("return type = %q", first.ReturnType)
	}

	// Whitespace-padded names are trimmed; empty dates parse to nil.
	second := rows[1]
	if second.EntityName != "Allianz Australia Limited" {
		t.Fatalf("trimmed entity name = %q", second.EntityName)
	}
	if second.TransactionDate != nil {
		t.Fatalf("empty date should be nil, got %v", second.TransactionDate)
	}

	// Old "1998-1999" financial-year labels parse to the ending year.
	third := rows[2]
	if third.FinancialYear != "1998-1999" || third.FinancialYearEnd != 1999 {
		t.Fatalf("old-format financial year = %q (%d)", third.FinancialYear, third.FinancialYearEnd)
	}

	// Byte-identical duplicate rows get distinct occurrence counters.
	if rows[3].Occurrence != 1 || rows[4].Occurrence != 2 {
		t.Fatalf("duplicate occurrences = %d / %d", rows[3].Occurrence, rows[4].Occurrence)
	}
}

func TestParseAECDetailedReceiptsCSV(t *testing.T) {
	rows, err := parseAECDetailedReceiptsCSV([]byte(aecReceiptsFixture), "https://example.test/AllAnnualData")
	if err != nil {
		t.Fatalf("parseAECDetailedReceiptsCSV: %v", err)
	}
	// The blank Received From row is skipped.
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d: %+v", len(rows), rows)
	}

	first := rows[0]
	if first.RecordKind != aecKindDetailedReceipt {
		t.Fatalf("record kind = %q", first.RecordKind)
	}
	if first.EntityName != "TABCORP HOLDINGS LIMITED" || first.CounterpartyName != "Australian Labor Party" {
		t.Fatalf("entity/counterparty = %q / %q", first.EntityName, first.CounterpartyName)
	}
	if first.ReturnType != "Political Party Return" || first.ReceiptType != "Donation Received" {
		t.Fatalf("return/receipt type = %q / %q", first.ReturnType, first.ReceiptType)
	}
	if first.Value != 13000 || first.FinancialYearEnd != 2025 {
		t.Fatalf("value/year = %v / %d", first.Value, first.FinancialYearEnd)
	}
	if first.TransactionDate != nil {
		t.Fatalf("receipts have no transaction date, got %v", first.TransactionDate)
	}
}

func TestParseAECCSVRejectsMissingColumns(t *testing.T) {
	if _, err := parseAECDonationsMadeCSV([]byte("Donor Name,Value\nAcme,100\n"), "u"); err == nil {
		t.Fatal("donations parser should reject missing columns")
	}
	if _, err := parseAECDetailedReceiptsCSV([]byte("Recipient Name,Value\nParty,100\n"), "u"); err == nil {
		t.Fatal("receipts parser should reject missing columns")
	}
}

func TestParseAECFinancialYear(t *testing.T) {
	cases := []struct {
		in     string
		want   int
		wantOK bool
	}{
		{"2024-25", 2025, true},
		{"2011-12", 2012, true},
		{"1998-1999", 1999, true},
		{" 2026-27 ", 2027, true},
		{"", 0, false},
		{"n/a", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseAECFinancialYear(tc.in)
		if ok != tc.wantOK || got != tc.want {
			t.Fatalf("parseAECFinancialYear(%q) = %d, %v; want %d, %v", tc.in, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestParseAECArchive(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range map[string]string{
		"Donations Made.csv":    aecDonationsFixture,
		"Detailed Receipts.csv": aecReceiptsFixture,
		"Party Returns.csv":     "Financial Year,Name\n2024-25,Some Party\n", // ignored member
	} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %q: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %q: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}

	rows, files, err := parseAECArchive(buf.Bytes(), 2)
	if err != nil {
		t.Fatalf("parseAECArchive: %v", err)
	}
	if files != 2 {
		t.Fatalf("files parsed = %d, want 2", files)
	}
	if len(rows) != 7 { // 5 donation rows + 2 receipt rows
		t.Fatalf("rows = %d, want 7", len(rows))
	}
	// Donor-declared donations are ingested first.
	if rows[0].RecordKind != aecKindDonationMade || rows[len(rows)-1].RecordKind != aecKindDetailedReceipt {
		t.Fatalf("row ordering: first=%q last=%q", rows[0].RecordKind, rows[len(rows)-1].RecordKind)
	}

	// A cap of 1 parses only the donations file.
	capped, files, err := parseAECArchive(buf.Bytes(), 1)
	if err != nil {
		t.Fatalf("parseAECArchive cap=1: %v", err)
	}
	if files != 1 || len(capped) != 5 {
		t.Fatalf("cap=1: files=%d rows=%d, want 1/5", files, len(capped))
	}
}

func TestNormalizeAECEntityName(t *testing.T) {
	cases := map[string]string{
		"Woodside Energy Group Ltd":  "WOODSIDE ENERGY",
		"WOODSIDE ENERGY GROUP LTD":  "WOODSIDE ENERGY",
		"Wesfarmers Limited":         "WESFARMERS",
		"FORTESCUE LTD":              "FORTESCUE",
		"  Tabcorp Holdings Limited": "TABCORP",
		"A.C.M.E. Pty. Ltd.":         "A C M E",
		"":                           "",
	}
	for in, want := range cases {
		if got := normalizeAECEntityName(in); got != want {
			t.Fatalf("normalizeAECEntityName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildAECNameIndexDropsAmbiguousNames(t *testing.T) {
	index := buildAECNameIndex(map[string]EntityMapping{
		"11222333444": {ABN: "11 222 333 444", StockCode: "WDS", Industry: "Energy", CompanyName: "Woodside Energy Group Ltd", Confidence: 1},
		"55666777888": {ABN: "55666777888", StockCode: "AAA", Industry: "Materials", CompanyName: "Ambiguous Name Ltd", Confidence: 1},
		"99000111222": {ABN: "99000111222", StockCode: "BBB", Industry: "Materials", CompanyName: "Ambiguous Name Group", Confidence: 1},
	})
	if _, ok := index["WOODSIDE ENERGY"]; !ok {
		t.Fatal("expected WOODSIDE ENERGY in index")
	}
	if _, ok := index["AMBIGUOUS NAME"]; ok {
		t.Fatal("ambiguous normalized names must be dropped, not guessed")
	}
}

func TestBuildAECIndustryRecords(t *testing.T) {
	index := buildAECNameIndex(map[string]EntityMapping{
		"11222333444": {ABN: "11 222 333 444", StockCode: "WDS", Industry: "Energy", CompanyName: "Woodside Energy Group Ltd", Confidence: 0.9},
	})

	date := parseAECDate("18/07/2024")
	rows := []AECReceiptRow{
		{
			RecordKind:       aecKindDonationMade,
			FinancialYear:    "2024-25",
			FinancialYearEnd: 2025,
			ReturnType:       aecDonorReturnType,
			EntityName:       "WOODSIDE ENERGY GROUP LTD", // register-case variant still exact-matches
			CounterpartyName: "Australian Labor Party (ALP)",
			TransactionDate:  date,
			Value:            12000,
			Occurrence:       1,
			SourceURL:        aecAllAnnualDataURL,
		},
		{
			RecordKind:       aecKindDetailedReceipt,
			FinancialYear:    "2026-27",
			FinancialYearEnd: 2027,
			ReturnType:       "Political Party Return",
			EntityName:       "Woodside Energy Group Ltd",
			CounterpartyName: "A Party",
			ReceiptType:      "Other Receipt",
			Value:            6000,
			Occurrence:       1,
			SourceURL:        aecAllAnnualDataURL,
		},
		{
			RecordKind:       aecKindDonationMade,
			FinancialYear:    "2024-25",
			FinancialYearEnd: 2025,
			EntityName:       "Completely Unmapped Pty Ltd",
			CounterpartyName: "Some Party",
			Value:            5000,
			Occurrence:       1,
			SourceURL:        aecAllAnnualDataURL,
		},
	}

	records, skipped := buildAECIndustryRecords(rows, index)
	if skipped != 1 {
		t.Fatalf("skipped = %d, want 1 (no fuzzy fallback)", skipped)
	}
	if len(records) != 2 {
		t.Fatalf("records = %d, want 2", len(records))
	}

	donation := records[0]
	if donation.SourceKey != aecSource || donation.SignalKind != "policy_footprint" {
		t.Fatalf("source/signal = %q / %q", donation.SourceKey, donation.SignalKind)
	}
	if donation.StockCode != "WDS" || donation.EntityABN != "11222333444" {
		t.Fatalf("stock/abn = %q / %q", donation.StockCode, donation.EntityABN)
	}
	if donation.MetricKey != "declared_donation_value" || donation.MetricLabel != "Declared donation (AEC annual return)" {
		t.Fatalf("metric = %q / %q", donation.MetricKey, donation.MetricLabel)
	}
	if donation.Unit != "AUD" || donation.MetricValue == nil || *donation.MetricValue != 12000 {
		t.Fatalf("unit/value = %q / %v", donation.Unit, donation.MetricValue)
	}
	if donation.PeriodStart == nil || donation.PeriodStart.Format("2006-01-02") != "2024-07-01" {
		t.Fatalf("period start = %v", donation.PeriodStart)
	}
	if donation.PeriodEnd == nil || donation.PeriodEnd.Format("2006-01-02") != "2025-06-30" {
		t.Fatalf("period end = %v", donation.PeriodEnd)
	}
	if donation.AsOf.Format("2006-01-02") != "2024-07-18" {
		t.Fatalf("as_of = %v, want the transaction date", donation.AsOf)
	}
	if donation.Title != "AEC return: Woodside Energy Group Ltd" {
		t.Fatalf("title = %q", donation.Title)
	}
	wantSummary := "Woodside Energy Group Ltd declared a donation of $12,000 made to Australian Labor Party (ALP) in its 2024-25 annual return lodged with the AEC."
	if donation.Summary != wantSummary {
		t.Fatalf("summary = %q, want %q", donation.Summary, wantSummary)
	}
	if donation.SourceURL != aecAllAnnualDataURL {
		t.Fatalf("source URL = %q", donation.SourceURL)
	}
	if donation.Confidence != 0.9 {
		t.Fatalf("confidence = %v", donation.Confidence)
	}
	if donation.Metadata["match_method"] != "name_exact" || donation.Metadata["financial_year"] != "2024-25" {
		t.Fatalf("metadata = %+v", donation.Metadata)
	}
	if donation.Metadata["donor_name"] != "WOODSIDE ENERGY GROUP LTD" || donation.Metadata["recipient_name"] != "Australian Labor Party (ALP)" {
		t.Fatalf("donor/recipient metadata = %+v", donation.Metadata)
	}
	if donation.Metadata["return_type"] != aecDonorReturnType {
		t.Fatalf("return_type metadata = %+v", donation.Metadata["return_type"])
	}
	if _, ok := donation.Metadata["threshold_note"]; ok {
		t.Fatal("FY2024-25 record must not carry the threshold note")
	}
	if !strings.HasPrefix(donation.SourceRecordID, "aec-donation:") {
		t.Fatalf("record ID = %q", donation.SourceRecordID)
	}

	receipt := records[1]
	if receipt.MetricKey != "declared_receipt_value" || receipt.MetricLabel != "Declared receipt (AEC annual return)" {
		t.Fatalf("receipt metric = %q / %q", receipt.MetricKey, receipt.MetricLabel)
	}
	wantReceiptSummary := "A Party declared receipts of $6,000 received from Woodside Energy Group Ltd in its 2026-27 annual return lodged with the AEC."
	if receipt.Summary != wantReceiptSummary {
		t.Fatalf("receipt summary = %q, want %q", receipt.Summary, wantReceiptSummary)
	}
	if receipt.AsOf.Format("2006-01-02") != "2027-06-30" {
		t.Fatalf("receipt as_of = %v, want the FY period end fallback", receipt.AsOf)
	}
	note, ok := receipt.Metadata["threshold_note"].(string)
	if !ok || !strings.Contains(note, "1 Jul 2026") {
		t.Fatalf("FY2026-27 record must carry the threshold-change note, got %v", receipt.Metadata["threshold_note"])
	}
	if receipt.Metadata["receipt_type"] != "Other Receipt" || receipt.Metadata["received_from"] != "Woodside Energy Group Ltd" {
		t.Fatalf("receipt metadata = %+v", receipt.Metadata)
	}
	if _, ok := receipt.Metadata["donor_name"]; ok {
		t.Fatal("detailed receipts must not label the payer as donor_name")
	}
	if !strings.HasPrefix(receipt.SourceRecordID, "aec-receipt:") {
		t.Fatalf("receipt record ID = %q", receipt.SourceRecordID)
	}
	if receipt.SourceRecordID == donation.SourceRecordID {
		t.Fatal("record IDs must be distinct")
	}
}

func TestBuildAECIndustryRecordDuplicateOccurrencesGetDistinctIDs(t *testing.T) {
	mapping := EntityMapping{ABN: "11222333444", StockCode: "WDS", Industry: "Energy", CompanyName: "Woodside Energy Group Ltd", Confidence: 1}
	row := AECReceiptRow{
		RecordKind:       aecKindDonationMade,
		FinancialYear:    "2024-25",
		FinancialYearEnd: 2025,
		EntityName:       "Woodside Energy Group Ltd",
		CounterpartyName: "Advance Australia",
		Value:            1000,
		Occurrence:       1,
		SourceURL:        aecAllAnnualDataURL,
	}
	first := buildAECIndustryRecord(row, mapping)
	row.Occurrence = 2
	second := buildAECIndustryRecord(row, mapping)
	if first.SourceRecordID == second.SourceRecordID {
		t.Fatal("identical duplicate rows must produce distinct record IDs via the occurrence counter")
	}
}

func TestFormatAUDAmount(t *testing.T) {
	cases := map[float64]string{
		950:       "$950",
		12000:     "$12,000",
		1250000.5: "$1,250,000.5",
		-3300:     "-$3,300",
	}
	for in, want := range cases {
		if got := formatAUDAmount(in); got != want {
			t.Fatalf("formatAUDAmount(%v) = %q, want %q", in, got, want)
		}
	}
}
