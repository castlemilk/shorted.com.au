package ownership

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

// Holdings files: what an ETF or a super fund option holds, in full. Each
// file becomes one snapshot of ASX stocks; a row that is not an ASX stock
// (cash, a futures or option contract, a listing on another market, a code
// that is not a listed company) is counted in Skipped, never stored.

// holding is one ASX stock in one snapshot. Every figure is the file's own;
// nil when the file does not give it.
type holding struct {
	Code   string
	Name   string
	Units  *float64
	Value  *float64
	Weight *float64
	Match  string // ticker, isin, sedol
}

// snapshot is one holdings file read.
type snapshot struct {
	InstitutionSlug string
	FundName        string
	FundCode        string
	SourceKind      string // etf, super_phd
	SourceURL       string
	AsAt            string // YYYY-MM-DD, the date the file states
	// RowsTotal is the data rows the file gives.
	RowsTotal int
	// Skipped is the rows of RowsTotal that are not ASX equities. Never stored.
	Skipped  int
	Holdings []holding
	// Identifiers is ISIN/SEDOL to code, from a file that states both.
	Identifiers map[string]identifier
}

type identifier struct {
	Kind string // isin, sedol
	Code string
}

const userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

// maxHoldingsBytes bounds one holdings file. The largest super fund option
// file is a few MB.
const maxHoldingsBytes = 32 << 20

// fetchFile downloads a holdings file with a browser user agent (issuer sites
// refuse a bare client).
func fetchFile(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "*/*")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxHoldingsBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxHoldingsBytes {
		return nil, fmt.Errorf("file over %d bytes", maxHoldingsBytes)
	}
	// An anti-bot page answers 200 with HTML.
	if trimmed := bytes.TrimSpace(bytes.TrimPrefix(body, []byte("\ufeff"))); bytes.HasPrefix(bytes.ToLower(trimmed), []byte("<!doctype html")) || bytes.HasPrefix(bytes.ToLower(trimmed), []byte("<html")) {
		return nil, errors.New("got an HTML page, not a holdings file")
	}
	return body, nil
}

// parseNumber reads "1,060,879,624.00", "$860,645,623", "(498,470.97)",
// " 33085890.37", "2.66%". ok=false for an empty or dash cell.
func parseNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	neg := false
	if strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		neg, s = true, s[1:len(s)-1]
	}
	s = strings.NewReplacer(",", "", "$", "", "%", "", " ", "", "AUD", "").Replace(s)
	if s == "" || s == "-" || strings.EqualFold(s, "n/a") {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	if neg {
		v = -v
	}
	return v, true
}

func numPtr(s string) *float64 {
	if v, ok := parseNumber(s); ok {
		return &v
	}
	return nil
}

// parseAsAt reads the dates holdings files print: "15-Oct-2026",
// "As of 16-Oct-2026", "2026-10-15", "30/06/2026", "30 June 2026", "30-06-2026".
func parseAsAt(s string) string {
	s = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(s), "As of"))
	for _, layout := range []string{"2006-01-02", "02-Jan-2006", "2-Jan-2006", "02/01/2006", "2/01/2006", "2 January 2006", "02 January 2006", "02-01-2006"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Format("2006-01-02")
		}
	}
	return parseNoticeDate(s)
}

// parseYYYYMMDD reads the compact date Global X's workbook prints: "20261105".
func parseYYYYMMDD(s string) string {
	t, err := time.Parse("20060102", strings.TrimSpace(s))
	if err != nil {
		return ""
	}
	return t.Format("2006-01-02")
}

// codeSet is the listed ASX codes, so a ticker that is not one is dropped.
type codeSet map[string]company

var tickerSuffixRe = regexp.MustCompile(`^([A-Z0-9]{3,6})(?:[ -](?:AU|AT|ASX))?$`)

