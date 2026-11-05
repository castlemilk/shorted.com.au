package ownership

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

// testCodes is a listed-company set for the holdings parsers.
var testCodes = codeSet{
	"BHP": {Code: "BHP", Name: "BHP Group Limited"},
	"CBA": {Code: "CBA", Name: "Commonwealth Bank of Australia"},
	"CSL": {Code: "CSL", Name: "CSL Limited"},
	"WTC": {Code: "WTC", Name: "WiseTech Global Limited"},
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "holdings", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func holdingFor(t *testing.T, snap snapshot, code string) holding {
	t.Helper()
	for _, h := range snap.Holdings {
		if h.Code == code {
			return h
		}
	}
	t.Fatalf("no %s holding in %+v", code, snap.Holdings)
	return holding{}
}

func TestParseISharesJSON(t *testing.T) {
	src := etfSources[0]
	snap, err := parseISharesJSON(src, readFixture(t, "ishares_ioz.json"), testCodes)
	if err != nil {
		t.Fatal(err)
	}
	if snap.RowsTotal != 3 || len(snap.Holdings) != 2 {
		t.Fatalf("rows %d holdings %d, want 3 rows (one not an equity) and 2 holdings", snap.RowsTotal, len(snap.Holdings))
	}
	bhp := holdingFor(t, snap, "BHP")
	if *bhp.Units != 18291028 || *bhp.Value != 1060879624 || *bhp.Weight != 11.13356 {
		t.Errorf("BHP %v %v %v", *bhp.Units, *bhp.Value, *bhp.Weight)
	}
	if id := snap.Identifiers["AU000000BHP4"]; id.Code != "BHP" || id.Kind != "isin" {
		t.Errorf("ISIN map %+v", snap.Identifiers)
	}
	if id := snap.Identifiers["6144690"]; id.Code != "BHP" || id.Kind != "sedol" {
		t.Errorf("SEDOL map %+v", snap.Identifiers)
	}
	if got := parseISharesAsAt(readFixture(t, "ishares_ioz.csv")); got != "2026-10-15" {
		t.Errorf("as at %q", got)
	}
}

func TestParseVanguardJSON(t *testing.T) {
	body := bytes.Replace(readFixture(t, "vanguard_vas.json"), []byte(`"data": [`),
		[]byte(`"data": [{"ticker": "AAPL", "name": "Apple", "marketValPercent": 1, "marketValue": 5, "units": 1, "countryCode": "US", "effectiveDate": "2026-09-30"}, `), 1)
	snap, err := parseVanguardJSON(vanguard("VAS", "VAS", "8205"), body, testCodes)
	if err != nil {
		t.Fatal(err)
	}
	if snap.AsAt != "2026-09-30" || len(snap.Holdings) != 2 || snap.RowsTotal != 3 {
		t.Fatalf("as at %q, %d holdings of %d rows", snap.AsAt, len(snap.Holdings), snap.RowsTotal)
	}
	if cba := holdingFor(t, snap, "CBA"); *cba.Units != 32911364 {
		t.Errorf("CBA units %v", *cba.Units)
	}
}

func TestParseBetashares(t *testing.T) {
	snap, err := parseBetashares(betashares("A200", "A200"), readFixture(t, "betashares_a200.csv"), testCodes)
	if err != nil {
		t.Fatal(err)
	}
	// NAB is not in testCodes: counted, not stored.
	if snap.AsAt != "2026-10-15" || len(snap.Holdings) != 2 || snap.RowsTotal != 3 {
		t.Fatalf("as at %q, %d holdings of %d rows", snap.AsAt, len(snap.Holdings), snap.RowsTotal)
	}
	if bhp := holdingFor(t, snap, "BHP"); *bhp.Value != 1306147924.62 || *bhp.Units != 21461517 {
		t.Errorf("BHP %v %v", *bhp.Value, *bhp.Units)
	}
}

func TestParseSPDRXLSX(t *testing.T) {
	f := excelize.NewFile()
	rows := [][]any{
		{"Fund Name:", "SPDR S&P/ASX 200 Fund"},
		{"Ticker Symbol:", "STW"},
		{"Holdings:", "As of 16-Oct-2026"},
		{},
		{"ISIN", "SEDOL", "Ticker", "Name", "Local Currency", "Number of Shares", "Weight (%)", "Trade Country Name", "Local Price"},
		{"AU000000BHP4", "6144690", "BHP-AU", "Bhp Group Ltd", "AUD", "12331803", "11.425461", "Australia", "60.03"},
		{"", "", "AUD", "Cash", "AUD", "1000", "0.1", "", "1"},
	}
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow("Sheet1", cell, &r); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	snap, err := parseSPDRXLSX(spdr("STW", "STW"), buf.Bytes(), testCodes)
	if err != nil {
		t.Fatal(err)
	}
	if snap.AsAt != "2026-10-16" || len(snap.Holdings) != 1 {
		t.Fatalf("as at %q, holdings %+v", snap.AsAt, snap.Holdings)
	}
	bhp := snap.Holdings[0]
	// No market value column: shares x price.
	if *bhp.Units != 12331803 || *bhp.Value != 12331803*60.03 {
		t.Errorf("BHP units %v value %v", *bhp.Units, *bhp.Value)
	}
	if snap.Identifiers["6144690"].Code != "BHP" {
		t.Errorf("identifiers %+v", snap.Identifiers)
	}
}

func TestAsxTicker(t *testing.T) {
	for in, want := range map[string]string{"BHP": "BHP", "BHP AU": "BHP", "BHP AT": "BHP", "BHP-AU": "BHP", "ASX:BHP": "BHP", "bhp au": "BHP", "AAPL": "", "BHP US": ""} {
		got, _ := testCodes.asxTicker(in)
		if got != want {
			t.Errorf("asxTicker(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParsePHDLayouts(t *testing.T) {
	period := time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC)
	ids := map[string]identifier{"AU000000CBA7": {Kind: "isin", Code: "CBA"}, "6144690": {Kind: "sedol", Code: "BHP"}}
	tests := []struct {
		name   string
		rows   [][]string
		want   map[string][3]float64 // units, value, weight
		asAt   string
		ignore []string
	}{
		{
			name: "schedule 8D (Aware, Rest, Brighter): Bloomberg tickers, cash rows, a duplicate line summed",
			rows: [][]string{
				{"PHD SCHEDULE 8D TABLE 1 - PORTFOLIO HOLDINGS INFORMATION"},
				{"ASSET CLASS", "INTERNALLY MANAGED OR EXTERNALLY MANAGED", "NAME OF INSTITUTION", "NAME OF ISSUER / COUNTERPARTY", "NAME OF FUND MANAGER", "NAME / KIND OF INVESTMENT ITEM", "CURRENCY", "SECURITY IDENTIFIER", "ADDRESS", "% OWNERSHIP / PROPERTY HELD", "UNITS HELD", "VALUE(AUD)", "WEIGHTING(%)"},
				{"CASH", "-", "COMMONWEALTH BANK OF AUSTRALIA", "-", "-", "-", "AUD", "-", "-", "", "", "$262,610,510", "0.81%"},
				{"LISTED EQUITY", "-", "-", "-", "-", "BHP GROUP LTD.", "-", "BHP AU", "-", "", "14,488,985", "$860,645,623", "2.66%"},
				{"LISTED EQUITY", "-", "-", "-", "-", "BHP GROUP LTD.", "-", "BHP AU", "-", "", "1,000", "$60,000", "0.01%"},
				{"LISTED EQUITY", "-", "-", "-", "-", "APPLE INC", "USD", "AAPL US", "-", "", "1,000", "$100", "0.00%"},
			},
			want: map[string][3]float64{"BHP": {14489985, 860705623, 2.67}},
			asAt: "2026-06-30",
		},
		{
			name: "HESTA: ISINs, weights as fractions, a date column",
			rows: [][]string{
				{"Effective Date", "Option", "Asset Class", "Internal/External", "Name/kind of investment item", "Units", "Value (AUD)", "Weighting", "% Ownership / Property Held", "Address", "Currency", "Security Identifier"},
				{"30/06/2026", "Balanced Growth", "Listed Equity", "", "Commonwealth Bank of Australia", "9380653.29", "1544243145.64", "0.01937872", "", "", "", "AU000000CBA7"},
				{"30/06/2026", "Balanced Growth", "Fixed Income", "", "Commonwealth Bank of Australia", "5", "5", "0.00000001", "", "", "AUD", "AU000000CBA7"},
			},
			want: map[string][3]float64{"CBA": {9380653.29, 1544243145.64, 1.937872}},
			asAt: "2026-06-30",
		},
		{
			name: "Cbus: SEDOLs, a section column, a value with a total beside it",
			rows: [][]string{
				{"Section", "Table Order", "Security Name", "Portfolio Name", "Manager Name", "Issuer", "Institution", "Security Identifier", "Ownership%", "Address", "Local Currency", "Units Held", "Market Value", "Weight"},
				{"Listed equities", "04", "BHP GROUP (AU)", "", "", "", "", "6144690", "", "", "", " 33085890.37", "1965301888.1", "2.3092 %"},
			},
			want: map[string][3]float64{"BHP": {33085890.37, 1965301888.1, 2.3092}},
		},
		{
			name: "Mercer, Legalsuper: bare tickers count only when the name is the company",
			rows: [][]string{
				{"Option", "Asset class", "Listing type", "Type", "Name of institution / issuer", "Currency", "Security identifier", "% ownership", "Address", "Units held", "Value (AUD)", "Weighting (%)"},
				{"CSDCS - Mercer Growth", "Equity", "Listed", "", "BHP GROUP LTD", "", "BHP", "", "", "258049.18", "$15,328,121.78 ", "1.20%"},
				// Carlisle Companies trades as CSL on the NYSE.
				{"CSDCS - Mercer Growth", "Equity", "Listed", "", "CARLISLE COMPANIES INC", "", "CSL", "", "", "100", "$40,000", "0.01%"},
				{"CSDCS - Mercer Growth", "Equity", "Listed", "", "CSL LTD", "", "CSL", "", "", "200", "$50,000", "0.02%"},
			},
			want:   map[string][3]float64{"BHP": {258049.18, 15328121.78, 1.20}, "CSL": {200, 50000, 0.02}},
			ignore: []string{"CARLISLE"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			snap, err := parsePHD(phdSource{Institution: "x", Option: "y"}, "u", tc.rows, testCodes, ids, period)
			if err != nil {
				t.Fatal(err)
			}
			if len(snap.Holdings) != len(tc.want) {
				t.Fatalf("holdings %+v, want %d", snap.Holdings, len(tc.want))
			}
			for code, w := range tc.want {
				h := holdingFor(t, snap, code)
				if !near(*h.Units, w[0]) || !near(*h.Value, w[1]) || !near(*h.Weight, w[2]) {
					t.Errorf("%s units %v value %v weight %v, want %v", code, *h.Units, *h.Value, *h.Weight, w)
				}
			}
			if tc.asAt != "" && snap.AsAt != tc.asAt {
				t.Errorf("as at %q, want %q", snap.AsAt, tc.asAt)
			}
		})
	}
}

func near(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-6*(1+b)
}

func TestPHDPeriod(t *testing.T) {
	for now, want := range map[string]string{
		"2026-10-17": "2026-06-30", // June due by 28 September
		"2026-09-27": "2025-12-31",
		"2027-03-31": "2026-12-31",
		"2027-03-30": "2026-06-30",
	} {
		n, _ := time.Parse("2006-01-02", now)
		if got := phdPeriod(n).Format("2006-01-02"); got != want {
			t.Errorf("phdPeriod(%s) = %s, want %s", now, got, want)
		}
	}
	p := time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC)
	if got := expandPeriod("x/{month}-{yyyy}/b_{dd}{month}{yyyy}.csv", p); got != "x/june-2026/b_30june2026.csv" {
		t.Errorf("expandPeriod = %s", got)
	}
	if got := previousPeriod(p).Format("2006-01-02"); got != "2025-12-31" {
		t.Errorf("previousPeriod = %s", got)
	}
}

func TestParseAPRAFunds(t *testing.T) {
	rows := [][]string{
		{"Table 2: Fund-level profile and financial performance"},
		{"Period", "Fund name", "ABN", "RSE Regulatory classification", "Fund type", "RSE Membership base", "Fund's RSE licensee", "RSE licensee ownership type", "RSE licensee profit status", "RSE licensee board structure", "RSE Balance date", "Duration", "RSE Wind up date", "Total assets"},
		{"", "", "", "", "", "", "", "", "", "", "", "Financial flow duration only", "", "SRF 320.0 item 11"},
		{"45838", "AustralianSuper", "65714394898", "Public offer", "Industry", "General base", "AustralianSuper Pty Ltd", "", "", "", "45838", "12", "", "365000000"},
		{"45838", "Some Corporate Fund", "12345678901", "Non public offer", "Corporate", "", "Some Trustee Ltd", "", "", "", "", "", "", "1000"},
	}
	funds, err := parseAPRAFunds(rows, "u")
	if err != nil {
		t.Fatal(err)
	}
	if len(funds) != 2 {
		t.Fatalf("funds %+v", funds)
	}
	as := funds[0]
	if as.Key != "abn:65714394898" || as.InstitutionSlug != "australiansuper" || *as.AUM != 365e9 || as.AsAt != "2025-06-30" || as.Category != "Industry" {
		t.Errorf("AustralianSuper %+v aum %v", as, *as.AUM)
	}
	if funds[1].InstitutionSlug != "" {
		t.Errorf("an unmapped fund linked to %q", funds[1].InstitutionSlug)
	}
}

func TestParseASXProducts(t *testing.T) {
	etp := [][]string{
		{"", "Exchange Traded Product"},
		{"", "ASX \nCode", "Type", "Issuer", "Fund Name", "", "", "MER (% p.a)", "FUM ($m)#"},
		{"", "Equity - Australia"},
		{"", "A200", "ETF", "Betashares", "Betashares Australia 200", "", "", "0.04", "11082.44"},
		{"", "VAS", "ETF", "Vanguard", "Vanguard Australian Shares Index ETF", "", "", "0.07", "21000"},
	}
	lic := [][]string{
		{"ASX \nCode", "Type", "Fund Name", "", "", "MER (% p.a)", "Outperf Fee", "Mkt Cap ($m)#"},
		{"Equity - Australia"},
		{"AFI", "Shares", "Australian Foundation Investment Company", "", "", "0.14", "No", "8,174.83"},
	}
	funds, err := parseASXProducts(etp, lic, "u", "2026-09-30")
	if err != nil {
		t.Fatal(err)
	}
	if len(funds) != 3 {
		t.Fatalf("funds %+v", funds)
	}
	a200 := funds[0]
	if a200.Key != "asx:A200" || a200.InstitutionSlug != "betashares" || *a200.AUM != 11082.44e6 || a200.Category != "Equity - Australia / ETF" {
		t.Errorf("A200 %+v", a200)
	}
	if funds[2].Type != "lic" || funds[2].InstitutionSlug != "afic" || *funds[2].AUM != 8174.83e6 {
		t.Errorf("AFI %+v", funds[2])
	}
	for manager, want := range map[string]string{"Vanguard": "vanguard", "iShares": "blackrock", "StateStreet": "state-street",
		"DFA": "dimensional", "Hyperion / Pinnacle": "hyperion", "Global X": "global-x", "Macquarie": "macquarie",
		"Milford / EQT": "", "American Century / EQT": ""} {
		got := ""
		if inst := resolveIssuer(manager); inst != nil {
			got = inst.Slug
		}
		if got != want {
			t.Errorf("resolveIssuer(%q) = %q, want %q", manager, got, want)
		}
	}
	if got := monthEnd("sep", "2026"); got != "2026-09-30" {
		t.Errorf("monthEnd = %s", got)
	}
	if got := monthEnd("july", "2026"); got != "2026-07-31" {
		t.Errorf("monthEnd july = %s", got)
	}
}

func TestLatestLink(t *testing.T) {
	page := []byte(`<a href="/system/files/2026-01/Annual%20fund-level%20superannuation%20statistics%20back%20series%20June%202004%20to%20June%202025.xlsx">
		<a href="/system/files/2026-01/Annual%20fund-level%20superannuation%20statistics%20June%202025%20%281%29.xlsx">`)
	got, err := latestLink(page, "https://www.apra.gov.au", apraWorkbookRe)
	if err != nil || got != "https://www.apra.gov.au/system/files/2026-01/Annual%20fund-level%20superannuation%20statistics%20June%202025%20%281%29.xlsx" {
		t.Errorf("latestLink = %q, %v", got, err)
	}
}

// codesFor is a listed-company set of the given codes.
func codesFor(codes ...string) codeSet {
	out := codeSet{}
	for _, c := range codes {
		out[c] = company{Code: c, Name: c}
	}
	return out
}

// checkCounts holds the invariant every parser keeps: each data row is either
// a holding or a skipped row.
func checkCounts(t *testing.T, snap snapshot) {
	t.Helper()
	if len(snap.Holdings)+snap.Skipped != snap.RowsTotal {
		t.Errorf("%s: %d holdings and %d skipped, but %d rows", snap.FundCode, len(snap.Holdings), snap.Skipped, snap.RowsTotal)
	}
}

// workbookOf writes rows to a one-sheet workbook, for the layouts a test
// builds rather than reads from a real file.
func workbookOf(t *testing.T, rows [][]any) []byte {
	t.Helper()
	f := excelize.NewFile()
	for i, r := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+1)
		if err := f.SetSheetRow("Sheet1", cell, &r); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestParseISharesIHD(t *testing.T) {
	src := ishares("IHD", "iShares S&P/ASX Dividend Opportunities ETF", "251922")
	snap, err := parseISharesJSON(src, readFixture(t, "ishares_ihd.json"), codesFor("ANZ", "NAB"))
	if err != nil {
		t.Fatal(err)
	}
	// 54 rows: 50 ASX equities, cash, collateral, a futures line.
	if snap.RowsTotal != 54 || len(snap.Holdings) != 2 || snap.Skipped != 52 {
		t.Fatalf("rows %d holdings %d skipped %d", snap.RowsTotal, len(snap.Holdings), snap.Skipped)
	}
	checkCounts(t, snap)
	anz := holdingFor(t, snap, "ANZ")
	if !near(*anz.Units, 1063992) || !near(*anz.Value, 42921437.28) || !near(*anz.Weight, 10.66897) {
		t.Errorf("ANZ %v %v %v", *anz.Units, *anz.Value, *anz.Weight)
	}
	if snap.Identifiers["AU000000ANZ3"].Code != "ANZ" || snap.Identifiers["6065586"].Code != "ANZ" {
		t.Errorf("identifiers %+v", snap.Identifiers)
	}
	if got := parseISharesAsAt(readFixture(t, "ishares_ihd.csv")); got != "2026-11-03" {
		t.Errorf("as at %q", got)
	}
}

func TestISharesAsAtFailsClosed(t *testing.T) {
	ctx := context.Background()
	csvBody := []byte("\ufeffFund Holdings as of,\"03-Nov-2026\"\n \nTicker,Name\n")

	stated := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(csvBody) }))
	defer stated.Close()
	noDate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("\ufeffTicker,Name\nBHP,BHP GROUP LTD\n"))
	}))
	defer noDate.Close()
	html := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<!doctype html><html>just a moment</html>"))
	}))
	defer html.Close()

	for _, tc := range []struct {
		name, dateURL, wantAsAt string
		wantErr                 bool
	}{
		{"the CSV states its date", stated.URL, "2026-11-03", false},
		{"the CSV states no date", noDate.URL, "", true},
		{"the CSV is an anti-bot page", html.URL, "", true},
		{"the CSV cannot be fetched", "http://127.0.0.1:1/none.csv", "", true},
		{"no CSV variant", "", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			asAt, err := isharesAsAt(ctx, http.DefaultClient, etfSource{Code: "IOZ", DateURL: tc.dateURL})
			if (err != nil) != tc.wantErr || asAt != tc.wantAsAt {
				t.Errorf("isharesAsAt = %q, %v; want %q, error %v", asAt, err, tc.wantAsAt, tc.wantErr)
			}
		})
	}
}

