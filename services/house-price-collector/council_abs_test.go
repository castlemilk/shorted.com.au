package main

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Fixtures under testdata/lga are real ABS Data API responses captured
// 2026-09-23 (UA shorted-housing/1.0), trimmed to a handful of councils that
// exercise every vintage rule: Albury 10050 (plain), Merri-bek 24700 / its
// LGA_2021 code Moreland 25250 (recode), East Arnhem 71300 and its LGA_2025
// parts 71500 + 71700 (split), Bayside (Vic.) 20910, and pseudo-areas 19499
// ('No usual address') and 29799 ('Migratory').

func fixtureIndex() lgaIndex {
	ix := lgaIndex{kind: map[string]string{}, state: map[string]string{}, name: map[string]string{}}
	for code, name := range map[string]string{
		"10050": "Albury", "24700": "Merri-bek", "71300": "East Arnhem", "20910": "Bayside (Vic.)",
		"10130": "Armidale Regional", "19499": "No usual address (NSW)", "29799": "Migratory - Offshore - Shipping (Vic.)",
	} {
		ix.kind[code], ix.name[code] = lgaKind(code, name), name
	}
	return ix
}

func readFixture(t *testing.T, name string) [][]string {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "lga", name))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	recs, err := r.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	return recs
}

func obsBy(obs []lgaObs, region, dim, period string) (float64, bool) {
	for _, o := range obs {
		if o.region == region && o.dim == dim && o.period == period {
			return o.value, true
		}
	}
	return 0, false
}

func seriesBy(rows []LGASeriesRow, code, measure, label string) (LGASeriesRow, bool) {
	for _, r := range rows {
		if r.LGACode == code && r.Measure == measure && r.PeriodLabel == label {
			return r, true
		}
	}
	return LGASeriesRow{}, false
}

func TestToLGA24Vintages(t *testing.T) {
	ix := fixtureIndex()
	obs, err := parseLGAObs(readFixture(t, "erp_all.csv"), "REGION", "MEASURE")
	if err != nil {
		t.Fatal(err)
	}
	mapped, m := toLGA24(obs, ix, true)
	// East Arnhem 2025 = 71500 East Arnhem 8,130 + 71700 Groote Archipelago 2,095.
	if v, ok := obsBy(mapped, "71300", "ERP", "2025"); !ok || v != 8130+2095 {
		t.Errorf("East Arnhem 2025 = %v %v, want the two LGA_2025 parts summed (10225)", v, ok)
	}
	if v, _ := obsBy(mapped, "10050", "ERP", "2025"); v != 59538 {
		t.Errorf("Albury 2025 = %v, want 59538", v)
	}
	if len(m.unknown) != 0 || m.incomplete != 0 {
		t.Errorf("mapping = %s", m.summary())
	}

	// A median is not additive: a split part is dropped, never summed.
	_, m = toLGA24([]lgaObs{{"71500", "HOUSES_3", "2025", 500000}, {"71700", "HOUSES_3", "2025", 300000}}, ix, false)
	if m.splitDrop != 2 {
		t.Errorf("median split parts dropped = %d, want 2", m.splitDrop)
	}

	// Half a split never reads as a population fall; a duplicated row of one
	// part is not the other part.
	for _, half := range [][]lgaObs{
		{{"71500", "ERP", "2026", 8200}},
		{{"71500", "ERP", "2026", 8200}, {"71500", "ERP", "2026", 8200}},
	} {
		got, m := toLGA24(half, ix, true)
		if len(got) != 0 || m.incomplete != 1 {
			t.Errorf("incomplete split: got %v, %s", got, m.summary())
		}
	}

	// Moreland's LGA_2021 code is Merri-bek; pseudo-areas are dropped by
	// design; a code the dimension lacks is reported, not guessed.
	got, m := toLGA24([]lgaObs{
		{"25250", "1", "2021", 35}, {"19499", "1", "2021", 40}, {"99999", "1", "2021", 50},
	}, ix, false)
	if len(got) != 1 || got[0].region != "24700" {
		t.Errorf("recode: %v", got)
	}
	if m.pseudo != 1 || !m.unknown["99999"] {
		t.Errorf("mapping = %s", m.summary())
	}
}