// asxTicker turns "BHP", "BHP AU", "BHP AT", "BHP-AU", "ASX:BHP" into BHP when
// it is a listed code.
func (c codeSet) asxTicker(raw string) (string, bool) {
	s := strings.ToUpper(strings.TrimSpace(raw))
	s = strings.TrimPrefix(s, "ASX:")
	m := tickerSuffixRe.FindStringSubmatch(s)
	if m == nil {
		return "", false
	}
	if _, ok := c[m[1]]; !ok {
		return "", false
	}
	return m[1], true
}

// --- ETF issuers -----------------------------------------------------------

type etfSource struct {
	Code        string
	Name        string
	Institution string
	Format      string // ishares, vanguard, spdr, betashares, globalx
	// URL is the file. For globalx it is the fund's page, which links the
	// dated workbook; the link is discovered on each run.
	URL string
	// DateURL is a second file that carries the as-at date when URL does not.
	DateURL string
}

// etfSources are the Australian-equity index ETFs of the issuers that publish
// machine-readable daily holdings: BlackRock, Vanguard, State Street,
// Betashares and Global X. Vanguard's files are its pooled wholesale funds, so
// their units are the whole index fund's, not only the ETF's.
var etfSources = []etfSource{
	ishares("IOZ", "iShares Core S&P/ASX 200 ETF", "251852"),
	ishares("ILC", "iShares S&P/ASX 20 ETF", "251921"),
	ishares("ISO", "iShares S&P/ASX Small Ordinaries ETF", "251923"),
	ishares("IHD", "iShares S&P/ASX Dividend Opportunities ETF", "251922"),
	ishares("IESG", "iShares ESG Aware MSCI Australian Equity ETF", "318831"),
	vanguard("VAS", "Vanguard Australian Shares Index Fund (VAS)", "8205"),
	vanguard("VHY", "Vanguard Australian Shares High Yield Fund (VHY)", "8210"),
	vanguard("VSO", "Vanguard MSCI Australian Small Companies Index Fund (VSO)", "8211"),
	vanguard("VLC", "Vanguard MSCI Australian Large Companies Index Fund (VLC)", "8209"),
	vanguard("VAP", "Vanguard Australian Property Securities Index Fund (VAP)", "8206"),
	spdr("STW", "SPDR S&P/ASX 200 Fund"),
	spdr("SFY", "SPDR S&P/ASX 50 Fund"),
	spdr("SSO", "SPDR S&P/ASX Small Ordinaries Fund"),
	spdr("SYI", "SPDR MSCI Australia Select High Dividend Yield Fund"),
	spdr("SLF", "SPDR S&P/ASX 200 Listed Property Fund"),
	betashares("A200", "Betashares Australia 200 ETF"),
	betashares("QOZ", "Betashares Australia 200 Fundamental Value ETF"),
	betashares("EX20", "Betashares Australian Ex-20 Portfolio Diversifier ETF"),
	betashares("QFN", "Betashares Australian Financials Sector ETF"),
	betashares("QRE", "Betashares Australian Resources Sector ETF"),
	betashares("AQLT", "Betashares Australian Quality ETF"),
	betashares("MTUM", "Betashares Australian Momentum ETF"),
	betashares("SMLL", "Betashares Australian Small Companies Select ETF"),
	betashares("FAIR", "Betashares Australian Sustainability Leaders ETF"),
	betashares("AECV", "Betashares Australian Shares Catholic Values ETF"),
	betashares("AUST", "Betashares Managed Risk Australian Shares Complex ETF"),
	betashares("HYLD", "Betashares S&P Australian Shares High Yield ETF"),
	betashares("ATEC", "Betashares S&P/ASX Australian Technology ETF"),
	betashares("HVST", "Betashares Australian Dividend Harvester Active ETF"),
	betashares("YMAX", "Betashares Australian Top 20 Equities Yield Maximiser Complex ETF"),
	globalx("A300", "Global X Australia 300 ETF"),
	globalx("ZYAU", "Global X S&P/ASX 200 High Dividend ETF"),
	globalx("OZXX", "Global X Australia ex Financials & Resources ETF"),
	globalx("GRPA", "Global X S&P Australia GARP ETF"),
	globalx("AYLD", "Global X S&P/ASX 200 Covered Call Complex ETF"),
}