func TestParseVanguardVAP(t *testing.T) {
	snap, err := parseVanguardJSON(vanguard("VAP", "VAP", "8206"), readFixture(t, "vanguard_vap.json"), codesFor("GMG", "SCG"))
	if err != nil {
		t.Fatal(err)
	}
	if snap.RowsTotal != 28 || len(snap.Holdings) != 2 || snap.Skipped != 26 || snap.AsAt != "2026-09-30" {
		t.Fatalf("as at %q rows %d holdings %d skipped %d", snap.AsAt, snap.RowsTotal, len(snap.Holdings), snap.Skipped)
	}
	checkCounts(t, snap)
	gmg := holdingFor(t, snap, "GMG")
	if !near(*gmg.Units, 70884842) || !near(*gmg.Value, 1926650006) || !near(*gmg.Weight, 37.14394) {
		t.Errorf("GMG %v %v %v", *gmg.Units, *gmg.Value, *gmg.Weight)
	}
}

func TestParseSPDRRealWorkbook(t *testing.T) {
	src := spdr("STW", "SPDR S&P/ASX 200 Fund")
	snap, err := parseSPDRXLSX(src, readFixture(t, "spdr_stw.xlsx"), codesFor("BHP", "CBA"))
	if err != nil {
		t.Fatal(err)
	}
	// 206 rows; the "Unassigned" line (AETDHN1) is not a listed code.
	if snap.AsAt != "2026-11-04" || snap.RowsTotal != 206 || len(snap.Holdings) != 2 || snap.Skipped != 204 {
		t.Fatalf("as at %q rows %d holdings %d skipped %d", snap.AsAt, snap.RowsTotal, len(snap.Holdings), snap.Skipped)
	}
	checkCounts(t, snap)
	bhp := holdingFor(t, snap, "BHP")
	if !near(*bhp.Units, 12313058) || !near(*bhp.Weight, 10.541706) || !near(*bhp.Value, 12313058*55.56) {
		t.Errorf("BHP %v %v %v", *bhp.Units, *bhp.Value, *bhp.Weight)
	}
}

