package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"sort"
	"strings"
	"testing"
)

// nswB builds one B-record in the live PSI layout. Only the fields the filter
// reads vary; the rest are the fixed values seen in real files.
type nswB struct {
	property, suburb, area, areaUnit, zoning, nature, purpose, strata, interest, dealing string
	price                                                                                int
}

func (b nswB) line() string {
	if b.areaUnit == "" {
		b.areaUnit = "M"
	}
	if b.interest == "" {
		b.interest = "0"
	}
	return fmt.Sprintf("B;001;%s;1;20240101 01:07;;;1;SOME ST;%s;2065;%s;%s;20240110;20240112;%d;%s;%s;%s;%s;RAN;;%s;%s;",
		b.property, b.suburb, b.area, b.areaUnit, b.price, b.zoning, b.nature, b.purpose, b.strata, b.interest, b.dealing)
}

func house(property, suburb string, price int, dealing string) nswB {
	return nswB{property: property, suburb: suburb, area: "550", zoning: "R2", nature: "R", purpose: "RESIDENCE", dealing: dealing, price: price}
}

func datOf(records ...nswB) string {
	lines := make([]string, len(records))
	for i, r := range records {
		lines[i] = r.line()
	}
	return strings.Join(lines, "\n") + "\n"
}

func pricesBySuburb(sales []nswSale) map[string][]float64 {
	out := map[string][]float64{}
	for _, s := range sales {
		out[s.suburb] = append(out[s.suburb], s.price)
	}
	for _, p := range out {
		sort.Float64s(p)
	}
	return out
}

// The St Leonards class: one contract buys six houses for a tower site and is
// lodged as six B-records, each carrying the $110.5M contract total. Before the
// filter they outvoted the suburb's five real sales and the median was $110.5M.
func TestNSWMultiPropertyContractIsNotSixHouseSales(t *testing.T) {
	records := []nswB{
		house("1", "ST LEONARDS", 2_400_000, "AT1"),
		house("2", "ST LEONARDS", 2_650_000, "AT2"),
		house("3", "ST LEONARDS", 2_900_000, "AT3"),
		house("4", "ST LEONARDS", 3_100_000, "AT4"),
		house("5", "ST LEONARDS", 3_300_000, "AT5"),
	}
	for i := 0; i < 6; i++ {
		site := house(fmt.Sprintf("9%d", i), "ST LEONARDS", 110_500_000, "AT999")
		site.zoning = "R2" // a bundle is dropped on membership alone, whatever the zone
		records = append(records, site)
	}
	// A vacant lot in the same contract still makes it a bundle.
	records = append(records, nswB{property: "80", suburb: "RHODES", zoning: "R2", nature: "V", purpose: "VACANT LAND", dealing: "AT777", price: 22_500_000, area: "600"})
	records = append(records, house("81", "RHODES", 22_500_000, "AT777"))

	got := pricesBySuburb(parseNSWDAT([]byte(datOf(records...))))
	if len(got["ST LEONARDS"]) != 5 || medianFloat(got["ST LEONARDS"]) != 2_900_000 {
		t.Fatalf("St Leonards must keep only its five single-property sales (median $2.9M), got %v", got["ST LEONARDS"])
	}
	if len(got["RHODES"]) != 0 {
		t.Fatalf("a residence bundled with a vacant lot is a bundle, got %v", got["RHODES"])
	}
}

