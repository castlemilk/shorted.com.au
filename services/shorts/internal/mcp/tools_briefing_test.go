package mcp

import (
	"context"
	"math"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestGetStockBriefingBasics(t *testing.T) {
	ctx := context.Background()
	src := &fakeDataSource{
		strategyFit: &shortsv1alpha1.GetStockStrategyFitResponse{
			Fits: []*shortsv1alpha1.StrategyFit{
				{
					StrategyId:   "zanger-breakout",
					StrategyName: "Zanger Breakout",
					Status:       "triggered",
					Score:        82.5,
					Rank:         1,
					TotalCount:   450,
				},
				{
					StrategyId:   "canslim",
					StrategyName: "CAN SLIM",
					Status:       "watch",
					Score:        65.0,
					Rank:         0,
					TotalCount:   320,
				},
			},
			Regime:     &shortsv1alpha1.MarketRegime{Regime: "Bull"},
			InUniverse: true,
		},
		fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
			StockCode:       "BHP",
			HasLatestFiling: true,
			LatestFiling: &shortsv1alpha1.LatestFilingSummary{
				ReportUrl:   "https://example.com/filing.pdf",
				ReportTitle: "Annual Report 2025",
				ReportDate:  "2025-10-11",
				PeriodEnd:   "2025-06-30",
				PeriodType:  "annual",
				Digest:      "Strong earnings growth driven by commodity prices.",
			},
		},
	}

	handler := getStockBriefingHandler(src)
	result, output, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "BHP"})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if output.Code != "BHP" {
		t.Errorf("want Code=BHP, got %s", output.Code)
	}
	if len(output.StrategyFit) != 2 {
		t.Errorf("want 2 strategy fits, got %d", len(output.StrategyFit))
	}
	if output.StrategyFit[0].Strategy != "Zanger Breakout" {
		t.Errorf("want strategy name 'Zanger Breakout', got %s", output.StrategyFit[0].Strategy)
	}
	if output.StrategyFit[0].Status != "triggered" {
		t.Errorf("want status 'triggered', got %s", output.StrategyFit[0].Status)
	}
	if output.LatestFiling == nil {
		t.Errorf("want LatestFiling set, got nil")
	}
	if output.LatestFiling.Title != "Annual Report 2025" {
		t.Errorf("want title 'Annual Report 2025', got %s", output.LatestFiling.Title)
	}
	if result == nil || len(result.Content) == 0 {
		t.Errorf("want non-empty text content, got %v", result)
	}
}

func TestGetStockBriefingCodeNormalized(t *testing.T) {
	ctx := context.Background()
	src := &fakeDataSource{
		fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
			StockCode: "BHP",
		},
	}

	handler := getStockBriefingHandler(src)
	_, _, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "bhp"})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotFundamentals == nil || src.gotFundamentals.StockCode != "BHP" {
		t.Errorf("code not uppercased in request")
	}
}

func TestGetStockBriefingPartialErrors(t *testing.T) {
	ctx := context.Background()
	// Dividends RPC fails, but others succeed
	src := &fakeDataSource{
		strategyFit: &shortsv1alpha1.GetStockStrategyFitResponse{
			Regime: &shortsv1alpha1.MarketRegime{Regime: "Neutral"},
		},
		fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
			StockCode: "BHP",
		},
		errForGetDividends: connect.NewError(connect.CodeNotFound, nil),
	}

	handler := getStockBriefingHandler(src)
	_, output, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "BHP"})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(output.Dividends) != 0 {
		t.Errorf("want empty dividends, got %d", len(output.Dividends))
	}
	if !contains(output.Unavailable, "dividends") {
		t.Errorf("want 'dividends' in unavailable list, got %v", output.Unavailable)
	}
}