func TestParseSPDRNonAUDValueWithheld(t *testing.T) {
	rows := [][]any{
		{"Fund Name:", "Test"},
		{"Holdings:", "As of 16-Oct-2026"},
		{},
		{"ISIN", "SEDOL", "Ticker", "Name", "Local Currency", "Number of Shares", "Weight (%)", "Trade Country Name", "Local Price"},
		{"AU000000BHP4", "6144690", "BHP-AU", "Bhp Group Ltd", "USD", "100", "1.5", "Australia", "60"},
	}
	snap, err := parseSPDRXLSX(spdr("STW", "STW"), workbookOf(t, rows), testCodes)
	if err != nil {
		t.Fatal(err)
	}
	bhp := holdingFor(t, snap, "BHP")
	if bhp.Value != nil || *bhp.Units != 100 {
		t.Errorf("a non-AUD line has value %v, units %v; want no value", bhp.Value, *bhp.Units)
	}
}

func TestParseBetasharesYMAX(t *testing.T) {
	snap, err := parseBetashares(betashares("YMAX", "YMAX"), readFixture(t, "betashares_ymax.csv"), codesFor("BHP", "CBA"))
	if err != nil {
		t.Fatal(err)
	}
	// 42 rows: 21 index options, 20 equities (18 not on the test list), cash.
	if snap.AsAt != "2026-11-04" || snap.RowsTotal != 42 || len(snap.Holdings) != 2 || snap.Skipped != 40 {
		t.Fatalf("as at %q rows %d holdings %d skipped %d", snap.AsAt, snap.RowsTotal, len(snap.Holdings), snap.Skipped)
	}
	checkCounts(t, snap)
	bhp := holdingFor(t, snap, "BHP")
	if !near(*bhp.Units, 2124440) || !near(*bhp.Value, 118033886.4) || !near(*bhp.Weight, 16.59964695) {
		t.Errorf("BHP %v %v %v", *bhp.Units, *bhp.Value, *bhp.Weight)
	}
}

