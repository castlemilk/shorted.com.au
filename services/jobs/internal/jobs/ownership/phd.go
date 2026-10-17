package ownership

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// Super fund portfolio holdings disclosure (Corporations Act s1017BB,
// Corporations Regulations Schedule 8D). Every APRA-regulated fund publishes
// each investment option's holdings as at 30 June and 31 December, within
// 90 days. The table is prescribed (name, security identifier, units, value,
// weighting) but each fund lays it out its own way, so one parser reads them
// all by finding header rows.

type phdSource struct {
	Institution string
	Option      string
	// URL may carry period placeholders: {month} (june, december), {yyyy},
	// {dd} (30, 31).
	URL    string
	Format string // csv, xlsx
}

// phdSources are each fund's default or balanced option: the option most
// members are in. A snapshot is that option's holdings, never the whole
// fund's. AustralianSuper, UniSuper, CFS, MLC, CareSuper and CSC publish
// behind bot protection that refuses this job, so they are not here.
var phdSources = []phdSource{
	{"australian-retirement-trust", "Balanced", "https://files.australianretirementtrust.com.au/phd/super/diversified/Diversified_Balanced_Superannuation.csv", "csv"},
	{"aware-super", "Balanced (Accumulation)", "https://aware.com.au/content/dam/aware/au/en/documents/member/disclosure/phd/portfolio-holdings-disclosure/Accumulation-Balanced.csv", "csv"},
	{"hostplus", "Balanced", "https://hostplus.com.au/content/dam/hostplus-program/site/resources/investments/investment-holdings/accumulation-investment-holdings/Balanced.csv", "csv"},
	{"cbus", "Growth (Cbus MySuper)", "https://www.cbussuper.com.au/content/dam/cbus/files/governance/investment-holdings/super-growth.csv", "csv"},
	{"hesta", "Balanced Growth", "https://www.hesta.com.au/content/dam/hesta/phd-all-files/accum-{month}-{yyyy}/balanced-growth/Balanced-Growth-super-assets.csv", "csv"},
	{"rest", "Growth", "https://rest.com.au/rest_web/media/documents/investments/portfolio-holdings-disclosure/super-growth-table1.csv", "csv"},
	{"brighter-super", "Balanced", "https://www.brightersuper.com.au/-/media/public/files/portfolio-holdings-disclosure-{month}-{yyyy}/balanced_accumulation_{dd}{month}{yyyy}_table1.csv?la=en", "csv"},
	{"equip-super", "Balanced Growth", "https://www.equipsuper.com.au/content/dam/equip_super/documents/investment/portfolio-holdings/equip-balanced-growth-super.csv", "csv"},
	{"legalsuper", "Balanced", "https://www.legalsuper.com.au/siteassets/shared-media/investments-portfolio-holdings/{month}-{yyyy}/legalsuper-phd-super-balanced-{month}-{yyyy}.csv", "csv"},
	{"mercer-super", "Mercer Growth", "https://www.mercersuper.com.au/content/dam/mercer-super/australia/documents/investment-options/csd/Mercer%20Growth.csv", "csv"},
	{"vision-super", "Balanced", "https://docs.visionsuper.com.au/PHD/vision/superNCAP/balanced/xlsx", "xlsx"},
}

// phdPeriod is the disclosure period whose files are due by now: the latest
// 30 June or 31 December at least 90 days ago.
func phdPeriod(now time.Time) time.Time {
	y := now.Year()
	for _, end := range []time.Time{
		time.Date(y, 12, 31, 0, 0, 0, 0, time.UTC),
		time.Date(y, 6, 30, 0, 0, 0, 0, time.UTC),
		time.Date(y-1, 12, 31, 0, 0, 0, 0, time.UTC),
		time.Date(y-1, 6, 30, 0, 0, 0, 0, time.UTC),
	} {
		if !end.AddDate(0, 0, 90).After(now) {
			return end
		}
	}
	return time.Date(y-1, 6, 30, 0, 0, 0, 0, time.UTC)
}

// previousPeriod is the period before p.
func previousPeriod(p time.Time) time.Time {
	if p.Month() == time.December {
		return time.Date(p.Year(), 6, 30, 0, 0, 0, 0, time.UTC)
	}
	return time.Date(p.Year()-1, 12, 31, 0, 0, 0, 0, time.UTC)
}

