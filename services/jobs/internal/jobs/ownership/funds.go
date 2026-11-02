package ownership

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// The map of products: every APRA-regulated super fund with its total assets,
// and every ASX-quoted ETF, LIC and LIT with its issuer and size. Both
// sources publish a new workbook each period under a new name, so each run
// reads the publisher's page for the latest link.

// fundRow is one product as stored in ownership_funds.
type fundRow struct {
	Key             string // abn:<ABN> or asx:<CODE>
	Name            string
	Type            string // super_fund, etf, lic
	ASXCode         string
	ABN             string
	Manager         string
	InstitutionSlug string
	Category        string
	AUM             *float64 // AUD
	AsAt            string
	Source          string
	SourceURL       string
}

const (
	apraPage = "https://www.apra.gov.au/annual-fund-level-superannuation-statistics"
	asxPage  = "https://www.asx.com.au/issuers/investment-products/asx-investment-products-monthly-report"
)

var (
	hrefRe = regexp.MustCompile(`href="([^"]+\.xlsx[^"]*)"`)
	// The asset tables, not the back series, the expenditure or the insurance
	// workbooks published beside them.
	apraWorkbookRe = regexp.MustCompile(`(?i)annual%20fund-level%20superannuation%20statistics%20(?:june|december)%20\d{4}`)
	asxWorkbookRe  = regexp.MustCompile(`(?i)asx-investment-products-([a-z]+)-(\d{4})-abs\.xlsx`)
	productCodeRe  = regexp.MustCompile(`^[A-Z0-9]{3,6}$`)
)

// latestLink returns the first workbook link on a page that the pattern
// accepts, made absolute. Both publishers list the newest first.
func latestLink(page []byte, base string, accept *regexp.Regexp) (string, error) {
	for _, m := range hrefRe.FindAllSubmatch(page, -1) {
		href := strings.ReplaceAll(string(m[1]), "&amp;", "&")
		if !accept.MatchString(href) {
			continue
		}
		if strings.HasPrefix(href, "/") {
			href = base + href
		}
		return href, nil
	}
	return "", errors.New("no workbook link on the page")
}

// parseAPRAFunds reads Table 2a of APRA's annual fund-level statistics: one
// row per fund with its ABN, RSE licensee, fund type and total assets ($'000).
func parseAPRAFunds(rows [][]string, url string) ([]fundRow, error) {
	col := map[string]int{}
	var out []fundRow
	for _, row := range rows {
		if len(col) == 0 {
			for i, c := range row {
				col[strings.ToLower(strings.TrimSpace(c))] = i
			}
			if _, ok := col["fund name"]; !ok {
				col = map[string]int{}
				continue
			}
			for _, need := range []string{"abn", "total assets", "fund's rse licensee", "fund type", "period"} {
				if _, ok := col[need]; !ok {
					return nil, fmt.Errorf("APRA table 2a has no %q column", need)
				}
			}
			continue
		}
		cell := func(name string) string {
			if i := col[name]; i < len(row) {
				return strings.TrimSpace(row[i])
			}
			return ""
		}
		name, abn := cell("fund name"), strings.ReplaceAll(cell("abn"), " ", "")
		if name == "" || len(abn) != 11 {
			continue
		}
		f := fundRow{Key: "abn:" + abn, Name: name, Type: "super_fund", ABN: abn, Manager: cell("fund's rse licensee"),
			Category: cell("fund type"), AsAt: parseAPRADate(cell("period")), Source: "apra-fund-level", SourceURL: url}
		if v, ok := parseNumber(cell("total assets")); ok {
			aud := v * 1000
			f.AUM = &aud
		}
		if inst := resolveInstitution(name); inst != nil && inst.Kind == KindSuperFund {
			f.InstitutionSlug = inst.Slug
		} else if inst := resolveInstitution(f.Manager); inst != nil && inst.Kind == KindSuperFund {
			f.InstitutionSlug = inst.Slug
		}
		out = append(out, f)
	}
	if len(col) == 0 {
		return nil, errors.New("APRA table 2a header not found")
	}
	return out, nil
}

// parseAPRADate reads the period cell as xlsxSheet returns it: the text Excel
// shows, not the serial. Table 2a's period is Excel's built-in format 14, which
// excelize prints month first, so "06-30-25" is 30 June 2025 (serial 45838).
// A blank or unparseable cell is "", never a guessed date.
func parseAPRADate(s string) string {
	s = strings.TrimSpace(s)
	if v, ok := parseNumber(s); ok && v > 30000 && v < 80000 {
		return time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC).AddDate(0, 0, int(v)).Format("2006-01-02")
	}
	if len(s) >= 10 {
		if t, err := time.Parse("2006-01-02", s[:10]); err == nil {
			return t.Format("2006-01-02")
		}
	}
	// Format 14 always shows a real date, so text that reads month first is
	// that date. Text that does not is not format 14 and goes on to the forms
	// below.
	if t, err := time.Parse("1-2-06", s); err == nil {
		return t.Format("2006-01-02")
	}
	for _, layout := range apraDayLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Format("2006-01-02")
		}
	}
	for _, layout := range apraMonthLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.AddDate(0, 1, -1).Format("2006-01-02")
		}
	}
	return parseAsAt(s)
}