func TestParseGlobalXZYAU(t *testing.T) {
	src := globalx("ZYAU", "Global X S&P/ASX 200 High Dividend ETF")
	snap, err := parseGlobalXXLSX(src, readFixture(t, "globalx_zyau.xlsx"), codesFor("ANZ", "NAB", "WBC"))
	if err != nil {
		t.Fatal(err)
	}
	if snap.AsAt != "2026-11-05" || snap.RowsTotal != 50 || len(snap.Holdings) != 3 || snap.Skipped != 47 {
		t.Fatalf("as at %q rows %d holdings %d skipped %d", snap.AsAt, snap.RowsTotal, len(snap.Holdings), snap.Skipped)
	}
	checkCounts(t, snap)
	// The workbook's weight cells are decimals (0.1112513943268067); they come
	// out as percent. The Sector column is not read.
	anz := holdingFor(t, snap, "ANZ")
	if anz.Name != "ANZ GROUP HOLDIN" || !near(*anz.Units, 274872) || !near(*anz.Value, 11093833.92) || !near(*anz.Weight, 11.12513943268067) {
		t.Errorf("ANZ %q %v %v %v", anz.Name, *anz.Units, *anz.Value, *anz.Weight)
	}
	if nab := holdingFor(t, snap, "NAB"); !near(*nab.Weight, 10.325425141930328) {
		t.Errorf("NAB weight %v", *nab.Weight)
	}
	if snap.Identifiers["AU000000ANZ3"].Code != "ANZ" || snap.Identifiers["6065586"].Code != "ANZ" {
		t.Errorf("identifiers %+v", snap.Identifiers)
	}
}