func expandPeriod(url string, p time.Time) string {
	return strings.NewReplacer(
		"{month}", strings.ToLower(p.Month().String()),
		"{yyyy}", fmt.Sprintf("%d", p.Year()),
		"{dd}", fmt.Sprintf("%02d", p.Day()),
	).Replace(url)
}

// phdColumns is one header row's column positions; -1 when absent.
type phdColumns struct {
	name, id, units, value, weight, class, currency, date int
	weightPct                                             bool
}

var (
	idHeaderRe     = regexp.MustCompile(`(?i)security\s*identifier|security\s*id\b|^isin$|^sedol$|^ticker$`)
	valueHeaderRe  = regexp.MustCompile(`(?i)value`)
	unitsHeaderRe  = regexp.MustCompile(`(?i)units|number of shares|quantity`)
	weightHeaderRe = regexp.MustCompile(`(?i)weight`)
	classHeaderRe  = regexp.MustCompile(`(?i)asset\s*class|^section$|^type$|kind of asset`)
	currHeaderRe   = regexp.MustCompile(`(?i)currency`)
	dateHeaderRe   = regexp.MustCompile(`(?i)as\s*at\s*date|effective\s*date|asatdate`)
	nameHeaderRes  = []*regexp.Regexp{
		regexp.MustCompile(`(?i)kind of investment item|name of investment item|security name`),
		regexp.MustCompile(`(?i)name of (?:institution|issuer)`),
		regexp.MustCompile(`(?i)^name\b|\bname$`),
	}
)

// phdHeader reads a header row, or ok=false when the row is not one.
func phdHeader(row []string) (phdColumns, bool) {
	c := phdColumns{name: -1, id: -1, units: -1, value: -1, weight: -1, class: -1, currency: -1, date: -1}
	for i, raw := range row {
		h := strings.TrimSpace(raw)
		switch {
		case h == "":
		case c.id < 0 && idHeaderRe.MatchString(h):
			c.id = i
		case c.date < 0 && dateHeaderRe.MatchString(h):
			c.date = i
		case c.weight < 0 && weightHeaderRe.MatchString(h):
			c.weight = i
			c.weightPct = strings.Contains(h, "%")
		case c.value < 0 && valueHeaderRe.MatchString(h) && !strings.Contains(strings.ToLower(h), "total"):
			c.value = i
		case c.units < 0 && unitsHeaderRe.MatchString(h):
			c.units = i
		case c.class < 0 && classHeaderRe.MatchString(h):
			c.class = i
		case c.currency < 0 && currHeaderRe.MatchString(h):
			c.currency = i
		}
	}
	if c.id < 0 || c.value < 0 {
		return c, false
	}
	for _, re := range nameHeaderRes {
		for i, raw := range row {
			if i != c.id && re.MatchString(strings.TrimSpace(raw)) {
				c.name = i
				break
			}
		}
		if c.name >= 0 {
			break
		}
	}
	return c, true
}

var (
	auISINRe   = regexp.MustCompile(`^AU000000([A-Z0-9]{3})\d$`)
	bareTickRe = regexp.MustCompile(`^[A-Z0-9]{3,5}$`)
)

// matchSecurity maps a PHD row's identifier to an ASX code. A bare ticker
// ("BHP" in Mercer's and Legalsuper's files) names an offshore listing just as
// often ("CSL" is also a NYSE ticker), so it counts only when the row's name
// is the code's company; an AU ISIN not in the identifier map is checked the
// same way.
func matchSecurity(rawID, name string, codes codeSet, ids map[string]identifier) (string, string, bool) {
	id := strings.ToUpper(strings.TrimSpace(rawID))
	if id == "" || id == "-" || id == "N/A" {
		return "", "", false
	}
	if strings.ContainsAny(id, " :-") {
		if code, ok := codes.asxTicker(id); ok {
			return code, "ticker", true
		}
	}
	if ident, ok := ids[id]; ok {
		if _, listed := codes[ident.Code]; listed {
			return ident.Code, ident.Kind, true
		}
	}
	nameMatches := func(code string) bool {
		c, ok := codes[code]
		return ok && name != "" && extractiontrust.EntityMatches(name, c.Name)
	}
	if m := auISINRe.FindStringSubmatch(id); m != nil && nameMatches(m[1]) {
		return m[1], "isin", true
	}
	if bareTickRe.MatchString(id) && nameMatches(id) {
		return id, "ticker", true
	}
	return "", "", false
}