func TestNSWFilterDropsWholeBuildingAndDevelopmentSiteSales(t *testing.T) {
	keep := []nswB{
		house("1", "KEEP", 1_500_000, "K1"),
		{property: "2", suburb: "KEEP", area: "25.15", areaUnit: "H", zoning: "RU2", nature: "R", purpose: "RESIDENCE", dealing: "K2", price: 1_330_000},
		// Pre-2023 E4 Environmental Living is ordinary housing: the E prefix is not a filter.
		{property: "3", suburb: "KEEP", area: "700", zoning: "E4", nature: "R", purpose: "RESIDENCE", dealing: "K3", price: 2_100_000},
		// A normal lot in a high-density zone is still a house.
		{property: "4", suburb: "KEEP", area: "650", zoning: "R4", nature: "R", purpose: "RESIDENCE", dealing: "K4", price: 1_900_000},
		{property: "5", suburb: "KEEP", area: "", zoning: "R2", nature: "", purpose: "DWELLING", dealing: "", price: 950_000},
		{property: "6", suburb: "KEEP", area: "500", zoning: "R2", nature: "R", purpose: "RESIDENCE", interest: "100", dealing: "K6", price: 1_200_000},
	}
	drop := map[string]nswB{
		"business zone":             {property: "10", suburb: "DROP", area: "900", zoning: "B4", nature: "R", purpose: "RESIDENCE", dealing: "D1", price: 9_000_000},
		"mixed use zone":            {property: "11", suburb: "DROP", area: "900", zoning: "MU1", nature: "R", purpose: "RESIDENCE", dealing: "D2", price: 9_000_000},
		"special purpose zone":      {property: "12", suburb: "DROP", area: "900", zoning: "SP2", nature: "R", purpose: "RESIDENCE", dealing: "D3", price: 9_000_000},
		"industrial zone":           {property: "13", suburb: "DROP", area: "900", zoning: "IN1", nature: "R", purpose: "RESIDENCE", dealing: "D4", price: 9_000_000},
		"whole building (nature 3)": {property: "14", suburb: "DROP", area: "1800", zoning: "R4", nature: "3", purpose: "RESIDENCE", dealing: "D5", price: 40_000_000},
		"R4 development site":       {property: "15", suburb: "DROP", area: "2500", zoning: "R4", nature: "R", purpose: "RESIDENCE", dealing: "D6", price: 12_000_000},
		"R3 site in hectares":       {property: "16", suburb: "DROP", area: "0.3", areaUnit: "H", zoning: "R3", nature: "R", purpose: "RESIDENCE", dealing: "D7", price: 8_000_000},
		"multi-dwelling purpose":    {property: "17", suburb: "DROP", area: "900", zoning: "R2", nature: "R", purpose: "MULTI DWELLING HOUSING", dealing: "D8", price: 5_000_000},
		"shop-top housing":          {property: "18", suburb: "DROP", area: "300", zoning: "R2", nature: "R", purpose: "RESIDENCE & SHOP", dealing: "D9", price: 3_000_000},
		"part interest":             {property: "19", suburb: "DROP", area: "500", zoning: "R2", nature: "R", purpose: "RESIDENCE", interest: "50", dealing: "D10", price: 600_000},
		"vacant land":               {property: "20", suburb: "DROP", area: "500", zoning: "R2", nature: "V", purpose: "RESIDENCE", dealing: "D11", price: 600_000},
	}
	for name, r := range drop {
		if sales := parseNSWDAT([]byte(datOf(r))); len(sales) != 0 {
			t.Errorf("%s must be excluded, kept %+v", name, sales)
		}
	}
	if got := parseNSWDAT([]byte(datOf(keep...))); len(got) != len(keep) {
		t.Fatalf("every ordinary house sale must be kept: want %d, got %d (%+v)", len(keep), len(got), got)
	}
}

func TestNSWRelodgedRecordCountsOnce(t *testing.T) {
	sale := house("1", "BONDI", 4_600_000, "AT5")
	got := parseNSWDAT([]byte(datOf(sale, sale, house("2", "BONDI", 3_000_000, "AT6"))))
	if len(got) != 2 {
		t.Fatalf("the same property and dealing lodged twice is one sale, not a two-property bundle: %+v", got)
	}
}

// A contract's records can be lodged in different weekly files; the year-level
// pass has to see them together, or each file would hold one "single" sale.
func TestNSWYearSelectionSeesAContractAcrossWeeklyFiles(t *testing.T) {
	week1 := datOf(house("1", "ST LEONARDS", 110_500_000, "AT999"), house("5", "ST LEONARDS", 2_000_000, "AT1"))
	week2 := datOf(house("2", "ST LEONARDS", 110_500_000, "AT999"))

	var outer bytes.Buffer
	ow := zip.NewWriter(&outer)
	for i, dat := range []string{week1, week2} {
		var inner bytes.Buffer
		iw := zip.NewWriter(&inner)
		w, _ := iw.Create("001.DAT")
		_, _ = w.Write([]byte(dat))
		_ = iw.Close()
		ww, _ := ow.Create(fmt.Sprintf("week%d.zip", i))
		_, _ = ww.Write(inner.Bytes())
	}
	if err := ow.Close(); err != nil {
		t.Fatal(err)
	}
	sales, err := parseNSWYearSales(outer.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(sales) != 1 || sales[0].price != 2_000_000 {
		t.Fatalf("a contract split across weeks must still be dropped whole, got %+v", sales)
	}
}

func TestNSWZoneHasPrefixMatchesCodesNotWords(t *testing.T) {
	cases := map[[2]string]bool{
		{"B4", "B"}: true, {"SP2", "SP"}: true, {"MU1", "MU"}: true, {"IN1", "IN"}: true,
		{"R2", "B"}: false, {"RU5", "R"}: false, {"B", "B"}: false, {"BUSINESS", "B"}: false,
	}
	for c, want := range cases {
		if got := nswZoneHasPrefix(c[0], c[1]); got != want {
			t.Errorf("nswZoneHasPrefix(%q, %q) = %v, want %v", c[0], c[1], got, want)
		}
	}
}