func TestParseGlobalXTrimmedAYLD(t *testing.T) {
	src := globalx("AYLD", "Global X S&P/ASX 200 Covered Call Complex ETF")
	snap, err := parseGlobalXXLSX(src, readFixture(t, "globalx_ayld_trimmed.xlsx"), codesFor("BHP", "CBA"))
	if err != nil {
		t.Fatal(err)
	}
	// 73 rows: 72 "Equity" lines and one index option ("AS51 12 C8700 Index"),
	// which is not an equity and is skipped like every other row.
	if snap.AsAt != "2026-11-05" || snap.RowsTotal != 73 || len(snap.Holdings) != 2 || snap.Skipped != 71 {
		t.Fatalf("rows %d holdings %d skipped %d", snap.RowsTotal, len(snap.Holdings), snap.Skipped)
	}
	checkCounts(t, snap)
	bhp := holdingFor(t, snap, "BHP")
	if !near(*bhp.Units, 256597) || !near(*bhp.Value, 14256529.32) || !near(*bhp.Weight, 10.852969176025054) {
		t.Errorf("BHP %v %v %v", *bhp.Units, *bhp.Value, *bhp.Weight)
	}
}

func TestParseGlobalXRejectsNonAUDBase(t *testing.T) {
	rows := [][]any{
		{"Fund Name", "Test Fund"},
		{"Base CCY", "USD"},
		{"Trade Date", "20261105"},
		{"#", "Component Name", "ISIN", "SEDOL", "Bloomberg Ticker", "Number of Shares", "Local CCY", "Local CCY Price", "Market Value (Base CCY)", "Weight", "Sector", "Country"},
		{1, "BHP GROUP LTD", "AU000000BHP4", "6144690", "BHP AT Equity", 100, "AUD", 55.56, 5556, 0.1, "Materials", "Australia"},
	}
	if _, err := parseGlobalXXLSX(globalx("TST", "Test"), workbookOf(t, rows), testCodes); err == nil {
		t.Error("a workbook in USD was accepted; its values would not be AUD")
	}
}

