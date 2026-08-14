package influence

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"
)

// TaxRow is one entity's tax figures for a single income year, parsed from an
// ATO "Report of Entity Tax Information" XLSX. TaxableIncome / TaxPayable are
// pointers because a blank cell is MEANINGFUL (not reported / nil) — never 0.
type TaxRow struct {
	ABN           string
	EntityName    string
	IncomeYear    int
	TotalIncome   float64
	TaxableIncome *float64
	TaxPayable    *float64
}

var (
	abnDigits = regexp.MustCompile(`\D`)              // strip everything non-digit
	yearRe    = regexp.MustCompile(`(\d{4})-\d{2,4}`) // "2023-24" → start year 2023
)

// incomeYearFromResource derives the income_year (the year the financial year
// ENDS in — 2023-24 → 2024) from a resource's name or description.
func incomeYearFromResource(r ckanResource) (int, bool) {
	for _, s := range []string{r.Name, r.Description, r.URL} {
		if m := yearRe.FindStringSubmatch(s); m != nil {
			start, err := strconv.Atoi(m[1])
			if err == nil {
				return start + 1, true
			}
		}
	}
	return 0, false
}

// parseTaxXLSX parses one annual report file into TaxRows for the given income year.
func parseTaxXLSX(data []byte, incomeYear int) ([]TaxRow, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("open xlsx: %w", err)
	}
	defer func() { _ = f.Close() }()

	sheet, rows, err := selectDataSheet(f)
	if err != nil {
		return nil, err
	}

	headerIdx, cols, err := findHeader(rows)
	if err != nil {
		return nil, fmt.Errorf("sheet %q: %w", sheet, err)
	}

	var out []TaxRow
	for _, row := range rows[headerIdx+1:] {
		abn := abnDigits.ReplaceAllString(cell(row, cols.abn), "")
		if len(abn) != 11 { // must be exactly 11 digits after stripping — else skip
			continue
		}
		tr := TaxRow{
			ABN:        abn,
			EntityName: strings.TrimSpace(cell(row, cols.name)),
			IncomeYear: incomeYear,
		}
		if v, ok := parseAmount(cell(row, cols.totalIncome)); ok {
			tr.TotalIncome = v
		}
		if cols.taxableIncome >= 0 {
			if v, ok := parseAmount(cell(row, cols.taxableIncome)); ok {
				tr.TaxableIncome = &v
			}
		}
		if cols.taxPayable >= 0 {
			if v, ok := parseAmount(cell(row, cols.taxPayable)); ok {
				tr.TaxPayable = &v
			}
		}
		out = append(out, tr)
	}
	return out, nil
}

// taxColumns holds the 0-based column index of each logical field; -1 = absent.
type taxColumns struct {
	name          int
	abn           int
	totalIncome   int
	taxableIncome int
	taxPayable    int
}

// selectDataSheet picks the sheet holding the entity table. Sheet naming varies
// across years ("Income tax details" recently; "Combined"/"December"/"March" in
// 2013-14). Skip the "Information" cover sheet and the "PRRT details" sheet; among
// the rest prefer an "income tax" sheet, then a "combined" sheet, then the sheet
// with the most rows.
func selectDataSheet(f *excelize.File) (string, [][]string, error) {
	best := ""
	var bestRows [][]string
	bestScore := -1
	for _, s := range f.GetSheetList() {
		n := strings.ToLower(s)
		if strings.Contains(n, "information") || strings.Contains(n, "prrt") {
			continue
		}
		rows, err := f.GetRows(s)
		if err != nil {
			continue
		}
		rank := 1
		switch {
		case strings.Contains(n, "income tax"):
			rank = 3
		case strings.Contains(n, "combined"):
			rank = 2
		}
		// Rank dominates; row count breaks ties (×1e6 keeps rank on top for any
		// realistic sheet size).
		score := rank*1_000_000 + len(rows)
		if score > bestScore {
			bestScore, best, bestRows = score, s, rows
		}
	}
	if best == "" {
		return "", nil, fmt.Errorf("no data sheet found (sheets=%v)", f.GetSheetList())
	}
	return best, bestRows, nil
}

// findHeader scans the first rows for the header (a row with an "ABN" column and a
// "total income" column) and returns its index plus the resolved column map.
func findHeader(rows [][]string) (int, taxColumns, error) {
	limit := len(rows)
	if limit > 20 {
		limit = 20
	}
	for i := 0; i < limit; i++ {
		cols := taxColumns{name: -1, abn: -1, totalIncome: -1, taxableIncome: -1, taxPayable: -1}
		for j, raw := range rows[i] {
			switch h := normHeader(raw); {
			case h == "abn":
				cols.abn = j
			case h == "name" || strings.HasPrefix(h, "name"):
				if cols.name < 0 {
					cols.name = j
				}
			case strings.HasPrefix(h, "total income"):
				cols.totalIncome = j
			case strings.HasPrefix(h, "taxable income"):
				cols.taxableIncome = j
			case strings.HasPrefix(h, "tax payable"):
				cols.taxPayable = j
			}
		}
		if cols.abn >= 0 && cols.totalIncome >= 0 && cols.name >= 0 {
			return i, cols, nil
		}
	}
	return 0, taxColumns{}, fmt.Errorf("header row not found (name/abn/total income)")
}

// normHeader lowercases a header cell and drops the trailing "$" + whitespace so
// "Total Income $" and "Total income$" both match "total income".
func normHeader(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimSuffix(strings.TrimSpace(strings.TrimSuffix(s, "$")), "$")
	return strings.Join(strings.Fields(s), " ")
}

// cell safely reads a column from a row (excelize trims trailing blank cells, so
// a missing trailing tax-payable column reads as "" → NULL).
func cell(row []string, i int) string {
	if i >= 0 && i < len(row) {
		return strings.TrimSpace(row[i])
	}
	return ""
}

// parseAmount parses a dollar figure, tolerating "$", thousands separators and
// spaces. A blank/unparseable cell returns ok=false (→ NULL for taxable/payable).
func parseAmount(s string) (float64, bool) {
	// Drop currency symbols, thousands separators, ordinary + non-breaking spaces.
	s = strings.Map(func(r rune) rune {
		if r == '$' || r == ',' || r == ' ' || r == ' ' {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// ingestTax discovers every annual report resource, parses it, and returns all
// rows. Per-resource failures are logged and skipped so one bad file doesn't sink
// the whole run.
func ingestTax(ctx context.Context) ([]TaxRow, map[int]int, error) {
	resources, err := fetchTaxResources(ctx)
	if err != nil {
		return nil, nil, err
	}
	var all []TaxRow
	perYear := map[int]int{}
	for _, r := range resources {
		year, ok := incomeYearFromResource(r)
		if !ok {
			log.Printf("[tax] skip resource %q: no income year in name", r.Name)
			continue
		}
		data, err := downloadResource(ctx, r.URL)
		if err != nil {
			log.Printf("[tax] download %q (year %d) failed: %v", r.Name, year, err)
			continue
		}
		rows, err := parseTaxXLSX(data, year)
		if err != nil {
			log.Printf("[tax] parse %q (year %d) failed: %v", r.Name, year, err)
			continue
		}
		perYear[year] = len(rows)
		all = append(all, rows...)
		log.Printf("[tax] %d: parsed %d entities from %q", year, len(rows), r.Name)
	}
	if len(all) == 0 {
		return nil, nil, fmt.Errorf("no tax rows parsed from any resource")
	}
	return all, perYear, nil
}
