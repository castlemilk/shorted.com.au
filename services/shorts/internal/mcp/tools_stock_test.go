package mcp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// ------------------------------------------------------------------- get_stock

func TestGetStockPassesUppercasedCodeThrough(t *testing.T) {
	src := &fakeDataSource{stock: &stocksv1alpha1.Stock{
		ProductCode:            "BHP",
		Name:                   "BHP GROUP LIMITED",
		Industry:               "Materials",
		PercentageShorted:      1.25,
		ReportedShortPositions: 63_000_000,
		TotalProductInIssue:    5_040_000_000,
	}}

	res, out, err := getStockHandler(src)(context.Background(), nil, GetStockInput{Code: "  bhp "})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The handler must normalise: the store keys on upper-case codes, and an
	// agent will pass whatever the user typed.
	if src.gotStock.GetProductCode() != "BHP" {
		t.Errorf("passed product code %q to the RPC, want %q", src.gotStock.GetProductCode(), "BHP")
	}

	if out.Code != "BHP" || out.Name != "BHP GROUP LIMITED" || out.Industry != "Materials" {
		t.Errorf("identity fields not mapped: %+v", out)
	}
	if out.PercentShorted != 1.25 {
		t.Errorf("percent_shorted = %v, want 1.25", out.PercentShorted)
	}
	if out.ReportedShortPositions != 63_000_000 || out.TotalProductInIssue != 5_040_000_000 {
		t.Errorf("share counts not mapped: %+v", out)
	}

	// The text fallback is what non-structured clients render; assert it exists
	// and carries the delay caveat rather than being raw JSON.
	text := textOf(t, res)
	if !strings.Contains(text, "BHP") || !strings.Contains(text, "T+4") {
		t.Errorf("text fallback should name the stock and the ASIC delay, got %q", text)
	}
}

func TestGetStockRejectsMalformedCodeWithoutCallingTheRPC(t *testing.T) {
	for _, code := range []string{"", "B", "TOOLONG", "BH-P"} {
		src := &fakeDataSource{stock: &stocksv1alpha1.Stock{}}
		_, _, err := getStockHandler(src)(context.Background(), nil, GetStockInput{Code: code})
		if err == nil {
			t.Errorf("code %q: expected a validation error", code)
		}
		if src.gotStock != nil {
			t.Errorf("code %q: reached the RPC despite failing validation", code)
		}
	}
}

func TestGetStockTurnsNotFoundIntoAnActionableMessage(t *testing.T) {
	src := &fakeDataSource{err: connect.NewError(connect.CodeNotFound, errors.New("stock not found: ZZZZ"))}

	_, _, err := getStockHandler(src)(context.Background(), nil, GetStockInput{Code: "ZZZZ"})
	if err == nil {
		t.Fatal("expected an error for an unknown code")
	}
	// The point of the message is that the model can act on it, not that it
	// exists — so assert on the remedy it names.
	if !strings.Contains(err.Error(), "search_stocks") {
		t.Errorf("not-found error should point at a next step, got %q", err.Error())
	}
}

func TestGetStockSurfacesBackendFailuresAsToolErrors(t *testing.T) {
	src := &fakeDataSource{err: connect.NewError(connect.CodeInternal, errors.New("database on fire"))}

	_, _, err := getStockHandler(src)(context.Background(), nil, GetStockInput{Code: "BHP"})
	if err == nil {
		t.Fatal("expected an error when the RPC fails")
	}
	if strings.Contains(err.Error(), "search_stocks") {
		t.Errorf("an internal failure must not be reported as a missing stock, got %q", err.Error())
	}
}

// A nil-bodied response should be reported, never rendered as a stock whose
// every field happens to be zero — "0.00% shorted" is a plausible-looking lie.
func TestGetStockDoesNotInventDataFromAnEmptyResponse(t *testing.T) {
	src := &fakeDataSource{stock: nil}

	_, _, err := getStockHandler(src)(context.Background(), nil, GetStockInput{Code: "BHP"})
	if err == nil {
		t.Fatal("expected an error when the RPC returns no stock")
	}
}

