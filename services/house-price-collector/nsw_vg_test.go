package main

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

type fakeNSWFetcher struct {
	responses map[string][]byte
	errors    map[string]error
}

func (f fakeNSWFetcher) FetchBytes(_ context.Context, pageURL, _ string) ([]byte, string, error) {
	if err := f.errors[pageURL]; err != nil {
		return nil, "", err
	}
	return f.responses[pageURL], nswAccept, nil
}

func nswYearZIPFixture(t *testing.T, dat string) []byte {
	t.Helper()
	var inner bytes.Buffer
	innerWriter := zip.NewWriter(&inner)
	datWriter, err := innerWriter.Create("sales.DAT")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := datWriter.Write([]byte(dat)); err != nil {
		t.Fatal(err)
	}
	if err := innerWriter.Close(); err != nil {
		t.Fatal(err)
	}

	var outer bytes.Buffer
	outerWriter := zip.NewWriter(&outer)
	weekWriter, err := outerWriter.Create("week.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := weekWriter.Write(inner.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := outerWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return outer.Bytes()
}

func nswOuterZIPFixture(t *testing.T, name string, body []byte) []byte {
	t.Helper()
	var outer bytes.Buffer
	writer := zip.NewWriter(&outer)
	member, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := member.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return outer.Bytes()
}

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

func TestIngestNSWSuburbMediansRejectsPartialYearCoverage(t *testing.T) {
	years := []int{2023, 2024, 2025}
	valid := nswYearZIPFixture(t, nswDATFixture)
	fetcher := fakeNSWFetcher{
		responses: map[string][]byte{
			fmt.Sprintf("%s%d.zip", nswPSIBase, 2023): valid,
			fmt.Sprintf("%s%d.zip", nswPSIBase, 2025): []byte("Cloudflare challenge"),
		},
		errors: map[string]error{
			fmt.Sprintf("%s%d.zip", nswPSIBase, 2024): errors.New("blocked"),
		},
	}

	obs, err := ingestNSWSuburbMediansWithFetcher(context.Background(), fetcher, years)
	if err == nil {
		t.Fatalf("partial coverage returned %d observations without an error", len(obs))
	}
	for _, want := range []string{"incomplete NSW PSI coverage", "1/3", "2024", "2025"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
}

func TestBuildNSWObservationsStampsPooledMedianAtLatestFetchedYear(t *testing.T) {
	agg := map[string]map[int]*nswAgg{
		"THINVILLE": {
			2023: {prices: []float64{600000, 610000, 620000}, postcodes: map[string]int{"2000": 3}},
			2024: {prices: []float64{630000, 640000, 650000}, postcodes: map[string]int{"2000": 3}},
		},
	}

	obs := buildNSWObservations(agg, []int{2023, 2024})
	if len(obs) != 1 {
		t.Fatalf("observations = %d, want one pooled median: %+v", len(obs), obs)
	}
	if got := obs[0].Period.Year(); got != 2024 {
		t.Fatalf("pooled period year = %d, want latest fetched year 2024", got)
	}
	if !obs[0].IsPreliminary {
		t.Fatal("pooled median must remain preliminary")
	}
}

func TestParseNSWYearSalesRejectsMissingOrCorruptWeeklyData(t *testing.T) {
	var emptyInner bytes.Buffer
	innerWriter := zip.NewWriter(&emptyInner)
	readme, err := innerWriter.Create("readme.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readme.Write([]byte("no DAT here")); err != nil {
		t.Fatal(err)
	}
	if err := innerWriter.Close(); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name string
		body []byte
	}{
		{name: "no weekly archives", body: nswOuterZIPFixture(t, "readme.txt", []byte("metadata"))},
		{name: "corrupt weekly archive", body: nswOuterZIPFixture(t, "week.zip", []byte("not a zip"))},
		{name: "weekly archive without DAT", body: nswOuterZIPFixture(t, "week.zip", emptyInner.Bytes())},
		{name: "DAT without qualifying sales", body: nswYearZIPFixture(t, "garbage;not;a;sale")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseNSWYearSales(tc.body); err == nil {
				t.Fatal("expected structurally incomplete year to fail parsing")
			}
		})
	}
}
