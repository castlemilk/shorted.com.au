package main

import (
	"bytes"
	"testing"

	"github.com/xuri/excelize/v2"
)

func TestIncomeYearFromResource(t *testing.T) {
	for _, tc := range []struct {
		name string
		res  ckanResource
		want int
		ok   bool
	}{
		{"recent", ckanResource{Name: "2023-24 Report of Entity Tax Information"}, 2024, true},
		{"oldest", ckanResource{Name: "2013-14 Report of Entity Tax Information"}, 2014, true},
		{"from url", ckanResource{URL: "https://x/2016-17-corporate-report.xlsx"}, 2017, true},
		{"none", ckanResource{Name: "Report of Entity Tax Information"}, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := incomeYearFromResource(tc.res)
			if ok != tc.ok || (ok && got != tc.want) {
				t.Fatalf("incomeYearFromResource=%d,%v want %d,%v", got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestParseAmount(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want float64
		ok   bool
	}{
		{"159074147", 159074147, true},
		{"$1,904,341", 1904341, true},
		{" 6 347 804 ", 6347804, true},
		{"", 0, false},
		{"n/a", 0, false},
	} {
		got, ok := parseAmount(tc.in)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Fatalf("parseAmount(%q)=%v,%v want %v,%v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

// buildXLSX writes a minimal ATO-shaped workbook: an "Information" cover sheet
// (must be skipped) and an "Income tax details" sheet whose header is on row 1.
// One row deliberately leaves taxable income + tax payable BLANK (sparse cells,
// as the real files do) so we verify they parse to nil, not 0.
func buildXLSX(t *testing.T) []byte {
	t.Helper()
	f := excelize.NewFile()
	_, _ = f.NewSheet("Information")
	sheet := "Income tax details"
	_, _ = f.NewSheet(sheet)
	if err := f.DeleteSheet("Sheet1"); err != nil {
		t.Fatalf("delete default sheet: %v", err)
	}

	set := func(cell, v string) { _ = f.SetCellValue(sheet, cell, v) }
	// Header
	set("A1", "Name")
	set("B1", "ABN")
	set("C1", "Total income $")
	set("D1", "Taxable income $")
	set("E1", "Tax payable $")
	set("F1", "Income year")
	// Full row
	set("A2", "1884 PTY LIMITED")
	set("B2", "83114980880")
	set("C2", "337911962")
	set("D2", "6347804")
	set("E2", "1904341")
	set("F2", "2023-24")
	// Sparse row: taxable + payable blank (D3/E3 unset)
	set("A3", "1 MENDS STREET PTY LTD")
	set("B3", "94600082111")
	set("C3", "159074147")
	set("F3", "2023-24")
	// Row with a malformed ABN (must be skipped)
	set("A4", "BAD ABN CO")
	set("B4", "123")
	set("C4", "1000")

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatalf("write xlsx: %v", err)
	}
	return buf.Bytes()
}

func TestParseTaxXLSX_SparseCellsAndValidation(t *testing.T) {
	rows, err := parseTaxXLSX(buildXLSX(t), 2024)
	if err != nil {
		t.Fatalf("parseTaxXLSX: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 valid rows (bad ABN skipped), got %d: %+v", len(rows), rows)
	}

	byABN := map[string]TaxRow{}
	for _, r := range rows {
		byABN[r.ABN] = r
	}

	full, ok := byABN["83114980880"]
	if !ok {
		t.Fatal("missing full row")
	}
	if full.TotalIncome != 337911962 {
		t.Fatalf("total income = %v", full.TotalIncome)
	}
	if full.TaxableIncome == nil || *full.TaxableIncome != 6347804 {
		t.Fatalf("taxable income = %v", full.TaxableIncome)
	}
	if full.TaxPayable == nil || *full.TaxPayable != 1904341 {
		t.Fatalf("tax payable = %v", full.TaxPayable)
	}

	sparse, ok := byABN["94600082111"]
	if !ok {
		t.Fatal("missing sparse row")
	}
	if sparse.TotalIncome != 159074147 {
		t.Fatalf("sparse total income = %v", sparse.TotalIncome)
	}
	// Blank taxable income + tax payable must be nil (meaningful), never 0.
	if sparse.TaxableIncome != nil {
		t.Fatalf("sparse taxable income should be nil, got %v", *sparse.TaxableIncome)
	}
	if sparse.TaxPayable != nil {
		t.Fatalf("sparse tax payable should be nil, got %v", *sparse.TaxPayable)
	}
	if sparse.IncomeYear != 2024 {
		t.Fatalf("income year = %d", sparse.IncomeYear)
	}
}