// ----------------------------------------------------------- get_stock_history

func TestGetStockHistoryDownsamplesLongSeriesAndKeepsTheEndpoints(t *testing.T) {
	const total = 2_500
	points := make([]*stocksv1alpha1.TimeSeriesPoint, 0, total)
	base := time.Date(2016, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < total; i++ {
		points = append(points, &stocksv1alpha1.TimeSeriesPoint{
			Timestamp:     timestamppb.New(base.AddDate(0, 0, i)),
			ShortPosition: float64(i) / 100,
		})
	}
	src := &fakeDataSource{stockData: &stocksv1alpha1.TimeSeriesData{
		ProductCode: "PLS", Name: "PILBARA MINERALS", LatestShortPosition: 24.99, Points: points,
	}}

	_, out, err := getStockHistoryHandler(src)(context.Background(), nil, GetStockHistoryInput{Code: "pls", Period: "max"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if src.gotStockData.GetPeriod() != "MAX" {
		t.Errorf("period = %q, want it upper-cased to MAX", src.gotStockData.GetPeriod())
	}
	if out.TotalObservations != total {
		t.Errorf("total_observations = %d, want %d — the agent must be told what was thrown away", out.TotalObservations, total)
	}
	if len(out.Points) > maxHistoryPoints {
		t.Fatalf("returned %d points, want at most %d", len(out.Points), maxHistoryPoints)
	}
	if !out.Downsampled {
		t.Error("downsampled should be true when points were dropped")
	}
	// The last observation is the one a reader cares about most; a naive
	// every-Nth filter drops it whenever the stride does not divide evenly.
	last := out.Points[len(out.Points)-1]
	wantLast := base.AddDate(0, 0, total-1).Format("2006-01-02")
	if !strings.HasPrefix(last.Date, wantLast) {
		t.Errorf("last sampled point is %q, want the final observation %q", last.Date, wantLast)
	}
	if out.Points[0].ShortPercent != 0 {
		t.Errorf("first sampled point should be the first observation, got %+v", out.Points[0])
	}
}

func TestGetStockHistoryReturnsShortSeriesIntact(t *testing.T) {
	src := &fakeDataSource{stockData: &stocksv1alpha1.TimeSeriesData{
		ProductCode: "BHP",
		Points: []*stocksv1alpha1.TimeSeriesPoint{
			{Timestamp: timestamppb.New(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)), ShortPosition: 1.1},
			{Timestamp: timestamppb.New(time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)), ShortPosition: 1.2},
		},
	}}

	_, out, err := getStockHistoryHandler(src)(context.Background(), nil, GetStockHistoryInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.Points) != 2 || out.Downsampled {
		t.Errorf("a 2-point series must come back whole and unflagged, got %+v", out)
	}
	if src.gotStockData.GetPeriod() != defaultPeriod {
		t.Errorf("period = %q, want the default %q", src.gotStockData.GetPeriod(), defaultPeriod)
	}
}

func TestGetStockHistorySaysSoWhenThereIsNoHistory(t *testing.T) {
	src := &fakeDataSource{stockData: &stocksv1alpha1.TimeSeriesData{ProductCode: "AAA"}}

	res, out, err := getStockHistoryHandler(src)(context.Background(), nil, GetStockHistoryInput{Code: "AAA"})
	if err != nil {
		t.Fatalf("an empty series is a result, not an error: %v", err)
	}
	if out.TotalObservations != 0 || len(out.Points) != 0 {
		t.Errorf("expected an empty series, got %+v", out)
	}
	if !strings.Contains(strings.ToLower(textOf(t, res)), "no ") {
		t.Errorf("the text fallback should state that there is no history, got %q", textOf(t, res))
	}
}

func TestGetStockHistoryRejectsABadPeriod(t *testing.T) {
	src := &fakeDataSource{stockData: &stocksv1alpha1.TimeSeriesData{}}

	_, _, err := getStockHistoryHandler(src)(context.Background(), nil, GetStockHistoryInput{Code: "BHP", Period: "7M"})
	if err == nil {
		t.Fatal("expected a validation error")
	}
	if src.gotStockData != nil {
		t.Error("reached the RPC despite failing validation")
	}
}

// ----------------------------------------------------------- get_stock_details

func TestGetStockDetailsProjectsAndTruncatesProse(t *testing.T) {
	long := strings.Repeat("a", maxProseChars*3)
	risks := make([]string, 40)
	for i := range risks {
		risks[i] = fmt.Sprintf("risk %d", i)
	}
	src := &fakeDataSource{stockDetails: &stocksv1alpha1.StockDetails{
		ProductCode: "BHP", CompanyName: "BHP GROUP LIMITED", Industry: "Materials",
		Website: "https://bhp.com", EnhancedSummary: long, CompanyHistory: long,
		RiskFactors: risks,
		KeyPeople: []*stocksv1alpha1.CompanyPerson{
			{Name: "Mike Henry", Role: "CEO", Bio: long},
		},
		// Present on the proto, deliberately NOT projected: an agent asking for
		// company details does not need every logo variant or a full set of
		// financial statements, and passing them through would let a proto
		// change silently widen this tool's contract.
		LogoGcsUrl:          "https://storage.googleapis.com/x.png",
		FinancialStatements: &stocksv1alpha1.FinancialStatements{Success: true},
	}}

	_, out, err := getStockDetailsHandler(src)(context.Background(), nil, GetStockDetailsInput{Code: "bhp"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotStockDetails.GetProductCode() != "BHP" {
		t.Errorf("product code = %q, want BHP", src.gotStockDetails.GetProductCode())
	}
	if out.CompanyName != "BHP GROUP LIMITED" || out.Website != "https://bhp.com" {
		t.Errorf("identity fields not mapped: %+v", out)
	}
	if len(out.Summary) > maxProseChars+len(truncationMarker) {
		t.Errorf("summary is %d chars, want it truncated to about %d", len(out.Summary), maxProseChars)
	}
	if !strings.HasSuffix(out.Summary, truncationMarker) {
		t.Error("a truncated field must say it was truncated, or the agent reads a sentence that stops mid-word as the whole story")
	}
	if len(out.RiskFactors) > maxListItems {
		t.Errorf("returned %d risk factors, want at most %d", len(out.RiskFactors), maxListItems)
	}
	if len(out.KeyPeople) != 1 || out.KeyPeople[0].Role != "CEO" {
		t.Errorf("key people not mapped: %+v", out.KeyPeople)
	}
}

func TestGetStockDetailsFallsBackToTheBaseSummary(t *testing.T) {
	src := &fakeDataSource{stockDetails: &stocksv1alpha1.StockDetails{
		ProductCode: "AAA", Summary: "A small miner.",
	}}

	_, out, err := getStockDetailsHandler(src)(context.Background(), nil, GetStockDetailsInput{Code: "AAA"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Summary != "A small miner." {
		t.Errorf("summary = %q, want the base summary when no enriched one exists", out.Summary)
	}
}

func TestGetStockDetailsReportsANilBody(t *testing.T) {
	src := &fakeDataSource{stockDetails: nil}

	if _, _, err := getStockDetailsHandler(src)(context.Background(), nil, GetStockDetailsInput{Code: "BHP"}); err == nil {
		t.Fatal("expected an error when the RPC returns no details")
	}
}

// --------------------------------------------------------- get_director_trades

func TestGetDirectorTradesMapsTradesAndClampsLimit(t *testing.T) {
	src := &fakeDataSource{directorTrades: &shortsv1alpha1.GetDirectorTradesResponse{
		TotalCount: 97,
		Trades: []*shortsv1alpha1.DirectorTrade{{
			StockCode: "BHP", DirectorName: "Mike Henry", TradeType: "buy",
			SharesTraded: 12_000, PricePerShare: 44.10, TotalValue: 529_200,
			TradeDate: "2026-06-14", AnnouncementUrl: "https://asx.com.au/x",
		}},
	}}

	_, out, err := getDirectorTradesHandler(src)(context.Background(), nil, GetDirectorTradesInput{Code: "bhp", Limit: 9999})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotDirectorTrades.GetStockCode() != "BHP" {
		t.Errorf("stock code = %q, want BHP", src.gotDirectorTrades.GetStockCode())
	}
	if src.gotDirectorTrades.GetLimit() != maxListLimit {
		t.Errorf("limit = %d, want it clamped to %d", src.gotDirectorTrades.GetLimit(), maxListLimit)
	}
	if out.TotalCount != 97 || out.Returned != 1 {
		t.Errorf("counts wrong: %+v", out)
	}
	got := out.Trades[0]
	if got.DirectorName != "Mike Henry" || got.TradeType != "buy" || got.SharesTraded != 12_000 || got.TotalValue != 529_200 {
		t.Errorf("trade not mapped: %+v", got)
	}
	if got.Date != "2026-06-14" {
		t.Errorf("date = %q, want 2026-06-14", got.Date)
	}
}

func TestGetDirectorTradesSaysSoWhenThereAreNone(t *testing.T) {
	src := &fakeDataSource{directorTrades: &shortsv1alpha1.GetDirectorTradesResponse{}}

	res, out, err := getDirectorTradesHandler(src)(context.Background(), nil, GetDirectorTradesInput{Code: "AAA"})
	if err != nil {
		t.Fatalf("no trades is a result, not an error: %v", err)
	}
	if out.Returned != 0 {
		t.Errorf("expected no trades, got %d", out.Returned)
	}
	if !strings.Contains(strings.ToLower(textOf(t, res)), "no ") {
		t.Errorf("the text fallback should state that there are no trades, got %q", textOf(t, res))
	}
}

// -------------------------------------------------------- get_peer_comparison

func TestGetPeerComparisonReturnsSubjectAndPeers(t *testing.T) {
	src := &fakeDataSource{peerComparison: &shortsv1alpha1.GetPeerComparisonResponse{
		Industry: "Materials",
		Subject: &shortsv1alpha1.PeerStock{
			StockCode: "PLS", CompanyName: "PILBARA MINERALS", ShortPositionPercent: 19.4,
			MarketCap: 7_100_000_000, PeRatio: 18.2, DividendYield: 1.1, PriceChange_1M: 8.4,
		},
		Peers: []*shortsv1alpha1.PeerStock{
			{StockCode: "IGO", CompanyName: "IGO LIMITED", ShortPositionPercent: 9.2},
		},
	}}

	_, out, err := getPeerComparisonHandler(src)(context.Background(), nil, GetPeerComparisonInput{Code: "pls"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotPeerComparison.GetStockCode() != "PLS" {
		t.Errorf("stock code = %q, want PLS", src.gotPeerComparison.GetStockCode())
	}
	if src.gotPeerComparison.GetLimit() != defaultPeerLimit {
		t.Errorf("limit = %d, want the default %d", src.gotPeerComparison.GetLimit(), defaultPeerLimit)
	}
	if out.Industry != "Materials" {
		t.Errorf("industry = %q, want Materials", out.Industry)
	}
	if out.Subject == nil || out.Subject.Code != "PLS" || out.Subject.ShortPercent != 19.4 {
		t.Fatalf("subject not mapped: %+v", out.Subject)
	}
	if len(out.Peers) != 1 || out.Peers[0].Code != "IGO" {
		t.Errorf("peers not mapped: %+v", out.Peers)
	}
}

// A subject the backend could not resolve must not be reported as a peer set
// with a nil centre — the comparison is meaningless without it.
func TestGetPeerComparisonReportsAMissingSubject(t *testing.T) {
	src := &fakeDataSource{peerComparison: &shortsv1alpha1.GetPeerComparisonResponse{Industry: "Materials"}}

	if _, _, err := getPeerComparisonHandler(src)(context.Background(), nil, GetPeerComparisonInput{Code: "ZZZZ"}); err == nil {
		t.Fatal("expected an error when the subject stock is absent")
	}
}