func ishares(code, name, id string) etfSource {
	base := "https://www.blackrock.com/au/products/" + id + "/x/1478358644060.ajax"
	return etfSource{Code: code, Name: name, Institution: "blackrock", Format: "ishares",
		URL:     base + "?tab=all&fileType=json",
		DateURL: base + "?fileType=csv&fileName=" + code + "_holdings&dataType=fund"}
}

func vanguard(code, name, portID string) etfSource {
	return etfSource{Code: code, Name: name, Institution: "vanguard", Format: "vanguard",
		URL: "https://www.vanguard.com.au/personal/api/data/products/holdings-download/" + portID}
}

// spdr's path moved in 2026: the intermediary path answers 301 to this one.
func spdr(code, name string) etfSource {
	return etfSource{Code: code, Name: name, Institution: "state-street", Format: "spdr",
		URL: "https://www.ssga.com/library-content/products/fund-data/etfs/apac/holdings-daily-au-en-" + strings.ToLower(code) + ".xlsx"}
}

func betashares(code, name string) etfSource {
	return etfSource{Code: code, Name: name, Institution: "betashares", Format: "betashares",
		URL: "https://www.betashares.com.au/files/csv/" + code + "_Portfolio_Holdings.csv"}
}

// globalx is a Global X fund. Its workbook is named for the day it was cut
// (GXAU_<CODE>_FULL_PCF_<YYYYMMDD>.xlsx), so the fund page is read for the link.
// The institution is the registry's "global-x".
func globalx(code, name string) etfSource {
	return etfSource{Code: code, Name: name, Institution: "global-x", Format: "globalx",
		URL: "https://www.globalxetfs.com.au/funds/" + strings.ToLower(code) + "/"}
}

func newETFSnapshot(src etfSource) snapshot {
	return snapshot{InstitutionSlug: src.Institution, FundName: src.Name, FundCode: src.Code, SourceKind: "etf",
		SourceURL: src.URL, Identifiers: map[string]identifier{}}
}

// isEquityClass reads an asset class column: "Equity" or "Equities" (Betashares).
// Options, futures, cash and "Other" are not equities.
func isEquityClass(s string) bool {
	s = strings.TrimSpace(s)
	return strings.EqualFold(s, "Equity") || strings.EqualFold(s, "Equities")
}

// parseISharesJSON reads the iShares "all holdings" JSON: positional rows
// [ticker, name, sector, asset class, market value, weight, notional, shares,
// cusip, ISIN, SEDOL, price, location, exchange, currency, ...].
func parseISharesJSON(src etfSource, body []byte, codes codeSet) (snapshot, error) {
	var doc struct {
		AAData [][]json.RawMessage `json:"aaData"`
	}
	if err := json.Unmarshal(bytes.TrimPrefix(body, []byte("\ufeff")), &doc); err != nil {
		return snapshot{}, fmt.Errorf("decode iShares JSON: %w", err)
	}
	snap := newETFSnapshot(src)
	str := func(m json.RawMessage) string {
		var s string
		if json.Unmarshal(m, &s) == nil {
			return s
		}
		var obj struct {
			Raw json.RawMessage `json:"raw"`
		}
		if json.Unmarshal(m, &obj) == nil && obj.Raw != nil {
			return strings.Trim(string(obj.Raw), `"`)
		}
		return ""
	}
	for _, row := range doc.AAData {
		if len(row) < 15 {
			continue
		}
		snap.RowsTotal++
		code, ok := codes.asxTicker(str(row[0]))
		if !ok || !isEquityClass(str(row[3])) || !strings.Contains(strings.ToUpper(str(row[13])), "ASX") {
			snap.Skipped++
			continue
		}
		snap.Holdings = append(snap.Holdings, holding{Code: code, Name: str(row[1]), Units: numPtr(str(row[7])),
			Value: numPtr(str(row[4])), Weight: numPtr(str(row[5])), Match: "ticker"})
		if isin := strings.ToUpper(strings.TrimSpace(str(row[9]))); isinRe.MatchString(isin) {
			snap.Identifiers[isin] = identifier{Kind: "isin", Code: code}
		}
		if sedol := strings.ToUpper(strings.TrimSpace(str(row[10]))); sedolRe.MatchString(sedol) {
			snap.Identifiers[sedol] = identifier{Kind: "sedol", Code: code}
		}
	}
	return snap, nil
}