func TestBuildERP(t *testing.T) {
	ix := fixtureIndex()
	erp, _ := parseLGAObs(readFixture(t, "erp_all.csv"), "REGION", "MEASURE")
	comp, _ := parseLGAObs(readFixture(t, "comp_all.csv"), "REGION", "POP_COMP")
	erp, _ = toLGA24(erp, ix, true)
	comp, _ = toLGA24(comp, ix, true)
	series, pops := buildERP(erp, comp)

	byCode := map[string]LGAPopulation{}
	for _, p := range pops {
		byCode[p.LGACode] = p
	}
	albury := byCode["10050"]
	if albury.Population != 59538 || albury.Year != 2025 || albury.PopGrowthPct == nil || *albury.PopGrowthPct != 1.31 {
		t.Errorf("Albury = %+v (growth %v), want 59538 at 2025, +1.31%% on 58,768", albury, albury.PopGrowthPct)
	}
	if byCode["71300"].Population != 10225 {
		t.Errorf("East Arnhem = %+v, want the split parts summed", byCode["71300"])
	}
	if _, ok := byCode["24700"]; !ok {
		t.Error("Merri-bek has no ERP")
	}

	r, ok := seriesBy(series, "10050", "erp", "2025")
	if !ok || !r.Period.Equal(june30(2025)) || r.Source != erpSource || r.Unit != "persons" || r.Licence != "CC-BY-4.0" {
		t.Errorf("Albury ERP row = %+v", r)
	}
	// Components are flows over the year ENDED 30 June: labelled as the FY.
	for _, measure := range []string{"natural_increase", "net_internal_migration", "net_overseas_migration"} {
		r, ok := seriesBy(series, "10050", measure, "2024-25")
		if !ok || !r.Period.Equal(june30(2025)) || r.Source != erpCompSource {
			t.Errorf("Albury %s 2024-25 = %+v %v", measure, r, ok)
		}
	}
	if r, _ := seriesBy(series, "10050", "net_internal_migration", "2024-25"); r.Value != 335 {
		t.Errorf("Albury net internal migration 2024-25 = %v, want 335", r.Value)
	}

	// A single year gives a population and no growth, never a 0% growth.
	_, pops = buildERP([]lgaObs{{"10050", "ERP", "2025", 100}}, nil)
	if pops[0].PopGrowthPct != nil {
		t.Errorf("growth without a prior year = %v, want nil", *pops[0].PopGrowthPct)
	}
}

func TestBuildLGACensus(t *testing.T) {
	ix := fixtureIndex()
	parse := func(file, region, dim string) []lgaObs {
		obs, err := parseLGAObs(readFixture(t, file), region, dim)
		if err != nil {
			t.Fatal(err)
		}
		mapped, _ := toLGA24(obs, ix, false)
		return mapped
	}
	rows := buildLGACensus(
		parse("g02.csv", "REGION", "MEDAVG"),
		parse("g37.csv", "REGION", "TENLLD"),
		parse("seifa.csv", "LGA_2021", "SEIFAINDEXTYPE"),
	)
	byCode := map[string]LGACensus{}
	for _, r := range rows {
		byCode[r.LGACode] = r
		if r.LGACode == "19499" {
			t.Error("a pseudo-area got Census facts")
		}
	}
	a := byCode["10050"]
	if a.MedianAge == nil || *a.MedianAge != 39 || *a.MedianHhdIncome != 1430 || *a.MedianWeeklyRent != 270 ||
		*a.MedianMortgageMonthly != 1473 || *a.AvgHouseholdSize != 2.3 {
		t.Errorf("Albury medians = %+v", a)
	}
	// 7,489 renting of 22,182 households.
	if a.PctRented == nil || *a.PctRented != 33.8 {
		t.Errorf("Albury pct_rented = %v, want 33.8", a.PctRented)
	}
	if a.SeifaIRSADDecile == nil || *a.SeifaIRSADDecile != 5 || *a.SeifaIRSDDecile != 5 {
		t.Errorf("Albury SEIFA = %+v", a)
	}
	if m := byCode["24700"]; m.MedianAge == nil || m.SeifaIRSADDecile == nil {
		t.Errorf("Merri-bek (Moreland 25250 in LGA_2021) = %+v", m)
	}
}

func TestBuildRegionalIsFinancialYear(t *testing.T) {
	ix := fixtureIndex()
	obs, err := parseLGAObs(readFixture(t, "dbr.csv"), "LGA_2021", "MEASURE")
	if err != nil {
		t.Fatal(err)
	}
	mapped, _ := toLGA24(obs, ix, false)
	rows := buildRegional(mapped)
	// 'year ended 30 June': TIME_PERIOD 2024 is FY 2023-24, dated 30 June 2024.
	r, ok := seriesBy(rows, "10050", "attached_median_price", "2023-24")
	if !ok || r.Value != 330000 || !r.Period.Equal(june30(2024)) || r.Unit != "AUD" || r.Source != regionalSource {
		t.Errorf("Albury attached median 2023-24 = %+v %v", r, ok)
	}
	if _, ok := seriesBy(rows, "24700", "dwelling_approvals_fy", "2023-24"); !ok {
		t.Error("Moreland's approvals did not land on Merri-bek")
	}
}

