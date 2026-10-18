package ownership

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

// Holdings files: what an ETF or a super fund option holds, in full. Each
// file becomes one snapshot of ASX stocks; a row that is not an ASX stock
// (cash, a futures contract, an offshore listing) is counted, never stored.

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
	AsAt            string // YYYY-MM-DD
	RowsTotal       int
	Holdings        []holding
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
	Format      string // ishares, vanguard, spdr, betashares
	URL         string
	// DateURL is a second file that carries the as-at date when URL does not.
	DateURL string
}

// etfSources are the largest Australian-equity index ETFs of the four
// issuers that publish machine-readable daily holdings. Vanguard's file is
// its pooled wholesale fund, so its units are the whole index fund's, not
// only the ETF's.
var etfSources = []etfSource{
	ishares("IOZ", "iShares Core S&P/ASX 200 ETF", "251852"),
	ishares("ILC", "iShares S&P/ASX 20 ETF", "251921"),
	ishares("ISO", "iShares S&P/ASX Small Ordinaries ETF", "251923"),
	vanguard("VAS", "Vanguard Australian Shares Index Fund (VAS)", "8205"),
	vanguard("VHY", "Vanguard Australian Shares High Yield Fund (VHY)", "8210"),
	vanguard("VSO", "Vanguard MSCI Australian Small Companies Index Fund (VSO)", "8211"),
	vanguard("VLC", "Vanguard MSCI Australian Large Companies Index Fund (VLC)", "8209"),
	spdr("STW", "SPDR S&P/ASX 200 Fund"),
	spdr("SFY", "SPDR S&P/ASX 50 Fund"),
	spdr("SSO", "SPDR S&P/ASX Small Ordinaries Fund"),
	betashares("A200", "Betashares Australia 200 ETF"),
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

func spdr(code, name string) etfSource {
	return etfSource{Code: code, Name: name, Institution: "state-street", Format: "spdr",
		URL: "https://www.ssga.com/au/en_gb/intermediary/library-content/products/fund-data/etfs/apac/holdings-daily-au-en-" + strings.ToLower(code) + ".xlsx"}
}

func betashares(code, name string) etfSource {
	return etfSource{Code: code, Name: name, Institution: "betashares", Format: "betashares",
		URL: "https://www.betashares.com.au/files/csv/" + code + "_Portfolio_Holdings.csv"}
}

func newETFSnapshot(src etfSource) snapshot {
	return snapshot{InstitutionSlug: src.Institution, FundName: src.Name, FundCode: src.Code, SourceKind: "etf",
		SourceURL: src.URL, Identifiers: map[string]identifier{}}
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
		if !strings.EqualFold(str(row[3]), "Equity") || !strings.Contains(strings.ToUpper(str(row[13])), "ASX") {
			continue
		}
		code, ok := codes.asxTicker(str(row[0]))
		if !ok {
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
		if r.CountryCode != "" && r.CountryCode != "AU" {
			continue
		}
		code, ok := codes.asxTicker(r.Ticker)
		if !ok {
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
// shares times price.
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
			continue
		}
		units, price := numPtr(cell("number of shares")), numPtr(cell("local price"))
		var value *float64
		if units != nil && price != nil {
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
// "key,value" lines (Date,2026-10-15), then the table.
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
		if strings.TrimSpace(cell("ticker")) == "" {
			continue
		}
		snap.RowsTotal++
		code, ok := codes.asxTicker(cell("ticker"))
		if !ok {
			continue
		}
		snap.Holdings = append(snap.Holdings, holding{Code: code, Name: cell("name"), Units: numPtr(cell("shares")),
			Value: numPtr(cell("market value")), Weight: numPtr(cell("weight")), Match: "ticker"})
	}
	return snap, nil
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

// xlsxRows is the first sheet's rows as strings.
func xlsxRows(body []byte) ([][]string, error) {
	f, err := excelize.OpenReader(bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("open workbook: %w", err)
	}
	defer func() { _ = f.Close() }()
	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, errors.New("workbook has no sheets")
	}
	return f.GetRows(sheets[0])
}

var (
	isinRe  = regexp.MustCompile(`^[A-Z]{2}[A-Z0-9]{9}[0-9]$`)
	sedolRe = regexp.MustCompile(`^[0-9BCDFGHJKLMNPQRSTVWXYZ]{6}[0-9]$`)
)

// fetchETF downloads and parses one ETF's holdings.
func fetchETF(ctx context.Context, client *http.Client, src etfSource, codes codeSet) (snapshot, error) {
	body, err := fetchFile(ctx, client, src.URL)
	if err != nil {
		return snapshot{}, err
	}
	var snap snapshot
	switch src.Format {
	case "ishares":
		snap, err = parseISharesJSON(src, body, codes)
		if err == nil && src.DateURL != "" {
			if dateBody, derr := fetchFile(ctx, client, src.DateURL); derr == nil {
				snap.AsAt = parseISharesAsAt(dateBody)
			}
		}
	case "vanguard":
		snap, err = parseVanguardJSON(src, body, codes)
	case "spdr":
		snap, err = parseSPDRXLSX(src, body, codes)
	case "betashares":
		snap, err = parseBetashares(src, body, codes)
	default:
		err = fmt.Errorf("unknown format %q", src.Format)
	}
	if err != nil {
		return snapshot{}, err
	}
	if snap.AsAt == "" {
		return snapshot{}, errors.New("no as-at date in the file")
	}
	return snap, nil
}
