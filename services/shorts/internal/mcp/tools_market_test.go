package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// ---------------------------------------------------------------- list_top_shorts

func TestListTopShortsAppliesDefaultsAndRequestsSummariesOnly(t *testing.T) {
	src := &fakeDataSource{topShorts: &shortsv1alpha1.GetTopShortsResponse{
		TimeSeries: []*stocksv1alpha1.TimeSeriesData{
			{ProductCode: "PLS", Name: "PILBARA MINERALS", Industry: "Materials", LatestShortPosition: 19.4},
			{ProductCode: "IEL", Name: "IDP EDUCATION", Industry: "Consumer", LatestShortPosition: 14.1},
		},
	}}

	_, out, err := listTopShortsHandler(src)(context.Background(), nil, ListTopShortsInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if src.gotTopShorts == nil {
		t.Fatal("never reached the RPC")
	}
	// summary_only is the difference between ~2KB and ~1MB: without it the RPC
	// returns a full time series for every stock in the ranking.
	if !src.gotTopShorts.GetSummaryOnly() {
		t.Error("must request summary_only — the full response carries a time series per stock")
	}
	if src.gotTopShorts.GetLimit() != defaultTopShortsLimit {
		t.Errorf("limit = %d, want the default %d", src.gotTopShorts.GetLimit(), defaultTopShortsLimit)
	}
	if src.gotTopShorts.GetPeriod() != defaultPeriod {
		t.Errorf("period = %q, want the default %q", src.gotTopShorts.GetPeriod(), defaultPeriod)
	}

	if out.Count != 2 || len(out.Stocks) != 2 {
		t.Fatalf("expected 2 stocks, got %+v", out)
	}
	if out.Stocks[0].Code != "PLS" || out.Stocks[0].PercentShorted != 19.4 || out.Stocks[0].Industry != "Materials" {
		t.Errorf("first entry not mapped: %+v", out.Stocks[0])
	}
}

func TestListTopShortsClampsLimitToTheAdvertisedMaximum(t *testing.T) {
	src := &fakeDataSource{topShorts: &shortsv1alpha1.GetTopShortsResponse{}}

	if _, _, err := listTopShortsHandler(src)(context.Background(), nil, ListTopShortsInput{Limit: 5000}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotTopShorts.GetLimit() != maxListLimit {
		t.Errorf("limit = %d, want it clamped to %d", src.gotTopShorts.GetLimit(), maxListLimit)
	}
}

func TestListTopShortsRejectsAnUnknownPeriodWithoutCallingTheRPC(t *testing.T) {
	src := &fakeDataSource{topShorts: &shortsv1alpha1.GetTopShortsResponse{}}

	_, _, err := listTopShortsHandler(src)(context.Background(), nil, ListTopShortsInput{Period: "last tuesday"})
	if err == nil {
		t.Fatal("expected a validation error")
	}
	if !strings.Contains(err.Error(), "1M") {
		t.Errorf("the error should list the valid periods, got %q", err.Error())
	}
	if src.gotTopShorts != nil {
		t.Error("reached the RPC despite failing validation")
	}
}

func TestListTopShortsSaysSoWhenThereAreNoResults(t *testing.T) {
	src := &fakeDataSource{topShorts: &shortsv1alpha1.GetTopShortsResponse{}}

	res, out, err := listTopShortsHandler(src)(context.Background(), nil, ListTopShortsInput{})
	if err != nil {
		t.Fatalf("an empty ranking is a result, not an error: %v", err)
	}
	if out.Count != 0 || len(out.Stocks) != 0 {
		t.Errorf("expected an empty result, got %+v", out)
	}
	if !strings.Contains(strings.ToLower(textOf(t, res)), "no ") {
		t.Errorf("the text fallback should state that nothing was returned, got %q", textOf(t, res))
	}
}

func TestListTopShortsReportsANilBodyRatherThanZeroes(t *testing.T) {
	src := &fakeDataSource{topShorts: nil}

	if _, _, err := listTopShortsHandler(src)(context.Background(), nil, ListTopShortsInput{}); err == nil {
		t.Fatal("expected an error when the RPC returns no body")
	}
}

// ---------------------------------------------------------- get_industry_treemap

func TestGetIndustryTreemapProjectsAndCaps(t *testing.T) {
	stocks := make([]*stocksv1alpha1.TreemapShortPosition, 0, 300)
	for i := 0; i < 300; i++ {
		stocks = append(stocks, &stocksv1alpha1.TreemapShortPosition{
			Industry: "Materials", ProductCode: "AAA", ShortPosition: 1.5,
		})
	}
	src := &fakeDataSource{treeMap: &stocksv1alpha1.IndustryTreeMap{
		Industries: []string{"Materials", "Energy"},
		Stocks:     stocks,
	}}

	_, out, err := getIndustryTreemapHandler(src)(context.Background(), nil, GetIndustryTreemapInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.Stocks) > maxTreemapStocks {
		t.Errorf("returned %d rows, want at most %d — the cap is advertised in the description", len(out.Stocks), maxTreemapStocks)
	}
	if len(out.Industries) != 2 {
		t.Errorf("industries not mapped: %+v", out.Industries)
	}
	if src.gotTreeMap.GetViewMode() != shortsv1alpha1.ViewMode_CURRENT_CHANGE {
		t.Errorf("view mode = %v, want CURRENT_CHANGE", src.gotTreeMap.GetViewMode())
	}
}

func TestGetIndustryTreemapSurfacesBackendFailures(t *testing.T) {
	src := &fakeDataSource{err: connect.NewError(connect.CodeInternal, errors.New("boom"))}

	if _, _, err := getIndustryTreemapHandler(src)(context.Background(), nil, GetIndustryTreemapInput{}); err == nil {
		t.Fatal("expected an error when the RPC fails")
	}
}

// ---------------------------------------------------------- get_market_snapshot

func TestGetMarketSnapshotPassesTheDateThroughAndReportsNeighbours(t *testing.T) {
	src := &fakeDataSource{marketByDate: &shortsv1alpha1.GetMarketByDateResponse{
		Date:         "2026-08-01",
		TotalCount:   812,
		PreviousDate: "2026-07-31",
		NextDate:     "2026-08-04",
		Stocks: []*stocksv1alpha1.Stock{
			{ProductCode: "BHP", Name: "BHP GROUP", Industry: "Materials", PercentageShorted: 0.9,
				ReportedShortPositions: 45_000_000, TotalProductInIssue: 5_000_000_000},
		},
	}}

	_, out, err := getMarketSnapshotHandler(src)(context.Background(), nil, GetMarketSnapshotInput{Date: "2026-08-01"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotMarketByDate.GetDate() != "2026-08-01" {
		t.Errorf("date = %q, want 2026-08-01", src.gotMarketByDate.GetDate())
	}
	if out.TotalCount != 812 || out.Returned != 1 {
		t.Errorf("counts wrong: %+v", out)
	}
	// The neighbour dates are how an agent recovers from landing on a
	// non-trading day without needing a second lookup tool.
	if out.PreviousTradingDate != "2026-07-31" || out.NextTradingDate != "2026-08-04" {
		t.Errorf("neighbour dates not surfaced: %+v", out)
	}
}

func TestGetMarketSnapshotRejectsAMalformedDateWithoutCallingTheRPC(t *testing.T) {
	for _, date := range []string{"", "1 August 2026", "2026/08/01", "26-08-01"} {
		src := &fakeDataSource{marketByDate: &shortsv1alpha1.GetMarketByDateResponse{}}
		_, _, err := getMarketSnapshotHandler(src)(context.Background(), nil, GetMarketSnapshotInput{Date: date})
		if err == nil {
			t.Errorf("date %q: expected a validation error", date)
		}
		if src.gotMarketByDate != nil {
			t.Errorf("date %q: reached the RPC despite failing validation", date)
		}
	}
}

func TestGetMarketSnapshotExplainsAnEmptyDate(t *testing.T) {
	src := &fakeDataSource{marketByDate: &shortsv1alpha1.GetMarketByDateResponse{Date: "2026-08-02", PreviousDate: "2026-07-31"}}

	res, out, err := getMarketSnapshotHandler(src)(context.Background(), nil, GetMarketSnapshotInput{Date: "2026-08-02"})
	if err != nil {
		t.Fatalf("a non-trading day is a result, not an error: %v", err)
	}
	if out.Returned != 0 {
		t.Errorf("expected no stocks, got %d", out.Returned)
	}
	text := strings.ToLower(textOf(t, res))
	if !strings.Contains(text, "2026-07-31") {
		t.Errorf("an empty date should point at the nearest trading day, got %q", text)
	}
}

// ------------------------------------------------------ list_squeeze_candidates

func TestListSqueezeCandidatesMapsTheViewAndScores(t *testing.T) {
	src := &fakeDataSource{battlegrounds: &shortsv1alpha1.GetBattlegroundStocksResponse{
		TotalCount: 40,
		Stocks: []*shortsv1alpha1.BattlegroundStock{{
			StockCode: "PLS", CompanyName: "PILBARA MINERALS", Industry: "Materials",
			ShortPct: 19.4, ShortPctChange_4W: 2.1, LatestPrice: 2.35, PriceChange_1M: 8.4,
			DaysToCover: 6.2, SqueezeScore: 88.5, DivergenceScore: 71.0, MarketCap: 7_100_000_000,
		}},
	}}

	_, out, err := listSqueezeCandidatesHandler(src)(context.Background(), nil, ListSqueezeCandidatesInput{View: "divergence"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotBattlegrounds.GetView() != shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_DIVERGENCE {
		t.Errorf("view = %v, want DIVERGENCE", src.gotBattlegrounds.GetView())
	}
	if out.View != "divergence" || out.TotalCount != 40 || len(out.Stocks) != 1 {
		t.Fatalf("output not shaped: %+v", out)
	}
	got := out.Stocks[0]
	if got.Code != "PLS" || got.SqueezeScore != 88.5 || got.DivergenceScore != 71.0 || got.DaysToCover != 6.2 {
		t.Errorf("scores not mapped: %+v", got)
	}
}

func TestListSqueezeCandidatesDefaultsToTheSqueezeView(t *testing.T) {
	src := &fakeDataSource{battlegrounds: &shortsv1alpha1.GetBattlegroundStocksResponse{}}

	_, out, err := listSqueezeCandidatesHandler(src)(context.Background(), nil, ListSqueezeCandidatesInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotBattlegrounds.GetView() != shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_SQUEEZE {
		t.Errorf("view = %v, want SQUEEZE", src.gotBattlegrounds.GetView())
	}
	if out.View != "squeeze" {
		t.Errorf("output view = %q, want squeeze", out.View)
	}
}

func TestListSqueezeCandidatesRejectsAnUnknownView(t *testing.T) {
	src := &fakeDataSource{battlegrounds: &shortsv1alpha1.GetBattlegroundStocksResponse{}}

	_, _, err := listSqueezeCandidatesHandler(src)(context.Background(), nil, ListSqueezeCandidatesInput{View: "vibes"})
	if err == nil {
		t.Fatal("expected a validation error")
	}
	if src.gotBattlegrounds != nil {
		t.Error("reached the RPC despite failing validation")
	}
}

// textOf pulls the text fallback out of a tool result, failing the test if the
// tool produced none — a tool with no text content renders as raw JSON in
// clients that ignore structuredContent.
func textOf(t *testing.T, res *sdk.CallToolResult) string {
	t.Helper()
	if res == nil || len(res.Content) == 0 {
		t.Fatal("no text content returned — clients that ignore structuredContent would see nothing")
	}
	text, ok := res.Content[0].(*sdk.TextContent)
	if !ok {
		t.Fatalf("content[0] is %T, want *mcp.TextContent", res.Content[0])
	}
	return text.Text
}