// parseISharesAsAt reads the CSV's first line: Fund Holdings as of,"15-Oct-2026".
func parseISharesAsAt(body []byte) string {
	line, _, _ := bytes.Cut(bytes.TrimPrefix(body, []byte("\ufeff")), []byte("\n"))
	_, date, ok := strings.Cut(string(line), ",")
	if !ok {
		return ""
	}
	return parseAsAt(strings.Trim(strings.TrimSpace(date), `"`))
}

// isharesAsAt reads the as-at date from the CSV variant, whose first line
// states it. The JSON carries none. When the CSV cannot be fetched or states
// no date, the fund fails closed: the fetch day would be stored as the
// holdings' date (a weekend run would hold Friday's figures under Saturday's
// date, and the store has no column to say the date was not the file's own).
func isharesAsAt(ctx context.Context, client *http.Client, src etfSource) (string, error) {
	if src.DateURL == "" {
		return "", errors.New("iShares: no CSV variant to read the as-at date from")
	}
	body, err := fetchFile(ctx, client, src.DateURL)
	if err != nil {
		return "", fmt.Errorf("iShares as-at date: %w", err)
	}
	d := parseISharesAsAt(body)
	if d == "" {
		return "", errors.New("iShares: the CSV states no as-at date")
	}
	return d, nil
}

// etfPace is the pause before each request to an issuer, so the 35 funds
// (15 of them on one host) are read politely. Tests set it to zero.
var etfPace = 1500 * time.Millisecond