func TestGetStockBriefingDividendsCapped(t *testing.T) {
	ctx := context.Background()
	// Create more than 12 dividends
	dividends := []*shortsv1alpha1.DividendRecord{}
	for i := 0; i < 15; i++ {
		dividends = append(dividends, &shortsv1alpha1.DividendRecord{
			ExDate:             "2024-01-01",
			AmountPerShare:     0.50,
			FrankingPercentage: 100,
			DividendType:       "ordinary",
		})
	}

	src := &fakeDataSource{
		fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
			StockCode: "BHP",
		},
		dividendHistory: &shortsv1alpha1.GetDividendHistoryResponse{
			Dividends: dividends,
		},
	}

	handler := getStockBriefingHandler(src)
	_, output, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "BHP"})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(output.Dividends) > 12 {
		t.Errorf("want at most 12 dividends, got %d", len(output.Dividends))
	}
}

func TestGetStockBriefingSignalsOrdered(t *testing.T) {
	ctx := context.Background()
	src := &fakeDataSource{
		fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
			StockCode: "BHP",
		},
		stockSignals: &shortsv1alpha1.GetStockSignalsResponse{
			Adverse: []*shortsv1alpha1.StockSignal{
				{
					Polarity:  "adverse",
					Kind:      "sanction",
					Headline:  "Regulatory fine imposed",
					EventDate: "2024-09-01",
					Citations: []string{"source1", "source2"},
				},
				{
					Polarity:  "adverse",
					Kind:      "court",
					Headline:  "Lawsuit filed",
					EventDate: "2024-08-15",
					Citations: []string{"source3"},
				},
			},
			Positive: []*shortsv1alpha1.StockSignal{
				{
					Polarity:  "positive",
					Kind:      "award",
					Headline:  "Industry award won",
					EventDate: "2024-07-01",
					Citations: []string{"source4"},
				},
			},
		},
	}

	handler := getStockBriefingHandler(src)
	_, output, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "BHP"})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(output.Signals) != 3 {
		t.Errorf("want 3 signals, got %d", len(output.Signals))
	}
	// Adverse should come first, then positive
	if output.Signals[0].Polarity != "adverse" || output.Signals[1].Polarity != "adverse" {
		t.Errorf("want adverse signals first")
	}
	if output.Signals[2].Polarity != "positive" {
		t.Errorf("want positive signal last")
	}
}

func TestGetStockBriefingSignalsCapped(t *testing.T) {
	ctx := context.Background()
	// Create 15 adverse + 15 positive = 30 total
	adverse := []*shortsv1alpha1.StockSignal{}
	positive := []*shortsv1alpha1.StockSignal{}
	for i := 0; i < 15; i++ {
		adverse = append(adverse, &shortsv1alpha1.StockSignal{
			Polarity: "adverse",
			Kind:     "court",
			Headline: "Adverse event",
		})
		positive = append(positive, &shortsv1alpha1.StockSignal{
			Polarity: "positive",
			Kind:     "award",
			Headline: "Positive event",
		})
	}

	src := &fakeDataSource{
		fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
			StockCode: "BHP",
		},
		stockSignals: &shortsv1alpha1.GetStockSignalsResponse{
			Adverse:  adverse,
			Positive: positive,
		},
	}

	handler := getStockBriefingHandler(src)
	_, output, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "BHP"})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(output.Signals) > 10 {
		t.Errorf("want at most 10 signals total, got %d", len(output.Signals))
	}
}

func TestGetStockBriefingNoFilingWhenNotPresent(t *testing.T) {
	ctx := context.Background()
	src := &fakeDataSource{
		fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
			StockCode:       "BHP",
			HasLatestFiling: false,
		},
	}

	handler := getStockBriefingHandler(src)
	_, output, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "BHP"})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if output.LatestFiling != nil {
		t.Errorf("want LatestFiling=nil when has_latest_filing=false, got %v", output.LatestFiling)
	}
}

func TestGetStockBriefingFiniteValues(t *testing.T) {
	ctx := context.Background()
	src := &fakeDataSource{
		strategyFit: &shortsv1alpha1.GetStockStrategyFitResponse{
			Fits: []*shortsv1alpha1.StrategyFit{
				{
					StrategyId:   "test",
					StrategyName: "Test",
					Status:       "triggered",
					Score:        math.NaN(), // NaN
					Rank:         1,
					TotalCount:   100,
				},
			},
		},
		fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
			StockCode: "BHP",
		},
	}

	handler := getStockBriefingHandler(src)
	_, output, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "BHP"})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if math.IsNaN(output.StrategyFit[0].Score) {
		t.Errorf("want finite score value, got NaN")
	}
}