// isListedEquityClass is false for a row whose asset class names something
// other than listed shares (cash, fixed income, unlisted property).
func isListedEquityClass(class string) bool {
	c := strings.ToLower(strings.TrimSpace(class))
	if c == "" || c == "-" {
		return true
	}
	if strings.Contains(c, "unlisted") {
		return false
	}
	return strings.Contains(c, "equit") || strings.Contains(c, "listed") || strings.Contains(c, "shares")
}

// parsePHD reads a fund option's holdings rows (CSV records or worksheet
// rows) into a snapshot of its ASX stocks.
func parsePHD(src phdSource, url string, rows [][]string, codes codeSet, ids map[string]identifier, period time.Time) (snapshot, error) {
	snap := snapshot{InstitutionSlug: src.Institution, FundName: src.Option, SourceKind: "super_phd", SourceURL: url}
	var cols phdColumns
	have := false
	byCode := map[string]*holding{}
	var order []string
	sawPct := false
	maxWeight := 0.0
	cell := func(row []string, i int) string {
		if i >= 0 && i < len(row) {
			return strings.TrimSpace(row[i])
		}
		return ""
	}
	for _, row := range rows {
		if c, ok := phdHeader(row); ok {
			cols, have = c, true
			continue
		}
		if !have {
			continue
		}
		id := cell(row, cols.id)
		if id == "" {
			continue
		}
		snap.RowsTotal++
		if snap.AsAt == "" && cols.date >= 0 {
			snap.AsAt = parseAsAt(cell(row, cols.date))
		}
		if cols.class >= 0 && !isListedEquityClass(cell(row, cols.class)) {
			continue
		}
		if cur := strings.ToUpper(cell(row, cols.currency)); cur != "" && cur != "AUD" && cur != "-" && cur != "N/A" {
			continue
		}
		name := cell(row, cols.name)
		code, how, ok := matchSecurity(id, name, codes, ids)
		if !ok {
			continue
		}
		w := cell(row, cols.weight)
		if strings.Contains(w, "%") {
			sawPct = true
		}
		h, seen := byCode[code]
		if !seen {
			h = &holding{Code: code, Name: name, Match: how}
			byCode[code] = h
			order = append(order, code)
		}
		h.Units = addPtr(h.Units, numPtr(cell(row, cols.units)))
		h.Value = addPtr(h.Value, numPtr(cell(row, cols.value)))
		h.Weight = addPtr(h.Weight, numPtr(w))
		if h.Weight != nil && *h.Weight > maxWeight {
			maxWeight = *h.Weight
		}
		if cols.weightPct {
			sawPct = true
		}
	}
	if !have {
		return snap, errors.New("no holdings table header (security identifier and value columns)")
	}
	// HESTA writes weights as fractions (0.0226 for 2.26%). A file with no %
	// anywhere whose largest stock weight is under 1 is one of those.
	fraction := !sawPct && maxWeight > 0 && maxWeight <= 1
	for _, code := range order {
		h := byCode[code]
		if fraction && h.Weight != nil {
			v := *h.Weight * 100
			h.Weight = &v
		}
		snap.Holdings = append(snap.Holdings, *h)
	}
	if snap.AsAt == "" {
		// The file states no date: it is the period it was published for.
		snap.AsAt = period.Format("2006-01-02")
	}
	return snap, nil
}

func addPtr(a, b *float64) *float64 {
	switch {
	case b == nil:
		return a
	case a == nil:
		v := *b
		return &v
	default:
		v := *a + *b
		return &v
	}
}

// fetchPHD downloads one fund option's file, trying the previous period's
// URL when a dated one is not up yet.
func fetchPHD(ctx context.Context, client *http.Client, src phdSource, codes codeSet, ids map[string]identifier, now time.Time) (snapshot, error) {
	period := phdPeriod(now)
	periods := []time.Time{period}
	if strings.Contains(src.URL, "{") {
		periods = append(periods, previousPeriod(period))
	}
	var lastErr error
	for _, p := range periods {
		url := expandPeriod(src.URL, p)
		body, err := fetchFile(ctx, client, url)
		if err != nil {
			lastErr = fmt.Errorf("%s: %w", url, err)
			continue
		}
		var rows [][]string
		if src.Format == "xlsx" {
			rows, err = xlsxRows(body)
		} else {
			rows, err = readCSV(body)
		}
		if err != nil {
			return snapshot{}, fmt.Errorf("%s: %w", url, err)
		}
		return parsePHD(src, url, rows, codes, ids, p)
	}
	return snapshot{}, lastErr
}
