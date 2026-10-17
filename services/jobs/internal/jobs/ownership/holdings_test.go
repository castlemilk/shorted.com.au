package ownership

import (
	"bytes"
	"os"
	"path/filepath"
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
		"DFA": "dimensional", "Hyperion / Pinnacle": "hyperion", "Global X": "", "Macquarie": "macquarie",
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