func pauseETF(ctx context.Context) error {
	t := time.NewTimer(etfPace)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// parseVanguardJSON reads Vanguard's holdings download.
func parseVanguardJSON(src etfSource, body []byte, codes codeSet) (snapshot, error) {
	var doc struct {
		Data []struct {
			Ticker           string   `json:"ticker"`
			Name             string   `json:"name"`
			MarketValPercent *float64 `json:"marketValPercent"`
			MarketValue      *float64 `json:"marketValue"`
			Units            *float64 `json:"units"`
			CountryCode      string   `json:"countryCode"`
			EffectiveDate    string   `json:"effectiveDate"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return snapshot{}, fmt.Errorf("decode Vanguard JSON: %w", err)
	}
	snap := newETFSnapshot(src)
	for _, r := range doc.Data {
		snap.RowsTotal++
		if snap.AsAt == "" {
			snap.AsAt = parseAsAt(r.EffectiveDate)
		}
		code, ok := codes.asxTicker(r.Ticker)
		if !ok || (r.CountryCode != "" && r.CountryCode != "AU") {
			snap.Skipped++
			continue
		}
		snap.Holdings = append(snap.Holdings, holding{Code: code, Name: r.Name, Units: r.Units, Value: r.MarketValue,
			Weight: r.MarketValPercent, Match: "ticker"})
	}
	return snap, nil
}

// parseSPDRXLSX reads State Street's daily holdings workbook: a "Holdings:"
// row with the date, then ISIN, SEDOL, Ticker (BHP-AU), Name, Currency,
// Number of Shares, Weight (%), Country, Local Price. No market value: it is
// shares times price, which is AUD only for an AUD line.
func parseSPDRXLSX(src etfSource, body []byte, codes codeSet) (snapshot, error) {
	rows, err := xlsxRows(body)
	if err != nil {
		return snapshot{}, err
	}
	snap := newETFSnapshot(src)
	col := map[string]int{}
	for _, row := range rows {
		if len(row) >= 2 && strings.HasPrefix(strings.TrimSpace(row[0]), "Holdings") {
			snap.AsAt = parseAsAt(row[1])
			continue
		}
		if len(col) == 0 {
			for i, c := range row {
				col[strings.ToLower(strings.TrimSpace(c))] = i
			}
			if _, ok := col["ticker"]; !ok {
				col = map[string]int{}
			}
			continue
		}
		cell := func(name string) string {
			if i, ok := col[name]; ok && i < len(row) {
				return row[i]
			}
			return ""
		}
		if strings.TrimSpace(cell("ticker")) == "" {
			continue
		}
		snap.RowsTotal++
		code, ok := codes.asxTicker(cell("ticker"))
		if !ok {
			snap.Skipped++
			continue
		}
		units, price := numPtr(cell("number of shares")), numPtr(cell("local price"))
		var value *float64
		if units != nil && price != nil && strings.EqualFold(strings.TrimSpace(cell("local currency")), "AUD") {
			v := *units * *price
			value = &v
		}
		snap.Holdings = append(snap.Holdings, holding{Code: code, Name: cell("name"), Units: units, Value: value,
			Weight: numPtr(cell("weight (%)")), Match: "ticker"})
		if isin := strings.ToUpper(strings.TrimSpace(cell("isin"))); isinRe.MatchString(isin) {
			snap.Identifiers[isin] = identifier{Kind: "isin", Code: code}
		}
		if sedol := strings.ToUpper(strings.TrimSpace(cell("sedol"))); sedolRe.MatchString(sedol) {
			snap.Identifiers[sedol] = identifier{Kind: "sedol", Code: code}
		}
	}
	return snap, nil
}

// parseBetashares reads a Betashares portfolio holdings CSV: a few
// "key,value" lines (Date,2026-10-15), then the table. Its tickers carry the
// market suffix ("BHP AT"); its derivative rows (index futures, options) carry
// another asset class and are skipped.
func parseBetashares(src etfSource, body []byte, codes codeSet) (snapshot, error) {
	records, err := readCSV(body)
	if err != nil {
		return snapshot{}, err
	}
	snap := newETFSnapshot(src)
	col := map[string]int{}
	for _, row := range records {
		if len(col) == 0 {
			if len(row) >= 2 && strings.EqualFold(strings.TrimSpace(row[0]), "Date") {
				snap.AsAt = parseAsAt(row[1])
			}
			if len(row) > 0 && strings.EqualFold(strings.TrimSpace(row[0]), "Ticker") {
				for i, c := range row {
					col[strings.ToLower(strings.TrimSpace(c))] = i
				}
			}
			continue
		}
		cell := func(prefix string) string {
			for name, i := range col {
				if strings.HasPrefix(name, prefix) && i < len(row) {
					return row[i]
				}
			}
			return ""
		}
		// The disclaimer under the table is one cell; it is not a row.
		if strings.TrimSpace(cell("ticker")) == "" || nonEmptyCells(row) < 2 {
			continue
		}
		snap.RowsTotal++
		code, ok := codes.asxTicker(cell("ticker"))
		if !ok || !isEquityClass(cell("asset class")) {
			snap.Skipped++
			continue
		}
		snap.Holdings = append(snap.Holdings, holding{Code: code, Name: cell("name"), Units: numPtr(cell("shares")),
			Value: numPtr(cell("market value")), Weight: numPtr(cell("weight")), Match: "ticker"})
	}
	return snap, nil
}

func nonEmptyCells(row []string) int {
	n := 0
	for _, c := range row {
		if strings.TrimSpace(c) != "" {
			n++
		}
	}
	return n
}

// parseGlobalXXLSX reads a Global X full holdings (PCF) workbook: a header
// block (Fund Name, Trade Date as YYYYMMDD, Base CCY), then one table with a
// Bloomberg Ticker ("BHP AT Equity"), Number of Shares, Market Value (Base CCY)
// and Weight. The weight is a decimal fraction (0.1112 is 11.12%), so it is
// multiplied by 100 here. The Sector column is not read: the issuer's own
// tagging is unreliable (NAB is tagged Energy in one fund).
func parseGlobalXXLSX(src etfSource, body []byte, codes codeSet) (snapshot, error) {
	rows, err := xlsxRows(body, excelize.Options{RawCellValue: true})
	if err != nil {
		return snapshot{}, err
	}
	snap := newETFSnapshot(src)
	var col map[string]int
	baseCCY := ""
	for _, row := range rows {
		if col == nil {
			if len(row) >= 2 {
				switch strings.ToLower(strings.TrimSpace(row[0])) {
				case "trade date":
					snap.AsAt = parseYYYYMMDD(row[1])
				case "base ccy":
					baseCCY = strings.TrimSpace(row[1])
				}
			}
			if h := headerColumns(row); hasColumn(h, "bloomberg ticker") {
				col = h
			}
			continue
		}
		cell := func(name string) string {
			if i, ok := col[name]; ok && i < len(row) {
				return strings.TrimSpace(row[i])
			}
			return ""
		}
		bbg := cell("bloomberg ticker")
		if bbg == "" {
			continue
		}
		snap.RowsTotal++
		raw := numPtr(cell("weight"))
		if raw != nil && math.Abs(*raw) > 1 {
			// A decimal weight cannot pass 100%. A workbook in percent would be
			// stored 100 times too large, so the whole file is refused.
			return snapshot{}, fmt.Errorf("weight %v on %s is over 1: the workbook's weights are not decimals", *raw, bbg)
		}
		code, ok := globalXEquityCode(bbg, codes)
		if !ok {
			snap.Skipped++
			continue
		}
		var weight *float64
		if raw != nil {
			pct := *raw * 100
			weight = &pct
		}
		snap.Holdings = append(snap.Holdings, holding{Code: code, Name: cell("component name"),
			Units: numPtr(cell("number of shares")), Value: numPtr(cell("market value (base ccy)")),
			Weight: weight, Match: "ticker"})
		if isin := strings.ToUpper(cell("isin")); isinRe.MatchString(isin) {
			snap.Identifiers[isin] = identifier{Kind: "isin", Code: code}
		}
		if sedol := strings.ToUpper(cell("sedol")); sedolRe.MatchString(sedol) {
			snap.Identifiers[sedol] = identifier{Kind: "sedol", Code: code}
		}
	}
	if baseCCY != "" && !strings.EqualFold(baseCCY, "AUD") {
		return snapshot{}, fmt.Errorf("base currency %s, not AUD: the values would not be AUD", baseCCY)
	}
	if col == nil {
		return snapshot{}, errors.New("no Bloomberg Ticker column in the workbook")
	}
	return snap, nil
}

// headerColumns maps a row's cells, lower-cased and trimmed, to their index.
func headerColumns(row []string) map[string]int {
	out := map[string]int{}
	for i, c := range row {
		if name := strings.ToLower(strings.TrimSpace(c)); name != "" {
			out[name] = i
		}
	}
	return out
}

func hasColumn(cols map[string]int, name string) bool {
	_, ok := cols[name]
	return ok
}

// globalXEquityCode reads a Bloomberg ticker. Only "<code> AT Equity" (or
// "AU Equity") is an equity; an index future ("XPZ6 Index") or an option
// ("CBA AU 11 C100 Index") is not, and neither is a code the ASX does not list.
func globalXEquityCode(bbg string, codes codeSet) (string, bool) {
	b := strings.TrimSpace(bbg)
	if len(b) < len(" Equity")+1 || !strings.EqualFold(b[len(b)-len(" Equity"):], " Equity") {
		return "", false
	}
	return codes.asxTicker(b[:len(b)-len(" Equity")])
}

// globalXWorkbookURL finds the fund's dated holdings workbook on its page. The
// page carries it as "pcf"; the match is on this fund's code, so another
// fund's link on the page is never taken.
func globalXWorkbookURL(page []byte, code string) (string, error) {
	re := regexp.MustCompile(`https://files\.globalxetfs\.com\.au/GXAU_` + regexp.QuoteMeta(strings.ToUpper(code)) + `_FULL_PCF_\d{8}\.xlsx`)
	m := re.Find(page)
	if m == nil {
		return "", fmt.Errorf("no %s holdings workbook link on the fund page", code)
	}
	return string(m), nil
}

func readCSV(body []byte) ([][]string, error) {
	r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(body, []byte("\ufeff"))))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	return r.ReadAll()
}

// xlsxSheet is one named sheet's rows as strings.
func xlsxSheet(body []byte, sheet string) ([][]string, error) {
	f, err := excelize.OpenReader(bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("open workbook: %w", err)
	}
	defer func() { _ = f.Close() }()
	rows, err := f.GetRows(sheet)
	if err != nil {
		return nil, fmt.Errorf("sheet %q: %w", sheet, err)
	}
	return rows, nil
}

func readAllLimited(resp *http.Response, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("response over %d bytes", limit)
	}
	return body, nil
}

