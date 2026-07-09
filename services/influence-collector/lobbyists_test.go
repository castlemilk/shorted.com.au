package main

import (
	"strings"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

// Anchor the mode entrypoint (wired into main.go in a later change) so static
// analysis doesn't flag the run path as dead code.
var _ = runLobbyistsMode

// fixtureRows turns an embedded pipe-delimited fixture string into sheet rows.
// Cells are NOT trimmed here — readColumn owns whitespace handling (the real
// register export carries leading tabs/spaces on client names).
func fixtureRows(s string) [][]string {
	var rows [][]string
	for _, line := range strings.Split(strings.Trim(s, "\n"), "\n") {
		rows = append(rows, strings.Split(line, "|"))
	}
	return rows
}

func TestParseLobbyistClientRows(t *testing.T) {
	fixture := `Australian Government Register of Lobbyists — Clients
Client's Name|ABN|Date Published|Parent Organisation|Organisation's ABN
	TELSTRA GROUP LIMITED|56 650 620 303|11/08/2025|SEC Newgate Pty Limited|38162366056
 Autism Alliance National Limited|70 673 193 596|23/06/2026|First Tier Media Pty Ltd|92268817994
No ABN Client Pty Ltd||03/06/2025|Emerald House Advocacy Pty Ltd| 29 682 837 672
Bad ABN Client|12 34|03/06/2025|Emerald House Advocacy Pty Ltd|29682837672
||03/06/2025|Emerald House Advocacy Pty Ltd|29682837672`

	rows, err := parseLobbyistClientRows(fixtureRows(fixture))
	if err != nil {
		t.Fatalf("parseLobbyistClientRows: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("want 4 rows (blank client skipped), got %d: %+v", len(rows), rows)
	}

	first := rows[0]
	if first.ClientName != "TELSTRA GROUP LIMITED" {
		t.Fatalf("leading tab not trimmed: client name = %q", first.ClientName)
	}
	if first.ClientABN != "56650620303" {
		t.Fatalf("spaced ABN not normalized: %q", first.ClientABN)
	}
	if first.RegistrantName != "SEC Newgate Pty Limited" || first.RegistrantABN != "38162366056" {
		t.Fatalf("registrant = %q / %q", first.RegistrantName, first.RegistrantABN)
	}

	if rows[1].ClientABN != "70673193596" {
		t.Fatalf("second ABN = %q", rows[1].ClientABN)
	}

	noABN := rows[2]
	if noABN.ClientABN != "" {
		t.Fatalf("blank ABN must stay empty, got %q", noABN.ClientABN)
	}
	if noABN.RegistrantABN != "29682837672" {
		t.Fatalf("spaced registrant ABN not normalized: %q", noABN.RegistrantABN)
	}

	if rows[3].ClientABN != "" {
		t.Fatalf("malformed ABN must be dropped to empty, got %q", rows[3].ClientABN)
	}
}

func TestParseLobbyistClientRowsRejectsMissingColumns(t *testing.T) {
	_, err := parseLobbyistClientRows(fixtureRows(`Legal Name|Trading Name|ABN
227 Partners Pty Ltd|227 Partners|12 684 183 373`))
	if err == nil {
		t.Fatal("expected header-not-found error for the Organisations sheet shape")
	}
}

func TestParseLobbyistRegisterXLSXFindsClientsSheet(t *testing.T) {
	f := excelize.NewFile()
	defer func() { _ = f.Close() }()
	f.SetSheetName("Sheet1", "Dashboard")
	if err := f.SetSheetRow("Dashboard", "A1", &[]any{"Information is current as at 09/07/2026"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.NewSheet("Organisations"); err != nil {
		t.Fatal(err)
	}
	if err := f.SetSheetRow("Organisations", "A1", &[]any{"Legal Name", "Trading Name", "ABN", "Registered On", "Last Updated"}); err != nil {
		t.Fatal(err)
	}
	if err := f.SetSheetRow("Organisations", "A2", &[]any{"227 Partners Pty Ltd", "227 Partners", "12 684 183 373", "03/07/2025", "01/07/2026"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.NewSheet("Clients"); err != nil {
		t.Fatal(err)
	}
	if err := f.SetSheetRow("Clients", "A1", &[]any{"Client's Name", "ABN", "Date Published", "Parent Organisation", "Organisation's ABN"}); err != nil {
		t.Fatal(err)
	}
	if err := f.SetSheetRow("Clients", "A2", &[]any{"Energy Networks Association Limited", "75 106 735 406", "03/06/2025", "Emerald House Advocacy Pty Ltd", "29682837672"}); err != nil {
		t.Fatal(err)
	}
	buf, err := f.WriteToBuffer()
	if err != nil {
		t.Fatal(err)
	}

	rows, err := parseLobbyistRegisterXLSX(buf.Bytes())
	if err != nil {
		t.Fatalf("parseLobbyistRegisterXLSX: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 client row, got %d: %+v", len(rows), rows)
	}
	if rows[0].ClientName != "Energy Networks Association Limited" || rows[0].ClientABN != "75106735406" {
		t.Fatalf("row = %+v", rows[0])
	}
}

func TestParseLobbyistRegisterXLSXRejectsNonWorkbook(t *testing.T) {
	_, err := parseLobbyistRegisterXLSX([]byte("<html>blocked</html>"))
	if err == nil {
		t.Fatal("expected error for non-XLSX payload")
	}
	if !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("non-workbook payload must surface errSourceUnavailable, got: %v", err)
	}
}

func TestParseFITSActivityRows(t *testing.T) {
	// Two "Name" columns (registrant + foreign principal); dates are raw Excel
	// serials and the export duplicates rows per activity — both landmines from
	// the real exportExcelWithActivities file.
	fixture := `Name|Known as|Type|ABN|Foreign company business number|Last updated|Name|Description|Type|Start date|End date|Countries/Jurisdictions|Type|Last updated
Barton Deakin Pty Ltd|Barton Deakin Government Relations|Organisation|65140067287||45000.5|Californian Table Grape Commission|Providing policy and government engagement|Foreign government related entity|43713.47|43907.46|United States of America|Communications activity|45000.5
Barton Deakin Pty Ltd|Barton Deakin Government Relations|Organisation|65140067287||45000.5|Californian Table Grape Commission|Second activity for the same principal|Foreign government related entity|43713.47|43907.46|United States of America|Parliamentary lobbying|45000.5
United States Studies Centre||Organisation|85 122 586 341||45000.5|Foreign Principal Two|Research program|Foreign government related entity|44000.1|44100.2|United States of America|Communications activity|45000.5
No Abn Registrant||Individual|||45000.5|Foreign Principal Three|Advisory|Foreign political organisation|44000.1||Elsewhere|Communications activity|45000.5
Empty Principal Registrant||Organisation|11111111111||45000.5||No principal listed|Foreign government related entity|||Nowhere|Communications activity|45000.5`

	rows, err := parseFITSActivityRows(fixtureRows(fixture))
	if err != nil {
		t.Fatalf("parseFITSActivityRows: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("want 3 unique registrant/principal pairs, got %d: %+v", len(rows), rows)
	}

	first := rows[0]
	if first.RegistrantName != "Barton Deakin Pty Ltd" || first.RegistrantABN != "65140067287" {
		t.Fatalf("first registrant = %q / %q", first.RegistrantName, first.RegistrantABN)
	}
	if first.ForeignPrincipalName != "Californian Table Grape Commission" {
		t.Fatalf("first principal = %q", first.ForeignPrincipalName)
	}
	if rows[1].RegistrantABN != "85122586341" {
		t.Fatalf("spaced registrant ABN not normalized: %q", rows[1].RegistrantABN)
	}
	if rows[2].RegistrantABN != "" {
		t.Fatalf("missing ABN must stay empty, got %q", rows[2].RegistrantABN)
	}
}

func TestParseFITSActivityRowsRejectsMissingColumns(t *testing.T) {
	// Registrants-only export shape (single Name column) must be rejected —
	// the arrangement count needs the activities export.
	_, err := parseFITSActivityRows(fixtureRows(`Name|Known as|Type|ABN|Foreign company business number|Last updated
Barton Deakin Pty Ltd|Barton Deakin|Organisation|65140067287||45000.5`))
	if err == nil {
		t.Fatal("expected header-not-found error for registrants-only export")
	}
}

func TestNormalizeEntityName(t *testing.T) {
	cases := map[string]string{
		"Woolworths Group Limited":     "WOOLWORTHS", // suffix stripped twice, like normExpr
		"Telstra Group Limited":        "TELSTRA",
		"BHP Group Ltd":                "BHP",
		"Acme Pty Ltd":                 "ACME",
		"  A.C.M.E. (Australia) Ltd  ": "A C M E AUSTRALIA",
		"Limited":                      "LIMITED", // bare suffix is a name, not a suffix
		"":                             "",
	}
	for in, want := range cases {
		if got := normalizeEntityName(in); got != want {
			t.Fatalf("normalizeEntityName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCollapseCompanyNameMappingsSkipsAmbiguous(t *testing.T) {
	rows := []companyNameRow{
		{NormalizedName: "DUAL LISTED", StockCode: "AAA", Industry: "Materials", CompanyName: "Dual Listed Limited"},
		{NormalizedName: "DUAL LISTED", StockCode: "BBB", Industry: "Energy", CompanyName: "Dual Listed Holdings"},
		{NormalizedName: "WOOLWORTHS", StockCode: "WOW", Industry: "Consumer Staples", CompanyName: "Woolworths Group Limited"},
		{NormalizedName: "WOOLWORTHS", StockCode: "WOW", Industry: "Consumer Staples", CompanyName: "Woolworths Group Limited"},
		{NormalizedName: "", StockCode: "ZZZ", Industry: "Unclassified", CompanyName: "???"},
	}
	mappings := collapseCompanyNameMappings(rows)
	if len(mappings) != 1 {
		t.Fatalf("want 1 unambiguous mapping, got %d: %+v", len(mappings), mappings)
	}
	wow, ok := mappings["WOOLWORTHS"]
	if !ok || wow.StockCode != "WOW" || wow.CompanyName != "Woolworths Group Limited" {
		t.Fatalf("WOOLWORTHS mapping = %+v (ok=%v)", wow, ok)
	}
	if _, ok := mappings["DUAL LISTED"]; ok {
		t.Fatal("ambiguous normalized name must be skipped")
	}
}

func TestBuildLobbyistRecords(t *testing.T) {
	asOf := time.Date(2026, 7, 9, 0, 0, 0, 0, time.UTC)
	abnMappings := map[string]EntityMapping{
		"56650620303": {ABN: "56 650 620 303", StockCode: "TLS", Industry: "Telecommunication Services", CompanyName: "Telstra Group Limited", Confidence: 1.0},
	}
	nameMappings := map[string]CompanyNameMapping{
		"WOOLWORTHS": {StockCode: "WOW", Industry: "Consumer Staples", CompanyName: "Woolworths Group Limited"},
	}
	rows := []LobbyistClientRow{
		{ClientName: "TELSTRA GROUP LIMITED", ClientABN: "56650620303", RegistrantName: "SEC Newgate Pty Limited", RegistrantABN: "38162366056"},
		{ClientName: "Telstra Group Limited", ClientABN: "56650620303", RegistrantName: "Another Advisory Pty Ltd", RegistrantABN: "12684183373"},
		// Same registrant listed twice → still one distinct registrant.
		{ClientName: "Telstra Group Limited", ClientABN: "56650620303", RegistrantName: "SEC Newgate Pty Limited", RegistrantABN: "38162366056"},
		// No ABN in the register → exact normalized-name match.
		{ClientName: "Woolworths Group Limited", ClientABN: "", RegistrantName: "Emerald House Advocacy Pty Ltd", RegistrantABN: "29682837672"},
		// Unmatched name, no ABN → skipped.
		{ClientName: "Mystery Client Pty Ltd", ClientABN: "", RegistrantName: "SEC Newgate Pty Limited", RegistrantABN: "38162366056"},
		// ABN present but unmapped → skipped; must NOT fall back to name match.
		{ClientName: "Woolworths Group Limited", ClientABN: "99999999999", RegistrantName: "SEC Newgate Pty Limited", RegistrantABN: "38162366056"},
	}

	records, skipped := buildLobbyistRecords(rows, abnMappings, nameMappings, asOf)
	if skipped != 2 {
		t.Fatalf("skipped = %d, want 2", skipped)
	}
	if len(records) != 2 {
		t.Fatalf("want 2 aggregate records, got %d: %+v", len(records), records)
	}

	tls := records[0]
	if tls.StockCode != "TLS" || tls.SourceRecordID != "agd-lobbyists:TLS" {
		t.Fatalf("first record = %q / %q", tls.StockCode, tls.SourceRecordID)
	}
	if tls.SourceKey != lobbyistsSource || tls.SignalKind != "policy_footprint" {
		t.Fatalf("source/signal = %q / %q", tls.SourceKey, tls.SignalKind)
	}
	if tls.MetricKey != "registered_lobbyist_engagements" || tls.Unit != "count" {
		t.Fatalf("metric = %q / %q", tls.MetricKey, tls.Unit)
	}
	if tls.MetricValue == nil || *tls.MetricValue != 2 {
		t.Fatalf("TLS metric value = %v, want 2 distinct registrants", tls.MetricValue)
	}
	if tls.EntityABN != "56650620303" {
		t.Fatalf("TLS entity ABN = %q", tls.EntityABN)
	}
	wantSummary := "2 registrants list Telstra Group Limited as a client on the Australian Government Register of Lobbyists, as at 9 July 2026."
	if tls.Summary != wantSummary {
		t.Fatalf("TLS summary = %q, want %q", tls.Summary, wantSummary)
	}
	if !tls.AsOf.Equal(asOf) {
		t.Fatalf("TLS as_of = %v", tls.AsOf)
	}
	if tls.SourceURL != lobbyistRegisterURL {
		t.Fatalf("TLS source URL = %q", tls.SourceURL)
	}
	if methods, ok := tls.Metadata["match_methods"].([]string); !ok || len(methods) != 1 || methods[0] != "exact_abn" {
		t.Fatalf("TLS match methods = %v", tls.Metadata["match_methods"])
	}

	wow := records[1]
	if wow.StockCode != "WOW" || wow.MetricValue == nil || *wow.MetricValue != 1 {
		t.Fatalf("WOW record = %+v", wow)
	}
	if wow.EntityABN != "" {
		t.Fatalf("name-matched aggregate must not carry an ABN, got %q", wow.EntityABN)
	}
	if !strings.HasPrefix(wow.Summary, "1 registrant lists Woolworths Group Limited as a client") {
		t.Fatalf("WOW summary = %q", wow.Summary)
	}
	if methods, ok := wow.Metadata["match_methods"].([]string); !ok || len(methods) != 1 || methods[0] != "name_exact" {
		t.Fatalf("WOW match methods = %v", wow.Metadata["match_methods"])
	}
}

func TestBuildLobbyistRecordsSkipsAmbiguousNames(t *testing.T) {
	asOf := time.Date(2026, 7, 9, 0, 0, 0, 0, time.UTC)
	// Build the name map through the same collapse the DB loader uses: the
	// ambiguous name never enters the map, so the client row is skipped.
	nameMappings := collapseCompanyNameMappings([]companyNameRow{
		{NormalizedName: "DUAL LISTED", StockCode: "AAA", Industry: "Materials", CompanyName: "Dual Listed Limited"},
		{NormalizedName: "DUAL LISTED", StockCode: "BBB", Industry: "Energy", CompanyName: "Dual Listed Holdings"},
	})
	rows := []LobbyistClientRow{
		{ClientName: "Dual Listed Pty Ltd", ClientABN: "", RegistrantName: "SEC Newgate Pty Limited", RegistrantABN: "38162366056"},
	}
	records, skipped := buildLobbyistRecords(rows, map[string]EntityMapping{}, nameMappings, asOf)
	if len(records) != 0 {
		t.Fatalf("ambiguous client name must produce no records, got %+v", records)
	}
	if skipped != 1 {
		t.Fatalf("skipped = %d, want 1", skipped)
	}
}

func TestBuildFITSRecords(t *testing.T) {
	asOf := time.Date(2026, 7, 9, 0, 0, 0, 0, time.UTC)
	abnMappings := map[string]EntityMapping{
		"65140067287": {ABN: "65140067287", StockCode: "BDK", Industry: "Commercial Services", CompanyName: "Barton Deakin Limited", Confidence: 1.0},
	}
	nameMappings := map[string]CompanyNameMapping{
		"ACME": {StockCode: "ACM", Industry: "Materials", CompanyName: "Acme Limited"},
	}
	rows := []FITSArrangementRow{
		{RegistrantName: "Barton Deakin Pty Ltd", RegistrantABN: "65140067287", ForeignPrincipalName: "Californian Table Grape Commission"},
		{RegistrantName: "Barton Deakin Pty Ltd", RegistrantABN: "65140067287", ForeignPrincipalName: "Foreign Principal Two"},
		// Same principal spelled with different whitespace → one distinct principal.
		{RegistrantName: "Barton Deakin Pty Ltd", RegistrantABN: "65140067287", ForeignPrincipalName: "Californian  Table Grape Commission"},
		// No ABN → exact normalized-name match.
		{RegistrantName: "Acme Pty Ltd", RegistrantABN: "", ForeignPrincipalName: "Foreign Principal Three"},
		// Unmatched registrant → skipped.
		{RegistrantName: "Unknown Registrant", RegistrantABN: "", ForeignPrincipalName: "Foreign Principal Four"},
	}

	records, skipped := buildFITSRecords(rows, abnMappings, nameMappings, asOf)
	if skipped != 1 {
		t.Fatalf("skipped = %d, want 1", skipped)
	}
	if len(records) != 2 {
		t.Fatalf("want 2 aggregate records, got %d: %+v", len(records), records)
	}

	acm := records[0]
	if acm.StockCode != "ACM" || acm.SourceRecordID != "agd-fits:ACM" {
		t.Fatalf("first record = %q / %q", acm.StockCode, acm.SourceRecordID)
	}
	if !strings.HasPrefix(acm.Summary, "1 foreign principal is disclosed for Acme Limited") {
		t.Fatalf("ACM summary = %q", acm.Summary)
	}

	bdk := records[1]
	if bdk.SourceKey != fitsSource || bdk.SignalKind != "policy_footprint" {
		t.Fatalf("source/signal = %q / %q", bdk.SourceKey, bdk.SignalKind)
	}
	if bdk.MetricKey != "registered_foreign_principals" || bdk.Unit != "count" {
		t.Fatalf("metric = %q / %q", bdk.MetricKey, bdk.Unit)
	}
	if bdk.MetricValue == nil || *bdk.MetricValue != 2 {
		t.Fatalf("BDK metric value = %v, want 2 distinct principals", bdk.MetricValue)
	}
	if bdk.EntityABN != "65140067287" {
		t.Fatalf("BDK entity ABN = %q", bdk.EntityABN)
	}
	wantSummary := "2 foreign principals are disclosed for Barton Deakin Limited on the Foreign Influence Transparency Scheme public register, as at 9 July 2026."
	if bdk.Summary != wantSummary {
		t.Fatalf("BDK summary = %q, want %q", bdk.Summary, wantSummary)
	}
	if bdk.SourceURL != fitsRegisterURL {
		t.Fatalf("BDK source URL = %q", bdk.SourceURL)
	}
}

func TestFirstHardRegisterError(t *testing.T) {
	unavailable := &errSourceUnavailable{SourceKey: fitsSource, Reason: "HTTP 403"}
	if err := firstHardRegisterError(nil, unavailable); err != nil {
		t.Fatalf("unavailable source must not be a hard error, got %v", err)
	}
	hard := parseErrForTest()
	if err := firstHardRegisterError(unavailable, hard); err != hard {
		t.Fatalf("want the hard error back, got %v", err)
	}
}

func parseErrForTest() error {
	_, err := parseLobbyistClientRows([][]string{{"not", "a", "header"}})
	return err
}