// apraDayLayouts are the dated forms of the period cell besides ISO and format
// 14. A slash is day first, as Australian dates are written.
var apraDayLayouts = []string{
	"2/1/2006", "2/1/06", // 30/06/2025, 30/6/25
	"2 Jan 2006", "2 January 2006", "2-Jan-2006", "2-Jan-06", // 30 Jun 2025, 30-Jun-25
}

// apraMonthLayouts are the month-only forms. Each reads as the month's last day.
var apraMonthLayouts = []string{"Jan 2006", "January 2006", "Jan-2006", "Jan-06", "2006-01"}

// monthEnd is the last day of the report's month ("sep", "2026").
func monthEnd(month, year string) string {
	t, err := time.Parse("Jan 2006", strings.ToUpper(month[:1])+strings.ToLower(month[1:3])+" "+year)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 1, -1).Format("2006-01-02")
}

// parseASXProducts reads the ETP and LIC lists of ASX's monthly Investment
// Products report. A row with only its first cell set is an asset-class
// heading ("Equity - Australia"), carried as the products' category.
func parseASXProducts(etpRows, licRows [][]string, url, asAt string) ([]fundRow, error) {
	var out []fundRow
	read := func(rows [][]string, typ string, codeHeader string, fum string) error {
		col := map[string]int{}
		category := ""
		for _, row := range rows {
			if len(col) == 0 {
				for i, c := range row {
					col[strings.ToLower(strings.Join(strings.Fields(c), " "))] = i
				}
				if _, ok := col[codeHeader]; !ok {
					col = map[string]int{}
				}
				continue
			}
			cell := func(name string) string {
				if i, ok := col[name]; ok && i < len(row) {
					return strings.TrimSpace(row[i])
				}
				return ""
			}
			code, name := strings.ToUpper(cell(codeHeader)), cell("fund name")
			if code != "" && name == "" && cell("type") == "" {
				category = cell(codeHeader)
				continue
			}
			if !productCodeRe.MatchString(code) || name == "" {
				continue
			}
			f := fundRow{Key: "asx:" + code, Name: name, Type: typ, ASXCode: code, Manager: cell("issuer"),
				Category: strings.TrimSpace(category + " / " + cell("type")), AsAt: asAt, Source: "asx-investment-products", SourceURL: url}
			if v, ok := parseNumber(cell(fum)); ok && v > 0 {
				aud := v * 1e6
				f.AUM = &aud
			}
			// The LIC list has no manager column; a LIC is often its own
			// manager (AFIC, Argo, WAM Capital), so its name links it.
			if f.Manager != "" {
				if inst := resolveIssuer(f.Manager); inst != nil {
					f.InstitutionSlug = inst.Slug
				}
			} else if inst := resolveInstitution(f.Name); inst != nil {
				f.InstitutionSlug = inst.Slug
			}
			out = append(out, f)
		}
		if len(col) == 0 {
			return fmt.Errorf("%s list header not found", typ)
		}
		return nil
	}
	if err := read(etpRows, "etf", "asx code", "fum ($m)#"); err != nil {
		return nil, err
	}
	if err := read(licRows, "lic", "asx code", "mkt cap ($m)#"); err != nil {
		return nil, err
	}
	return out, nil
}

// fetchFundRegisters reads both registers. Each returns its own error, so
// one publisher's outage still lets the other's rows land.
func fetchFundRegisters(ctx context.Context, client *http.Client) (map[string][]fundRow, map[string]error) {
	rows, errs := map[string][]fundRow{}, map[string]error{}

	if page, err := fetchPage(ctx, client, apraPage); err != nil {
		errs["apra"] = err
	} else if url, err := latestLink(page, "https://www.apra.gov.au", apraWorkbookRe); err != nil {
		errs["apra"] = err
	} else if body, err := fetchFile(ctx, client, url); err != nil {
		errs["apra"] = fmt.Errorf("%s: %w", url, err)
	} else if sheet, err := xlsxSheet(body, "Table 2a"); err != nil {
		errs["apra"] = err
	} else if funds, err := parseAPRAFunds(sheet, url); err != nil {
		errs["apra"] = err
	} else {
		rows["apra"] = funds
	}

	if page, err := fetchPage(ctx, client, asxPage); err != nil {
		errs["asx"] = err
	} else if url, err := latestLink(page, "https://www.asx.com.au", asxWorkbookRe); err != nil {
		errs["asx"] = err
	} else if body, err := fetchFile(ctx, client, url); err != nil {
		errs["asx"] = fmt.Errorf("%s: %w", url, err)
	} else if etp, err := xlsxSheet(body, "Spotlight ETP List"); err != nil {
		errs["asx"] = err
	} else if lic, err := xlsxSheet(body, "Spotlight LIC List"); err != nil {
		errs["asx"] = err
	} else {
		m := asxWorkbookRe.FindStringSubmatch(url)
		products, err := parseASXProducts(etp, lic, url, monthEnd(m[1], m[2]))
		if err != nil {
			errs["asx"] = err
		} else {
			rows["asx"] = products
		}
	}
	return rows, errs
}

// fetchPage downloads an HTML page (fetchFile refuses HTML on purpose).
func fetchPage(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return readAllLimited(resp, 8<<20)
}
