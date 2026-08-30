package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func economySeriesInfo(key string) *shortsv1alpha1.EconomicSeriesInfo {
	return &shortsv1alpha1.EconomicSeriesInfo{
		SeriesKey: key, Topic: "cpi", Metric: "cpi_index", RegionType: "national",
		RegionCode: "aus", RegionName: "Australia", Unit: "index", Frequency: "quarterly",
		Adjustment: "original", SourceKey: "abs-cpi", SourceLicence: "CC-BY-4.0",
		LatestPeriod: timestamppb.New(time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC)),
	}
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

// Every economy series is ABS or RBA data republished under CC-BY 4.0, and
// attribution is a CONDITION of that licence rather than a courtesy. A tool
// result travels without the page that would otherwise carry the credit, so the
// credit has to be inside the result — in the structured output AND in the text
// content, because a client may render only one of the two.
func TestEconomyToolsCarryTheirAttribution(t *testing.T) {
	src := &fakeDataSource{
		economicSeriesList: &shortsv1alpha1.ListEconomicSeriesResponse{
			Series: []*shortsv1alpha1.EconomicSeriesInfo{economySeriesInfo("cpi.cpi_index.aus")},
		},
		economicSeries: &shortsv1alpha1.GetEconomicSeriesResponse{
			Series: []*shortsv1alpha1.EconomicSeriesData{{
				Info: economySeriesInfo("cpi.cpi_index.aus"),
				Observations: []*shortsv1alpha1.EconomicObservation{
					{Period: timestamppb.New(time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC)), Value: 141.2},
				},
			}},
		},
	}
	ctx := context.Background()

	res, listOut, err := listEconomicSeriesHandler(src)(ctx, nil, ListEconomicSeriesInput{})
	if err != nil {
		t.Fatalf("list_economic_series: %v", err)
	}
	if listOut.Source != economyAttribution {
		t.Errorf("list_economic_series source = %q, want the CC-BY attribution", listOut.Source)
	}
	if !strings.Contains(textOf(t, res), "Australian Bureau of Statistics") {
		t.Errorf("list_economic_series text content drops the attribution: %q", textOf(t, res))
	}
	if listOut.Series[0].Licence != "CC-BY-4.0" {
		t.Errorf("per-series licence = %q, want it carried through", listOut.Series[0].Licence)
	}

	res, getOut, err := getEconomicSeriesHandler(src)(ctx, nil, GetEconomicSeriesInput{
		SeriesKeys: []string{"cpi.cpi_index.aus"},
	})
	if err != nil {
		t.Fatalf("get_economic_series: %v", err)
	}
	if getOut.Source != economyAttribution {
		t.Errorf("get_economic_series source = %q, want the CC-BY attribution", getOut.Source)
	}
	if getOut.Series[0].Info.Licence != "CC-BY-4.0" || getOut.Series[0].Info.Source != "abs-cpi" {
		t.Errorf("per-series source/licence dropped: %+v", getOut.Series[0].Info)
	}
	if !strings.Contains(textOf(t, res), "Australian Bureau of Statistics") {
		t.Errorf("get_economic_series text content drops the attribution: %q", textOf(t, res))
	}
}

// ---------------------------------------------------------------------------
// list_economic_series
// ---------------------------------------------------------------------------