func TestGlobalXEquityCode(t *testing.T) {
	codes := codesFor("BHP", "CBA")
	for in, want := range map[string]string{
		"BHP AT Equity":        "BHP",
		"BHP AU Equity":        "BHP",
		"bhp at equity":        "BHP",
		"CBA AT Equity":        "CBA",
		"XPZ6 Index":           "",
		"CBA AU 11 C100 Index": "",
		"BHP AT":               "",
		"AAPL US Equity":       "",
		"AS51 12 C8700 Index":  "",
		"AMC AT Equity":        "",
	} {
		got, _ := globalXEquityCode(in, codes)
		if got != want {
			t.Errorf("globalXEquityCode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGlobalXWorkbookURL(t *testing.T) {
	page := readFixture(t, "globalx_a300_page_excerpt.html")
	got, err := globalXWorkbookURL(page, "A300")
	if err != nil || got != "https://files.globalxetfs.com.au/GXAU_A300_FULL_PCF_20261105.xlsx" {
		t.Errorf("A300 link = %q, %v", got, err)
	}
	if got, err := globalXWorkbookURL(page, "a300"); err != nil || got == "" {
		t.Errorf("lower-case code: %q, %v", got, err)
	}
	// The page names A300's workbook; ZYAU's page would name its own.
	if got, err := globalXWorkbookURL(page, "ZYAU"); err == nil {
		t.Errorf("ZYAU matched A300's page: %q", got)
	}
	// A page that links two funds' workbooks: each code takes its own link.
	two := []byte(`<a href="https://files.globalxetfs.com.au/GXAU_ZYAU_FULL_PCF_20261104.xlsx">pcf</a>` +
		`<a href="https://files.globalxetfs.com.au/GXAU_A300_FULL_PCF_20261105.xlsx">pcf</a>`)
	if got, err := globalXWorkbookURL(two, "A300"); err != nil || got != "https://files.globalxetfs.com.au/GXAU_A300_FULL_PCF_20261105.xlsx" {
		t.Errorf("A300 on a two-fund page = %q, %v", got, err)
	}
	if got, err := globalXWorkbookURL(two, "ZYAU"); err != nil || got != "https://files.globalxetfs.com.au/GXAU_ZYAU_FULL_PCF_20261104.xlsx" {
		t.Errorf("ZYAU on a two-fund page = %q, %v", got, err)
	}
}

func TestETFSourcesWellFormed(t *testing.T) {
	institutions := map[string]bool{"blackrock": true, "vanguard": true, "state-street": true, "betashares": true, "global-x": true}
	formats := map[string]bool{"ishares": true, "vanguard": true, "spdr": true, "betashares": true, "globalx": true}
	seen := map[string]bool{}
	for _, src := range etfSources {
		if seen[src.Code] {
			t.Errorf("%s listed twice", src.Code)
		}
		seen[src.Code] = true
		if src.Name == "" || !institutions[src.Institution] || !formats[src.Format] || src.URL == "" {
			t.Errorf("%s is not well formed: %+v", src.Code, src)
		}
	}
	if len(etfSources) != 35 {
		t.Errorf("%d ETF sources, want 35", len(etfSources))
	}
	if got := spdr("STW", "").URL; !strings.HasPrefix(got, "https://www.ssga.com/library-content/") {
		t.Errorf("SPDR URL %s", got)
	}
	if got := globalx("A300", "").URL; got != "https://www.globalxetfs.com.au/funds/a300/" {
		t.Errorf("Global X page %s", got)
	}
}

// noPace drops the pause between issuer requests for one test.
func noPace(t *testing.T) {
	t.Helper()
	old := etfPace
	etfPace = 0
	t.Cleanup(func() { etfPace = old })
}

// TestFetchETFISharesWithoutDateFailsClosed reads a whole iShares fund through
// fetchETF from a local server: the CSV variant refuses, so the fund is an
// error and nothing is stored under a fetch day.
func TestFetchETFISharesWithoutDateFailsClosed(t *testing.T) {
	noPace(t)
	jsonBody := readFixture(t, "ishares_ihd.json")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("fileType") == "csv" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(jsonBody)
	}))
	defer srv.Close()
	src := etfSource{Code: "IHD", Name: "IHD", Institution: "blackrock", Format: "ishares",
		URL: srv.URL + "/ajax?tab=all&fileType=json", DateURL: srv.URL + "/ajax?fileType=csv"}
	if snap, err := fetchETF(context.Background(), srv.Client(), src, codesFor("ANZ", "NAB")); err == nil {
		t.Errorf("an undated iShares fund was read: as at %q", snap.AsAt)
	}
}