func TestBuildBuildingApprovals(t *testing.T) {
	ix := fixtureIndex()
	var all []lgaObs
	for _, f := range []string{"ba2023.csv", "ba2026.csv"} {
		obs, err := parseLGAObs(readFixture(t, f), "REGION", "BUILDING_TYPE")
		if err != nil {
			t.Fatal(err)
		}
		mapped, m := toLGA24(obs, ix, true)
		if len(m.unknown) != 0 {
			t.Errorf("%s: %s", f, m.summary())
		}
		all = append(all, mapped...)
	}
	rows := buildBuildingApprovals(all)
	r, ok := seriesBy(rows, "10050", "dwelling_approvals_houses", "2026-07")
	if !ok || r.Value != 34 || !r.Period.Equal(time.Date(2026, time.July, 31, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("Albury houses 2026-07 = %+v %v", r, ok)
	}
	// East Arnhem's 2026-07 total is the sum of its LGA_2025 parts.
	if r, ok := seriesBy(rows, "71300", "dwelling_approvals_total", "2026-07"); !ok || r.Value < 0 {
		t.Errorf("East Arnhem total 2026-07 = %+v %v", r, ok)
	}
	for _, r := range rows {
		if r.LGACode == "29799" {
			t.Error("a pseudo-area got approvals")
		}
	}
}

func TestBAFlowYears(t *testing.T) {
	now := time.Date(2026, time.September, 23, 0, 0, 0, 0, time.UTC)
	if got := baFlowYears(now, nil); len(got) != 6 || got[0] != 2021 || got[5] != 2026 {
		t.Errorf("cold run = %v, want 2021..2026", got)
	}
	cursor := time.Date(2026, time.July, 31, 0, 0, 0, 0, time.UTC)
	if got := baFlowYears(now, &cursor); len(got) != 2 || got[0] != 2025 || got[1] != 2026 {
		t.Errorf("warm run = %v, want the cursor's FY minus one (2025) and the current (2026)", got)
	}
	june := time.Date(2026, time.June, 30, 0, 0, 0, 0, time.UTC)
	if currentFYStart(june) != 2025 || currentFYStart(cursor) != 2026 {
		t.Error("financial year boundary is 1 July")
	}
}

// serveFixtures answers the ABS SDMX path for each flow with a fixture file,
// and 404s any flow it does not know — the way ABS answers an unpublished one.
func serveFixtures(t *testing.T, files map[string]string) *absdata.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for flow, file := range files {
			// A flow is referenced as ABS,<flow>,<version> or, unversioned,
			// ABS,<flow>/<key>.
			if strings.Contains(r.URL.Path, "/ABS,"+flow+",") || strings.Contains(r.URL.Path, "/ABS,"+flow+"/") {
				http.ServeFile(w, r, filepath.Join("testdata", "lga", file))
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("Could not find Dataflow and/or DSD related with this data request"))
	}))
	t.Cleanup(srv.Close)
	return absdata.NewClient().WithBaseURL(srv.URL)
}

func withMinCouncils(t *testing.T, n int) {
	t.Helper()
	prev := lgaMinCouncils
	lgaMinCouncils = n
	t.Cleanup(func() { lgaMinCouncils = prev })
}

func TestIngestCouncilModesThroughTheClient(t *testing.T) {
	ix := fixtureIndex()
	client := serveFixtures(t, map[string]string{
		"ERP_LGA2025": "erp_all.csv", "ERP_COMP_LGA2025": "comp_all.csv",
		"C21_G02_LGA": "g02.csv", "C21_G37_LGA": "g37.csv", "ABS_SEIFA2021_LGA": "seifa.csv",
		"ABS_REGIONAL_LGA2021": "dbr.csv", "BA_LGA2022": "ba2023.csv", "BA_LGA2025": "ba2025.csv",
		"BA_LGA2026": "ba2026.csv",
	})
	ctx := context.Background()

	// The floor refuses a pull that covers too few councils: a broken key or
	// mapping must fail loudly, not write a sliver of the country.
	sept2026 := time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC)
	if _, _, err := ingestERPLGA(ctx, client, ix, sept2026); err == nil || !strings.Contains(err.Error(), "only") {
		t.Errorf("ERP under the floor: err = %v", err)
	}

	withMinCouncils(t, 3)
	// ERP_LGA2026 404s (not published yet), so discovery settles on 2025.
	if _, pops, err := ingestERPLGA(ctx, client, ix, sept2026); err != nil || len(pops) != 4 {
		t.Errorf("erp-lga: %d councils, err %v", len(pops), err)
	}
	if rows, err := ingestCensusLGA(ctx, client, ix); err != nil || len(rows) < 3 {
		t.Errorf("census-lga: %d rows, err %v", len(rows), err)
	}
	if rows, err := ingestCouncilRegional(ctx, client, ix); err != nil || len(rows) == 0 {
		t.Errorf("council-regional: %d rows, err %v", len(rows), err)
	}

	// BA_LGA2022, 2025 and 2026 are served; 2023 and 2024 are not. A missing
	// past year is a failure; a missing CURRENT year is "not published yet".
	now := time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC)
	cursor := time.Date(2023, time.June, 30, 0, 0, 0, 0, time.UTC) // → FY 2022..2026
	if _, err := ingestBuildingApprovalsLGA(ctx, client, ix, now, &cursor); err == nil {
		t.Error("a missing past-year flow must fail the run")
	}
	cursor = time.Date(2026, time.July, 31, 0, 0, 0, 0, time.UTC) // → FY 2025..2026
	rows, err := ingestBuildingApprovalsLGA(ctx, client, ix, now, &cursor)
	if err != nil {
		t.Fatalf("building-approvals-lga: %v", err)
	}
	if last := latestSeriesPeriod(rows); last == nil || last.Format("2006-01") != "2026-07" {
		t.Errorf("latest month = %v, want 2026-07", last)
	}
	later := time.Date(2027, time.July, 20, 0, 0, 0, 0, time.UTC) // FY 2027's flow not out yet
	cursor = time.Date(2027, time.June, 30, 0, 0, 0, 0, time.UTC) // → FY 2026..2027
	if rows, err := ingestBuildingApprovalsLGA(ctx, client, ix, later, &cursor); err != nil || len(rows) == 0 {
		t.Errorf("an unpublished current-FY flow must be skipped: %d rows, err %v", len(rows), err)
	}
}