func TestListEconomicSeriesPassesFiltersAndClampsLimit(t *testing.T) {
	src := &fakeDataSource{economicSeriesList: &shortsv1alpha1.ListEconomicSeriesResponse{}}

	if _, _, err := listEconomicSeriesHandler(src)(context.Background(), nil, ListEconomicSeriesInput{
		Topic: " CPI ", Metric: "CPI_Index", RegionType: "National", RegionCode: "AUS", Limit: 900,
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := src.gotEconomicSeriesList
	if got == nil {
		t.Fatal("the RPC was never called")
	}
	if got.GetTopic() != "cpi" || got.GetMetric() != "cpi_index" ||
		got.GetRegionType() != "national" || got.GetRegionCode() != "aus" {
		t.Errorf("filters not normalised to lowercase: %+v", got)
	}
	if got.GetLimit() != maxEconomySeriesListLimit {
		t.Errorf("limit = %d, want it clamped to %d", got.GetLimit(), maxEconomySeriesListLimit)
	}
}

func TestListEconomicSeriesSaysSoWhenNothingMatches(t *testing.T) {
	src := &fakeDataSource{economicSeriesList: &shortsv1alpha1.ListEconomicSeriesResponse{}}

	res, out, err := listEconomicSeriesHandler(src)(context.Background(), nil, ListEconomicSeriesInput{
		Topic: "unicorns",
	})
	if err != nil {
		t.Fatalf("an empty catalogue is an answer, not an error: %v", err)
	}
	if out.Count != 0 || len(out.Series) != 0 {
		t.Errorf("expected no series, got %d", out.Count)
	}
	if !strings.Contains(strings.ToLower(textOf(t, res)), "no economic series") {
		t.Errorf("empty result does not say so: %q", textOf(t, res))
	}
}

func TestListEconomicSeriesFailsWhenTheBackendDoes(t *testing.T) {
	src := &fakeDataSource{err: errors.New("boom")}
	if _, _, err := listEconomicSeriesHandler(src)(context.Background(), nil,
		ListEconomicSeriesInput{}); err == nil {
		t.Fatal("expected an error")
	}
}

func TestListEconomicSeriesErrorsOnANilBody(t *testing.T) {
	src := &fakeDataSource{}
	if _, _, err := listEconomicSeriesHandler(src)(context.Background(), nil,
		ListEconomicSeriesInput{}); err == nil {
		t.Fatal("a nil response body must be an error, not an empty catalogue")
	}
}

// ---------------------------------------------------------------------------
// get_economic_series
// ---------------------------------------------------------------------------

func TestGetEconomicSeriesRequiresKeysAndPointsAtTheDiscoveryTool(t *testing.T) {
	src := &fakeDataSource{}
	_, _, err := getEconomicSeriesHandler(src)(context.Background(), nil, GetEconomicSeriesInput{})
	if err == nil {
		t.Fatal("expected an error for missing series_keys")
	}
	if !strings.Contains(err.Error(), "list_economic_series") {
		t.Errorf("error does not name the discovery tool: %v", err)
	}
	if src.gotEconomicSeries != nil {
		t.Error("the RPC was called despite invalid input")
	}
}

func TestGetEconomicSeriesClampsTheKeyCount(t *testing.T) {
	src := &fakeDataSource{economicSeries: &shortsv1alpha1.GetEconomicSeriesResponse{}}
	keys := []string{"a.b.aus", "c.d.aus", "e.f.aus", "g.h.aus", "i.j.aus"}

	_, out, err := getEconomicSeriesHandler(src)(context.Background(), nil,
		GetEconomicSeriesInput{SeriesKeys: keys})
	if err != nil {
		t.Fatalf("over-asking should be clamped, not rejected: %v", err)
	}
	if n := len(src.gotEconomicSeries.GetSeriesKeys()); n != maxEconomySeriesPerCall {
		t.Errorf("sent %d keys, want %d", n, maxEconomySeriesPerCall)
	}
	if !strings.Contains(out.Note, "3") {
		t.Errorf("the note does not report the clamp: %q", out.Note)
	}
}

func TestGetEconomicSeriesReportsKeysThatDoNotExist(t *testing.T) {
	src := &fakeDataSource{economicSeries: &shortsv1alpha1.GetEconomicSeriesResponse{
		Series: []*shortsv1alpha1.EconomicSeriesData{{Info: economySeriesInfo("cpi.cpi_index.aus")}},
	}}

	_, out, err := getEconomicSeriesHandler(src)(context.Background(), nil, GetEconomicSeriesInput{
		SeriesKeys: []string{"cpi.cpi_index.aus", "nope.not_real.aus"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.Missing) != 1 || out.Missing[0] != "nope.not_real.aus" {
		t.Errorf("missing keys = %v, want the unknown key reported rather than silently dropped", out.Missing)
	}
}

func TestGetEconomicSeriesDownsamplesLongRuns(t *testing.T) {
	obs := make([]*shortsv1alpha1.EconomicObservation, 0, 600)
	base := time.Date(1976, 1, 31, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 600; i++ {
		obs = append(obs, &shortsv1alpha1.EconomicObservation{
			Period: timestamppb.New(base.AddDate(0, i, 0)), Value: float64(i) + 0.123456,
		})
	}
	src := &fakeDataSource{economicSeries: &shortsv1alpha1.GetEconomicSeriesResponse{
		Series: []*shortsv1alpha1.EconomicSeriesData{{
			Info: economySeriesInfo("cpi.cpi_index.aus"), Observations: obs,
		}},
	}}

	_, out, err := getEconomicSeriesHandler(src)(context.Background(), nil, GetEconomicSeriesInput{
		SeriesKeys: []string{"cpi.cpi_index.aus"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := out.Series[0]
	if got.Count > maxEconomyPointsPerSeries {
		t.Errorf("kept %d points, over the %d cap", got.Count, maxEconomyPointsPerSeries)
	}
	// The last observation is the one a reader cares about most.
	if last := got.Points[got.Count-1]; last.Period != "2025-12-31" {
		t.Errorf("last point = %q, want the final observation retained", last.Period)
	}
	if !strings.Contains(out.Note, "600") {
		t.Errorf("the note does not report the downsample: %q", out.Note)
	}
}

func TestGetEconomicSeriesErrorsOnANilBody(t *testing.T) {
	src := &fakeDataSource{}
	if _, _, err := getEconomicSeriesHandler(src)(context.Background(), nil,
		GetEconomicSeriesInput{SeriesKeys: []string{"cpi.cpi_index.aus"}}); err == nil {
		t.Fatal("a nil response body must be an error")
	}
}

// ---------------------------------------------------------------------------
// get_state_company_aggregates
// ---------------------------------------------------------------------------

func TestGetStateCompanyAggregatesProjectsEveryState(t *testing.T) {
	src := &fakeDataSource{stateCompanyAggregates: &shortsv1alpha1.GetStateCompanyAggregatesResponse{
		Aggregates: []*shortsv1alpha1.StateCompanyAggregate{
			{State: "nsw", CompanyCount: 112, ExposureWeightedMarketCap: 8.12345e11,
				ExposureWeightedShortPercent: 2.34567},
			{State: "wa", CompanyCount: 61, ExposureWeightedMarketCap: 4.2e11,
				ExposureWeightedShortPercent: 3.1},
		},
	}}

	res, out, err := getStateCompanyAggregatesHandler(src)(context.Background(), nil,
		GetStateCompanyAggregatesInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 2 {
		t.Fatalf("count = %d, want 2", out.Count)
	}
	if out.States[0].State != "NSW" {
		t.Errorf("state = %q, want it upper-cased for display", out.States[0].State)
	}
	if got := out.States[0].ExposureWeightedShortPercent; got != 2.35 {
		t.Errorf("short percent = %v, want it rounded to 2.35", got)
	}
	// The derivation must travel with the number: this is not an official
	// statistical-agency measure of state economic output.
	if !strings.Contains(out.Note, "not an official") {
		t.Errorf("note does not disclaim the derivation: %q", out.Note)
	}
	if !strings.Contains(textOf(t, res), "ASIC") {
		t.Errorf("text content drops the ASIC provenance: %q", textOf(t, res))
	}
}

func TestGetStateCompanyAggregatesSaysSoWhenEmpty(t *testing.T) {
	src := &fakeDataSource{stateCompanyAggregates: &shortsv1alpha1.GetStateCompanyAggregatesResponse{}}
	res, out, err := getStateCompanyAggregatesHandler(src)(context.Background(), nil,
		GetStateCompanyAggregatesInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 0 {
		t.Fatalf("count = %d, want 0", out.Count)
	}
	if !strings.Contains(strings.ToLower(textOf(t, res)), "no state") {
		t.Errorf("empty result does not say so: %q", textOf(t, res))
	}
}

func TestGetStateCompanyAggregatesErrorsOnANilBody(t *testing.T) {
	src := &fakeDataSource{}
	if _, _, err := getStateCompanyAggregatesHandler(src)(context.Background(), nil,
		GetStateCompanyAggregatesInput{}); err == nil {
		t.Fatal("a nil response body must be an error")
	}
}

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

func TestEconomyToolsAreRegisteredAgainstTheirRPCs(t *testing.T) {
	want := map[string]string{
		"list_economic_series":         "shorts.v1alpha1.EconomyService.ListEconomicSeries",
		"get_economic_series":          "shorts.v1alpha1.EconomyService.GetEconomicSeries",
		"get_state_company_aggregates": "shorts.v1alpha1.EconomyService.GetStateCompanyAggregates",
	}
	got := map[string]string{}
	for _, tool := range Registry() {
		if tool.Domain == "economy" {
			got[tool.Name] = tool.RPC
		}
	}
	if len(got) != len(want) {
		t.Fatalf("registered economy tools = %v, want %v", got, want)
	}
	for name, rpc := range want {
		if got[name] != rpc {
			t.Errorf("%s declares RPC %q, want %q", name, got[name], rpc)
		}
	}
}

// The discovery pair must name each other, or a model has no path from "what
// series exist" to "give me that series" but guessing.
func TestEconomySeriesToolsCrossReference(t *testing.T) {
	for _, tool := range Registry() {
		switch tool.Name {
		case "list_economic_series":
			if !strings.Contains(tool.Description, "get_economic_series") {
				t.Error("list_economic_series does not point at get_economic_series")
			}
		case "get_economic_series":
			if !strings.Contains(tool.Description, "list_economic_series") {
				t.Error("get_economic_series does not point at list_economic_series")
			}
		}
	}
}