// TestFetchETFISharesStatedDate reads the same fund when the CSV states its date.
func TestFetchETFISharesStatedDate(t *testing.T) {
	noPace(t)
	jsonBody := readFixture(t, "ishares_ihd.json")
	csvBody := readFixture(t, "ishares_ihd.csv")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("fileType") == "csv" {
			_, _ = w.Write(csvBody)
			return
		}
		_, _ = w.Write(jsonBody)
	}))
	defer srv.Close()
	src := etfSource{Code: "IHD", Name: "IHD", Institution: "blackrock", Format: "ishares",
		URL: srv.URL + "/ajax?tab=all&fileType=json", DateURL: srv.URL + "/ajax?fileType=csv"}
	snap, err := fetchETF(context.Background(), srv.Client(), src, codesFor("ANZ", "NAB"))
	if err != nil {
		t.Fatal(err)
	}
	if snap.AsAt != "2026-11-03" {
		t.Errorf("as at %q", snap.AsAt)
	}
	if len(snap.Holdings) != 2 || snap.Skipped != 52 {
		t.Errorf("holdings %d skipped %d", len(snap.Holdings), snap.Skipped)
	}
}

// TestParseGlobalXRejectsPercentWeights refuses a workbook whose weights are
// percent, not decimals: 11.1 would be stored as 1110%.
func TestParseGlobalXRejectsPercentWeights(t *testing.T) {
	rows := [][]any{
		{"Fund Name", "Test Fund"},
		{"Base CCY", "AUD"},
		{"Trade Date", "20261105"},
		{"#", "Component Name", "ISIN", "SEDOL", "Bloomberg Ticker", "Number of Shares", "Local CCY", "Local CCY Price", "Market Value (Base CCY)", "Weight", "Sector", "Country"},
		{1, "BHP GROUP LTD", "AU000000BHP4", "6144690", "BHP AT Equity", 100, "AUD", 55.56, 5556, 11.1, "Materials", "Australia"},
	}
	if _, err := parseGlobalXXLSX(globalx("TST", "Test"), workbookOf(t, rows), testCodes); err == nil {
		t.Error("a percent-scale workbook was accepted")
	}
}