// xlsxRows is the first sheet's rows as strings. Options pass through to
// excelize: RawCellValue returns the stored number, not the text Excel shows.
func xlsxRows(body []byte, opts ...excelize.Options) ([][]string, error) {
	f, err := excelize.OpenReader(bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("open workbook: %w", err)
	}
	defer func() { _ = f.Close() }()
	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, errors.New("workbook has no sheets")
	}
	return f.GetRows(sheets[0], opts...)
}

var (
	isinRe  = regexp.MustCompile(`^[A-Z]{2}[A-Z0-9]{9}[0-9]$`)
	sedolRe = regexp.MustCompile(`^[0-9BCDFGHJKLMNPQRSTVWXYZ]{6}[0-9]$`)
)

// fetchETF downloads and parses one ETF's holdings, and logs what it read:
// the as-at date, the rows, the ASX holdings and the rows skipped. A fund
// whose file states no as-at date is an error, never stored undated.
func fetchETF(ctx context.Context, client *http.Client, src etfSource, codes codeSet) (snapshot, error) {
	if err := pauseETF(ctx); err != nil {
		return snapshot{}, err
	}
	if src.Format == "globalx" {
		page, err := fetchPage(ctx, client, src.URL)
		if err != nil {
			return snapshot{}, err
		}
		link, err := globalXWorkbookURL(page, src.Code)
		if err != nil {
			return snapshot{}, err
		}
		src.URL = link
		if err := pauseETF(ctx); err != nil {
			return snapshot{}, err
		}
	}
	body, err := fetchFile(ctx, client, src.URL)
	if err != nil {
		return snapshot{}, err
	}
	var snap snapshot
	switch src.Format {
	case "ishares":
		snap, err = parseISharesJSON(src, body, codes)
		if err == nil {
			if err = pauseETF(ctx); err == nil {
				snap.AsAt, err = isharesAsAt(ctx, client, src)
			}
		}
	case "vanguard":
		snap, err = parseVanguardJSON(src, body, codes)
	case "spdr":
		snap, err = parseSPDRXLSX(src, body, codes)
	case "betashares":
		snap, err = parseBetashares(src, body, codes)
	case "globalx":
		snap, err = parseGlobalXXLSX(src, body, codes)
	default:
		err = fmt.Errorf("unknown format %q", src.Format)
	}
	if err != nil {
		return snapshot{}, err
	}
	if snap.AsAt == "" {
		return snapshot{}, errors.New("no as-at date in the file")
	}
	log.Printf("ownership etf %s: as at %s, %d rows, %d ASX holdings, %d skipped",
		src.Code, snap.AsAt, snap.RowsTotal, len(snap.Holdings), snap.Skipped)
	return snap, nil
}