func TestGetStockBriefingStockNotFound(t *testing.T) {
	ctx := context.Background()
	src := &fakeDataSource{
		err: connect.NewError(connect.CodeNotFound, nil),
	}

	handler := getStockBriefingHandler(src)
	_, _, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "NOTREAL"})

	if err == nil {
		t.Fatalf("want error for unknown stock")
	}
}

func TestGetStockBriefingSignalsSortedByDateNewestFirst(t *testing.T) {
	ctx := context.Background()
	src := &fakeDataSource{
		fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
			StockCode: "BHP",
		},
		stockSignals: &shortsv1alpha1.GetStockSignalsResponse{
			Adverse: []*shortsv1alpha1.StockSignal{
				{
					Polarity:  "adverse",
					Kind:      "court",
					Headline:  "Case 3",
					EventDate: "2024-06-15",
				},
				{
					Polarity:  "adverse",
					Kind:      "sanction",
					Headline:  "Case 1",
					EventDate: "2024-08-20",
				},
				{
					Polarity:  "adverse",
					Kind:      "complaint",
					Headline:  "Case 2",
					EventDate: "2024-07-10",
				},
			},
			Positive: []*shortsv1alpha1.StockSignal{
				{
					Polarity:  "positive",
					Kind:      "award",
					Headline:  "Award 2",
					EventDate: "2024-05-01",
				},
				{
					Polarity:  "positive",
					Kind:      "press",
					Headline:  "Award 1",
					EventDate: "",
				},
				{
					Polarity:  "positive",
					Kind:      "press",
					Headline:  "Award 3",
					EventDate: "2024-09-01",
				},
			},
		},
	}

	handler := getStockBriefingHandler(src)
	_, output, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "BHP"})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(output.Signals) != 6 {
		t.Errorf("want 6 signals, got %d", len(output.Signals))
	}
	// Adverse should come first in date order (newest first): 2024-08-20, 2024-07-10, 2024-06-15
	// Then positive in date order (newest first): 2024-09-01, 2024-05-01, empty last
	expectedOrder := []struct {
		polarity string
		date     string
		headline string
	}{
		{"adverse", "2024-08-20", "Case 1"},
		{"adverse", "2024-07-10", "Case 2"},
		{"adverse", "2024-06-15", "Case 3"},
		{"positive", "2024-09-01", "Award 3"},
		{"positive", "2024-05-01", "Award 2"},
		{"positive", "", "Award 1"},
	}
	for i, expected := range expectedOrder {
		if i >= len(output.Signals) {
			t.Fatalf("not enough signals: got %d, want %d", len(output.Signals), len(expectedOrder))
		}
		sig := output.Signals[i]
		if sig.Polarity != expected.polarity {
			t.Errorf("signal %d polarity: want %s, got %s", i, expected.polarity, sig.Polarity)
		}
		if sig.Date != expected.date {
			t.Errorf("signal %d date: want %s, got %s", i, expected.date, sig.Date)
		}
		if sig.Headline != expected.headline {
			t.Errorf("signal %d headline: want %s, got %s", i, expected.headline, sig.Headline)
		}
	}
}

func TestGetStockBriefingHandlesNaNAmountAud(t *testing.T) {
	ctx := context.Background()
	src := &fakeDataSource{
		fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
			StockCode: "BHP",
		},
		dividendHistory: &shortsv1alpha1.GetDividendHistoryResponse{
			Dividends: []*shortsv1alpha1.DividendRecord{
				{
					ExDate:             "2024-01-01",
					AmountPerShare:     math.NaN(),
					FrankingPercentage: 100,
					DividendType:       "ordinary",
				},
			},
		},
	}

	handler := getStockBriefingHandler(src)
	_, output, err := handler(ctx, &sdk.CallToolRequest{}, GetStockBriefingInput{Code: "BHP"})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(output.Dividends) != 1 {
		t.Errorf("want 1 dividend, got %d", len(output.Dividends))
	}
	if math.IsNaN(output.Dividends[0].AmountAud) {
		t.Errorf("want finite AmountAud, got NaN")
	}
}
