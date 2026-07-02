package main

import "testing"

// A .DAT sample covering the cases the filter must handle. Fields are ";"-delimited;
// [9]=suburb [10]=postcode [15]=price [18]=purpose [19]=strata-lot.
const nswDATFixture = `A;001;20240101;...
B;001;2857799;1;20240101 01:07;;;176;LAKE RD;ELRINGTON;2325;25.15;H;20231219;20231222;1330000;RU2;R;RESIDENCE;;RAN;;0;AT729586;
B;001;2857800;1;20240101 01:07;;;10;OCEAN ST;BONDI;2026;0;M;20231220;20231223;4600000;R2;R;RESIDENCE;;RAN;;0;AT729587;
B;001;2857801;1;20240101 01:07;;;5/10;HIGH ST;BONDI;2026;0;M;20231220;20231223;900000;R3;3;RESIDENCE;5;RAN;;0;AT729588;
B;001;2857802;1;20240101 01:07;;;;FARM RD;DUBBO;2830;120;H;20231221;20231224;250000;RU1;V;VACANT LAND;;RAN;;0;AT729589;
B;001;2857803;1;20240101 01:07;;;12;MAIN ST;ORANGE;2800;0;M;20231221;20231224;1;R2;R;RESIDENCE;;RAN;;0;AT729590;
C;001;legal desc row should be ignored
`

func TestParseNSWDAT(t *testing.T) {
	sales := parseNSWDAT([]byte(nswDATFixture))
	// Kept: ELRINGTON house, BONDI house. Dropped: BONDI strata (unit), DUBBO vacant
	// land, ORANGE $1 nominal transfer, and non-B rows.
	if len(sales) != 2 {
		t.Fatalf("want 2 house sales, got %d: %+v", len(sales), sales)
	}
	got := map[string]float64{}
	for _, s := range sales {
		got[s.suburb] = s.price
	}
	if got["ELRINGTON"] != 1330000 || got["BONDI"] != 4600000 {
		t.Fatalf("unexpected sales: %+v", got)
	}
	for _, s := range sales {
		if s.suburb == "BONDI" && s.postcode != "2026" {
			t.Fatalf("postcode not captured: %+v", s)
		}
	}
}

func TestMedianFloat(t *testing.T) {
	if got := medianFloat([]float64{3, 1, 2}); got != 2 {
		t.Fatalf("odd median = %v, want 2", got)
	}
	if got := medianFloat([]float64{4, 1, 3, 2}); got != 2.5 {
		t.Fatalf("even median = %v, want 2.5", got)
	}
	if got := medianFloat(nil); got != 0 {
		t.Fatalf("empty median = %v, want 0", got)
	}
}

func TestModalKey(t *testing.T) {
	if got := modalKey(map[string]int{"2026": 5, "2027": 2}); got != "2026" {
		t.Fatalf("modalKey = %q, want 2026", got)
	}
}

func TestNSWRecentYears(t *testing.T) {
	ys := nswRecentYears(3)
	if len(ys) != 3 {
		t.Fatalf("want 3 years, got %v", ys)
	}
	if ys[2] != ys[0]+2 || ys[1] != ys[0]+1 {
		t.Fatalf("years not consecutive/ascending: %v", ys)
	}
}

func TestNSWTitleCase(t *testing.T) {
	if got := nswTitleCase("LAKE HAVEN"); got != "Lake Haven" {
		t.Fatalf("nswTitleCase = %q, want 'Lake Haven'", got)
	}
}