// ABS publishes a new ERP flow per release year. The scheduled job must pick
// up the newest one on its own, with the region-type key that flow uses —
// a pinned flow would re-read the same frozen year until the freshness alarm
// failed every monthly run.
func TestLatestERPFlowRollsForward(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		switch {
		case strings.Contains(r.URL.Path, "/ABS,ERP_GONE"):
			w.WriteHeader(http.StatusNotFound)
		case strings.Contains(r.URL.Path, "/ABS,ERP_LGA2027/"), strings.Contains(r.URL.Path, "/ABS,ERP_COMP_LGA2027/"),
			strings.Contains(r.URL.Path, "/ABS,ERP_COMP_LGA2026/"):
			w.WriteHeader(http.StatusNotFound)
		case strings.Contains(r.URL.Path, "/ABS,ERP_LGA2026/ERP.LGA2026..A"),
			strings.Contains(r.URL.Path, "/ABS,ERP_COMP_LGA2025/3+6+9.LGA2025..A"):
			_, _ = w.Write([]byte("REGION,MEASURE,TIME_PERIOD,OBS_VALUE\n10050: Albury,ERP,2026,1\n"))
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	t.Cleanup(srv.Close)
	client := absdata.NewClient().WithBaseURL(srv.URL)
	ctx := context.Background()
	may2027 := time.Date(2027, time.May, 1, 0, 0, 0, 0, time.UTC)

	flow, year, _, err := latestERPFlow(ctx, client, erpFlowPrefix, erpKey, may2027)
	if err != nil || flow != "ERP_LGA2026" || year != 2026 {
		t.Fatalf("ERP discovery = %q %d %v, want ERP_LGA2026 (2027 not out yet)", flow, year, err)
	}
	// Components trail: 2027 and 2026 unpublished, 2025 is the newest.
	flow, _, _, err = latestERPFlow(ctx, client, erpCompFlowPrefix, erpCompKey, may2027)
	if err != nil || flow != "ERP_COMP_LGA2025" {
		t.Fatalf("component discovery = %q %v, want ERP_COMP_LGA2025", flow, err)
	}
	for _, p := range paths {
		if strings.Contains(p, ",1.0.0") {
			t.Errorf("%s pins a version; ABS versions differ per year", p)
		}
	}

	// A real failure is not "not published": it must not fall back a year.
	paths = nil
	if _, _, _, err := latestERPFlow(ctx, client, "ERP_BROKEN", erpKey, may2027); err == nil {
		t.Error("a 500 must fail discovery, not fall back to an older flow")
	}
	if len(paths) == 0 || !strings.Contains(paths[0], "ERP_BROKEN2027") {
		t.Errorf("discovery must start at the current year: %v", paths)
	}

	// Nothing at or after the checked vintage: fail, never read an older flow.
	paths = nil
	if _, _, _, err := latestERPFlow(ctx, client, "ERP_GONE", erpKey, may2027); err == nil {
		t.Error("no flow at or after erpCheckedVintage must fail")
	}
	if n := len(paths); n != 3 || !strings.Contains(paths[n-1], fmt.Sprintf("ERP_GONE%d/", erpCheckedVintage)) {
		t.Errorf("discovery must stop at erpCheckedVintage: %v", paths)
	}
}
