package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
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

// Thinning is the SERVER's job now: it alone knows how many raw observations
// back a series, and deriving the count here reported the number of weekly
// BUCKETS as the number of daily observations (846 for 16 years of MAX, when
// the real daily count is several thousand). What this tool must still get
// right is the request it sends and the counts it passes through.
func TestGetStockHistoryAsksTheServerToThinAndReportsWhatItSaysBack(t *testing.T) {
	src := &fakeDataSource{stockData: &stocksv1alpha1.TimeSeriesData{
		ProductCode: "PLS", Name: "PILBARA MINERALS", LatestShortPosition: 24.99,
		Points: []*stocksv1alpha1.TimeSeriesPoint{
			{Timestamp: timestamppb.New(time.Date(2016, 1, 1, 0, 0, 0, 0, time.UTC)), ShortPosition: 1},
			{Timestamp: timestamppb.New(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)), ShortPosition: 25},
		},
		TotalObservations: 3897,
		Downsampled:       true,
	}}

	_, out, err := getStockHistoryHandler(src)(context.Background(), nil,
		GetStockHistoryInput{Code: "pls", Period: "max"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if src.gotStockData.GetPeriod() != "MAX" {
		t.Errorf("period = %q, want it upper-cased to MAX", src.gotStockData.GetPeriod())
	}
	if got := src.gotStockData.GetMaxPoints(); got != maxHistoryPoints {
		t.Errorf("max_points = %d, want the %d default sent to the server", got, maxHistoryPoints)
	}
	if src.gotStockData.GetFullResolution() {
		t.Error("full_resolution should be false unless the caller asked for it")
	}

	// Reported verbatim, not recomputed from the points that arrived.
	if out.TotalObservations != 3897 {
		t.Errorf("total_observations = %d, want the server's 3897", out.TotalObservations)
	}
	if !out.Downsampled {
		t.Error("downsampled should reflect what the server reported")
	}
}

// The MCP was the only surface holding the deep history and thinned it with no
// opt-out, so the richest series in the product was reachable only in a shape
// meant for conversation.
func TestGetStockHistoryFullResolutionRemovesTheCap(t *testing.T) {
	src := &fakeDataSource{stockData: &stocksv1alpha1.TimeSeriesData{ProductCode: "BHP"}}

	_, _, err := getStockHistoryHandler(src)(context.Background(), nil,
		GetStockHistoryInput{Code: "BHP", Period: "max", FullResolution: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !src.gotStockData.GetFullResolution() {
		t.Error("full_resolution must reach the server")
	}
	if got := src.gotStockData.GetMaxPoints(); got != 0 {
		t.Errorf("max_points = %d, want 0 — a cap would defeat full resolution", got)
	}
}

func TestGetStockHistoryHonoursAnExplicitPointCap(t *testing.T) {
	src := &fakeDataSource{stockData: &stocksv1alpha1.TimeSeriesData{ProductCode: "BHP"}}

	_, _, err := getStockHistoryHandler(src)(context.Background(), nil,
		GetStockHistoryInput{Code: "BHP", MaxPoints: 1000})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := src.gotStockData.GetMaxPoints(); got != 1000 {
		t.Errorf("max_points = %d, want 1000", got)
	}

	// And refuses one it cannot serve, rather than silently substituting a
	// different number.
	_, _, err = getStockHistoryHandler(src)(context.Background(), nil,
		GetStockHistoryInput{Code: "BHP", MaxPoints: maxRequestableHistoryPoints + 1})
	if err == nil {
		t.Fatal("expected an error for a max_points above the ceiling")
	}
}

// A caller after one window had to request MAX and discard most of it.
func TestGetStockHistoryPassesAnExplicitDateRange(t *testing.T) {
	src := &fakeDataSource{stockData: &stocksv1alpha1.TimeSeriesData{ProductCode: "BHP"}}

	_, _, err := getStockHistoryHandler(src)(context.Background(), nil,
		GetStockHistoryInput{Code: "BHP", From: "2020-01-01", To: "2020-12-31"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotStockData.GetFrom() != "2020-01-01" || src.gotStockData.GetTo() != "2020-12-31" {
		t.Errorf("from/to = %q/%q, want 2020-01-01/2020-12-31",
			src.gotStockData.GetFrom(), src.gotStockData.GetTo())
	}
}

// Short interest is a percent of shares on issue, and shares on issue moves.
// A placement drops the percent overnight with no change in positioning; only
// the raw count and the denominator distinguish that from short covering.
func TestGetStockHistoryCarriesTheRawCountAndItsDenominator(t *testing.T) {
	src := &fakeDataSource{stockData: &stocksv1alpha1.TimeSeriesData{
		ProductCode: "BHP",
		Points: []*stocksv1alpha1.TimeSeriesPoint{{
			Timestamp:              timestamppb.New(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)),
			ShortPosition:          1.25,
			ReportedShortPositions: 63_791_924,
			TotalProductInIssue:    5_084_182_500,
		}},
	}}

	_, out, err := getStockHistoryHandler(src)(context.Background(), nil, GetStockHistoryInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.Points) != 1 {
		t.Fatalf("got %d points, want 1", len(out.Points))
	}
	if out.Points[0].ShortPositions != 63_791_924 {
		t.Errorf("short_positions = %v, want the raw share count", out.Points[0].ShortPositions)
	}
	if out.Points[0].SharesOnIssue != 5_084_182_500 {
		t.Errorf("shares_on_issue = %v, want the denominator", out.Points[0].SharesOnIssue)
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

// Peers come from mv_screener_data, which COALESCEs a missing market cap, P/E
// or dividend yield to 0. Those must be absent, on the subject and the peers
// alike, and real values must pass through.
func TestGetPeerComparisonOmitsUnknownValuationFieldsRatherThanEmittingZero(t *testing.T) {
	src := &fakeDataSource{peerComparison: &shortsv1alpha1.GetPeerComparisonResponse{
		Industry: "Materials",
		Subject:  &shortsv1alpha1.PeerStock{StockCode: "ZZZ", ShortPositionPercent: 3.1},
		Peers: []*shortsv1alpha1.PeerStock{
			{StockCode: "IGO", ShortPositionPercent: 9.2, MarketCap: 4e9, PeRatio: 18.2, DividendYield: 1.1},
			{StockCode: "AAA", ShortPositionPercent: 1.0},
		},
	}}

	_, out, err := getPeerComparisonHandler(src)(context.Background(), nil, GetPeerComparisonInput{Code: "ZZZ"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for label, entry := range map[string]any{"subject": out.Subject, "peer": out.Peers[1]} {
		raw, _ := json.Marshal(entry)
		for _, key := range []string{"market_cap", "pe_ratio", "dividend_yield"} {
			if strings.Contains(string(raw), `"`+key+`"`) {
				t.Errorf("%s: unknown %s emitted (%s) — a 0 reads as a real value", label, key, raw)
			}
		}
	}
	igo := out.Peers[0]
	if igo.MarketCap == nil || *igo.MarketCap != 4e9 || igo.PERatio == nil || *igo.PERatio != 18.2 ||
		igo.DividendYield == nil || *igo.DividendYield != 1.1 {
		t.Errorf("known values not passed through: %+v", igo)
	}
	if !strings.Contains(getPeerComparisonDescription, "absent when unknown, never zero") {
		t.Error("the description must say unknown values are absent")
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

// ------------------------------------------------------ get_stock_fundamentals

func fundamentalsFixture() *shortsv1alpha1.GetStockFundamentalsResponse {
	return &shortsv1alpha1.GetStockFundamentalsResponse{
		StockCode: "BHP",
		Periods: []*shortsv1alpha1.FundamentalsPeriod{
			{
				PeriodType: "annual", PeriodEnd: "2026-06-30", FiscalYear: 2026, Currency: "USD", Source: "yahoo-timeseries",
				FetchedAt: "2026-09-26T08:00:00Z",
				Revenue:   55_658_000_000, HasRevenue: true,
				// Reported as exactly zero: a measurement, and must be emitted.
				NetIncome: 0, HasNetIncome: true,
				EpsDiluted: 1.23, HasEpsDiluted: true,
				// Present in the proto as 0 with no flag: NOT reported.
				OperatingCashFlow: 0, HasOperatingCashFlow: false,
				SharesOutstanding: 5_071_000_000, HasSharesOutstanding: true,
			},
			{PeriodType: "half", PeriodEnd: "2025-12-31", FiscalYear: 2026, Currency: "USD", Revenue: 27e9, HasRevenue: true},
			// A company that changed reporting currency: the old year must say so.
			{PeriodType: "annual", PeriodEnd: "2015-06-30", FiscalYear: 2015, Currency: "AUD", Revenue: 44e9, HasRevenue: true},
		},
		HasGrowth: true,
		Growth: &shortsv1alpha1.FundamentalsGrowth{
			BasisPeriodType: "ttm", LatestPeriodEnd: "2026-06-30",
			RevenueYoyPct: 12.345, HasRevenueYoy: true,
			EpsYoyPct: -4.5678, HasEpsYoy: true,
			RevenueYoyPriorPct: 0, HasRevenueYoyPrior: false,
			NetIncomePositive: true, PeriodsAvailable: 22,
			RevenueTtm: 55e9, HasRevenueTtm: true,
		},
	}
}

func TestGetStockFundamentalsValidatesBeforeCallingTheRPC(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   GetStockFundamentalsInput
		want string
	}{
		{"bad code", GetStockFundamentalsInput{Code: "not a ticker"}, "ASX ticker"},
		{"bad period type", GetStockFundamentalsInput{Code: "BHP", PeriodType: "monthly"}, "annual, ttm, half, quarter"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := &fakeDataSource{fundamentals: fundamentalsFixture()}
			_, _, err := getStockFundamentalsHandler(src)(context.Background(), nil, tc.in)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected an error naming %q, got %v", tc.want, err)
			}
			if src.gotFundamentals != nil {
				t.Error("reached the RPC despite failing validation")
			}
		})
	}
}

func TestGetStockFundamentalsNormalisesAndClampsTheRequest(t *testing.T) {
	for _, tc := range []struct {
		limit int
		want  int32
	}{{0, defaultFundamentalsLimit}, {-1, defaultFundamentalsLimit}, {12, 12}, {500, maxFundamentalsLimit}} {
		src := &fakeDataSource{fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{}}
		in := GetStockFundamentalsInput{Code: " bhp ", PeriodType: " Annual ", Limit: tc.limit}
		if _, _, err := getStockFundamentalsHandler(src)(context.Background(), nil, in); err != nil {
			t.Fatalf("limit %d: unexpected error: %v", tc.limit, err)
		}
		got := src.gotFundamentals
		if got.GetLimit() != tc.want || got.GetStockCode() != "BHP" || got.GetPeriodType() != "annual" {
			t.Errorf("limit %d: request = %+v, want limit %d, BHP, annual", tc.limit, got, tc.want)
		}
	}
}

func TestGetStockFundamentalsHonoursTheHasFlags(t *testing.T) {
	src := &fakeDataSource{fundamentals: fundamentalsFixture()}

	res, out, err := getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Code != "BHP" || out.Currency != "USD" || out.Count != 3 {
		t.Fatalf("header: %+v", out)
	}

	latest := out.Periods[0]
	if latest.PeriodType != "annual" || latest.PeriodEnd != "2026-06-30" || latest.FiscalYear != 2026 || latest.Source != "yahoo-timeseries" {
		t.Errorf("period header: %+v", latest)
	}
	if latest.Revenue == nil || *latest.Revenue != 55_658_000_000 {
		t.Errorf("revenue: %v", latest.Revenue)
	}
	if latest.NetIncome == nil || *latest.NetIncome != 0 {
		t.Errorf("a reported zero net income must be emitted as 0, got %v", latest.NetIncome)
	}
	raw, _ := json.Marshal(latest)
	for _, key := range []string{"operating_cash_flow", "free_cash_flow", "eps_basic", "currency"} {
		if strings.Contains(string(raw), `"`+key+`"`) {
			t.Errorf("%s emitted without being reported (or, for currency, without differing): %s", key, raw)
		}
	}
	if out.Periods[1].Currency != "" {
		t.Errorf("a period in the result's currency should not restate it: %q", out.Periods[1].Currency)
	}
	if out.Periods[2].Currency != "AUD" {
		t.Errorf("a period in a different currency must carry it, got %q", out.Periods[2].Currency)
	}

	g := out.Growth
	if g == nil {
		t.Fatal("growth dropped")
	}
	if g.BasisPeriodType != "ttm" || g.PeriodsAvailable != 22 || !g.NetIncomePositive {
		t.Errorf("growth header: %+v", g)
	}
	if g.RevenueYoYPct == nil || *g.RevenueYoYPct != 12.35 || g.EPSYoYPct == nil || *g.EPSYoYPct != -4.57 {
		t.Errorf("growth figures: revenue=%v eps=%v", g.RevenueYoYPct, g.EPSYoYPct)
	}
	if g.RevenueYoYPriorPct != nil || g.EPSTTM != nil || g.RevenueHalfYoYPct != nil || g.EPSHalfYoYPct != nil {
		t.Errorf("unflagged growth figures must be absent: prior=%v eps_ttm=%v rev_half=%v eps_half=%v",
			g.RevenueYoYPriorPct, g.EPSTTM, g.RevenueHalfYoYPct, g.EPSHalfYoYPct)
	}
	if strings.Contains(mustJSON(t, g), "half_latest_period_end") {
		t.Errorf("half_latest_period_end emitted without a half row: %+v", g)
	}
	whole, _ := json.Marshal(out)
	if strings.Contains(string(whole), "fetched_at") {
		t.Errorf("fetched_at leaked: %s", whole)
	}

	text := textOf(t, res)
	for _, want := range []string{"BHP", "3 reported periods", "USD", "Revenue +12.3% year on year (annual)", "EPS -4.6% year on year (ttm)", "Not financial advice"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary missing %q: %q", want, text)
		}
	}
}

func TestGetStockFundamentalsNamesTheHalfBasis(t *testing.T) {
	fixture := fundamentalsFixture()
	fixture.Growth.BasisPeriodType = "half"
	fixture.Growth.RevenueBasisPeriodType = "half"
	fixture.Growth.HalfLatestPeriodEnd = "2025-12-31"
	fixture.Growth.RevenueHalfYoyPct, fixture.Growth.HasRevenueHalfYoy = 12.345, true
	fixture.Growth.EpsHalfYoyPct, fixture.Growth.HasEpsHalfYoy = 0, false
	src := &fakeDataSource{fundamentals: fixture}

	res, out, err := getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	g := out.Growth
	if g == nil || g.BasisPeriodType != "half" || g.RevenueBasisPeriodType != "half" || g.HalfLatestPeriodEnd != "2025-12-31" {
		t.Fatalf("half basis dropped: %+v", g)
	}
	if g.RevenueHalfYoYPct == nil || *g.RevenueHalfYoYPct != 12.35 {
		t.Errorf("revenue_half_yoy_pct: %v", g.RevenueHalfYoYPct)
	}
	if g.EPSHalfYoYPct != nil {
		t.Errorf("an unflagged half EPS growth must be absent, got %v", *g.EPSHalfYoYPct)
	}
	text := textOf(t, res)
	for _, want := range []string{"Revenue +12.3% year on year (half)", "EPS -4.6% year on year (half)"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary missing %q: %q", want, text)
		}
	}
}

func TestGetStockFundamentalsOmitsGrowthWithoutTheFlag(t *testing.T) {
	fixture := fundamentalsFixture()
	fixture.HasGrowth = false
	src := &fakeDataSource{fundamentals: fixture}

	_, out, err := getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Growth != nil {
		t.Errorf("growth emitted although has_growth is false: %+v", out.Growth)
	}
}

func TestGetStockFundamentalsSaysSoWhenNothingIsHeld(t *testing.T) {
	src := &fakeDataSource{fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{StockCode: "XYZ"}}

	res, out, err := getStockFundamentalsHandler(src)(context.Background(), nil,
		GetStockFundamentalsInput{Code: "XYZ", PeriodType: "quarter"})
	if err != nil {
		t.Fatalf("a known stock without fundamentals is a result, not an error: %v", err)
	}
	if out.Count != 0 || out.Periods == nil || out.Growth != nil {
		t.Errorf("empty result malformed: %+v", out)
	}
	text := textOf(t, res)
	for _, want := range []string{"No reported fundamentals", "XYZ", "balance-sheet snapshots"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary missing %q: %q", want, text)
		}
	}
}

func TestGetStockFundamentalsReportsAnUnknownTickerDistinctly(t *testing.T) {
	src := &fakeDataSource{err: connect.NewError(connect.CodeNotFound, errors.New("stock not found: ZZZZ"))}
	_, _, err := getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "ZZZZ"})
	if err == nil || !strings.Contains(err.Error(), "search_stocks") {
		t.Errorf("not-found should point at search_stocks, got %v", err)
	}

	src = &fakeDataSource{err: connect.NewError(connect.CodeInternal, errors.New("database on fire"))}
	_, _, err = getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
	if err == nil || strings.Contains(err.Error(), "search_stocks") {
		t.Errorf("an internal error must not be reported as a bad ticker, got %v", err)
	}

	if _, _, err := getStockFundamentalsHandler(&fakeDataSource{})(context.Background(), nil,
		GetStockFundamentalsInput{Code: "BHP"}); err == nil {
		t.Error("expected an error when the RPC returns no body")
	}
}

// The description is the only warning a model gets before it quotes a USD
// revenue as AUD, reads a balance snapshot as a missing quarter, or treats a
// withheld bank ratio as a zero.
func TestGetStockFundamentalsDescriptionCarriesItsCaveats(t *testing.T) {
	for _, want := range []string{"REPORTING currency", "USD", "same series", "absent, never zero",
		"quarter rows are balance snapshots", "not meaningful for banks and insurers", "non-AUD", "CDIs",
		"market data provider", "parsed ASX filings", "not estimates or financial advice"} {
		if !strings.Contains(getStockFundamentalsDescription, want) {
			t.Errorf("description missing %q", want)
		}
	}
	// Plan fundamentals-coverage.md §8, verbatim.
	if !strings.Contains(strings.ToLower(getStockFundamentalsDescription), "valuation ratios use the latest close; no short data") {
		t.Errorf("description must say valuation ratios use the latest close and that there is no short data")
	}
}

// The four statement lines the quality ratios cannot be checked without are
// published per period under the same rule as every other figure: the has_*
// flag decides, so a reported zero survives and an unreported line is absent.
// field_sources passes through, and an empty map is absent rather than {}.
func TestGetStockFundamentalsPublishesTheNewLinesAndTheirProvenance(t *testing.T) {
	fixture := fundamentalsFixture()
	p := fixture.Periods[0]
	p.OperatingIncome, p.HasOperatingIncome = 21_000_000_000, true
	p.CapitalExpenditure, p.HasCapitalExpenditure = 0, true // a reported zero
	p.TotalEquity, p.HasTotalEquity = 48_000_000_000, false
	p.NetDebt, p.HasNetDebt = -3_000_000_000, true
	p.FieldSources = map[string]string{
		"operating_cash_flow": "derived:fcf-minus-capex",
		"net_income":          "asx-filing-extraction",
		"":                    "ignored",
	}
	fixture.Periods[1].FieldSources = map[string]string{}
	src := &fakeDataSource{fundamentals: fixture}

	_, out, err := getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	latest := out.Periods[0]
	if latest.OperatingIncome == nil || *latest.OperatingIncome != 21_000_000_000 {
		t.Errorf("operating_income: %v", latest.OperatingIncome)
	}
	if latest.CapitalExpenditure == nil || *latest.CapitalExpenditure != 0 {
		t.Errorf("a reported zero capex must be emitted as 0, got %v", latest.CapitalExpenditure)
	}
	if latest.TotalEquity != nil {
		t.Errorf("total_equity emitted without its has_* flag: %v", *latest.TotalEquity)
	}
	if latest.NetDebt == nil || *latest.NetDebt != -3_000_000_000 {
		t.Errorf("net_debt (negative is net cash): %v", latest.NetDebt)
	}
	want := map[string]string{"operating_cash_flow": "derived:fcf-minus-capex", "net_income": "asx-filing-extraction"}
	if len(latest.FieldSources) != len(want) {
		t.Fatalf("field_sources = %v, want %v", latest.FieldSources, want)
	}
	for k, v := range want {
		if latest.FieldSources[k] != v {
			t.Errorf("field_sources[%s] = %q, want %q", k, latest.FieldSources[k], v)
		}
	}
	raw, _ := json.Marshal(out.Periods[1])
	for _, key := range []string{"field_sources", "operating_income", "capital_expenditure", "total_equity", "net_debt"} {
		if strings.Contains(string(raw), `"`+key+`"`) {
			t.Errorf("%s emitted on a period that does not carry it: %s", key, raw)
		}
	}
}

func qualityFixture() *shortsv1alpha1.FundamentalsQuality {
	return &shortsv1alpha1.FundamentalsQuality{
		BasisPeriodType: "ttm", BasisPeriodEnd: "2026-06-30", Currency: "USD",
		BalancePeriodEnd: "2026-06-30", BalanceCurrency: "USD", BalanceLagMonths: 0,
		GrossMarginPct: 48.1234, HasGrossMarginPct: true,
		OperatingMarginPct: 31.2345, HasOperatingMarginPct: true,
		NetMarginPct: 16.789, HasNetMarginPct: true,
		FcfMarginPct: 0, HasFcfMarginPct: true, // a measured zero
		FcfConversion: 0.8123, HasFcfConversion: true,
		RoePct: 23.4567, HasRoePct: true,
		RoaPct: 9.87, HasRoaPct: false, // a value without its flag
		NetDebt: -4_903_000_000, HasNetDebt: true,
		NetDebtToEbitda: 0.4123, HasNetDebtToEbitda: true,
		NetDebtToEquity: 0.2123, HasNetDebtToEquity: true,
		CurrentRatio: 1.7123, HasCurrentRatio: true,
		InterestCover: 23.456, HasInterestCover: true,
		PayoutRatioPct: 61.2345, HasPayoutRatioPct: true,
		MarketCap: 331_234_567_890, HasMarketCap: true,
		PeRatio: 14.2345, HasPeRatio: true,
		PriceToBook: 3.1234, HasPriceToBook: true,
		PriceAsOf: "2026-09-25", Source: "yahoo-timeseries",
		SharesAsOf: "2026-06-30", PeEpsPeriodEnd: "2026-06-30", PeEpsBasis: "diluted",
	}
}

// The quality block is the API's, not a recomputation: every ratio is gated by
// its has_* flag (a measured zero survives, a value without its flag does
// not), rounded like every other ratio in this package, and the provenance
// fields the tool does not publish stay out.
func TestGetStockFundamentalsProjectsQualityByItsFlags(t *testing.T) {
	fixture := fundamentalsFixture()
	fixture.Quality, fixture.HasQuality = qualityFixture(), true
	src := &fakeDataSource{fundamentals: fixture}

	res, out, err := getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	q := out.Quality
	if q == nil {
		t.Fatal("quality dropped")
	}
	if q.BasisPeriodType != "ttm" || q.BasisPeriodEnd != "2026-06-30" || q.BalancePeriodEnd != "2026-06-30" ||
		q.BalanceCurrency != "USD" || q.PriceAsOf != "2026-09-25" {
		t.Errorf("quality header: %+v", q)
	}
	for name, got := range map[string]*float64{
		"gross_margin_pct": q.GrossMarginPct, "operating_margin_pct": q.OperatingMarginPct,
		"net_margin_pct": q.NetMarginPct, "fcf_conversion": q.FCFConversion, "roe_pct": q.ROEPct,
		"net_debt_to_ebitda": q.NetDebtToEBITDA, "net_debt_to_equity": q.NetDebtToEquity,
		"current_ratio": q.CurrentRatio, "interest_cover": q.InterestCover, "payout_ratio_pct": q.PayoutRatioPct,
		"pe_ratio": q.PERatio, "price_to_book": q.PriceToBook,
	} {
		if got == nil {
			t.Errorf("%s dropped although flagged", name)
		}
	}
	if *q.ROEPct != 23.46 || *q.NetMarginPct != 16.79 || *q.PERatio != 14.23 || *q.FCFConversion != 0.81 {
		t.Errorf("ratios not rounded to 2dp: roe=%v margin=%v pe=%v conv=%v", *q.ROEPct, *q.NetMarginPct, *q.PERatio, *q.FCFConversion)
	}
	if q.FCFMarginPct == nil || *q.FCFMarginPct != 0 {
		t.Errorf("a measured 0%% FCF margin must be emitted as 0, got %v", q.FCFMarginPct)
	}
	if q.ROAPct != nil {
		t.Errorf("roa_pct emitted without its has_* flag: %v", *q.ROAPct)
	}
	if q.NetDebt == nil || *q.NetDebt != -4_903_000_000 || q.MarketCap == nil || *q.MarketCap != 331_234_567_890 {
		t.Errorf("amounts: net_debt=%v market_cap=%v", q.NetDebt, q.MarketCap)
	}
	raw := mustJSON(t, q)
	for _, key := range []string{"shares_as_of", "pe_eps", "balance_lag_months", "operating_cash_flow_derived", `"source"`,
		"is_financial", "is_property", "not_meaningful", "valuation_note", `"currency"`} {
		if strings.Contains(raw, key) {
			t.Errorf("%s emitted: %s", key, raw)
		}
	}
	text := textOf(t, res)
	for _, want := range []string{"ROE 23.5%", "net margin 16.8%", "net debt/EBITDA 0.4x", "P/E 14.2", "(ttm to 2026-06-30)"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary missing %q: %q", want, text)
		}
	}

	fixture.HasQuality = false
	_, out, err = getStockFundamentalsHandler(&fakeDataSource{fundamentals: fixture})(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Quality != nil {
		t.Errorf("quality emitted although has_quality is false: %+v", out.Quality)
	}
}

// A bank: the API decided is_financial, nulled the not-meaningful ratios and
// listed them. The tool must neither resurrect a value the API withheld nor
// drop the list that says why it is missing.
func TestGetStockFundamentalsCarriesWhatTheAPIWithheldForAFinancial(t *testing.T) {
	fixture := fundamentalsFixture()
	q := &shortsv1alpha1.FundamentalsQuality{
		BasisPeriodType: "annual", BasisPeriodEnd: "2026-06-30", Currency: "AUD",
		NetMarginPct: 35.1, HasNetMarginPct: true, RoePct: 13.2, HasRoePct: true,
		// Withheld by the API: zeroed with no flag.
		CurrentRatio: 0, InterestCover: 0,
		IsFinancial: true, NotMeaningful: strategies.NotMeaningfulForFinancials(),
		MarketCap: 280e9, HasMarketCap: true, PeRatio: 27.1, HasPeRatio: true, PriceAsOf: "2026-09-25",
	}
	fixture.Quality, fixture.HasQuality = q, true
	_, out, err := getStockFundamentalsHandler(&fakeDataSource{fundamentals: fixture})(context.Background(), nil, GetStockFundamentalsInput{Code: "CBA"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := out.Quality
	if got == nil || !got.IsFinancial {
		t.Fatalf("is_financial dropped: %+v", got)
	}
	want := strategies.NotMeaningfulForFinancials()
	if len(got.NotMeaningful) != len(want) {
		t.Fatalf("not_meaningful = %v, want %v", got.NotMeaningful, want)
	}
	for i := range want {
		if got.NotMeaningful[i] != want[i] {
			t.Errorf("not_meaningful[%d] = %q, want %q", i, got.NotMeaningful[i], want[i])
		}
	}
	if got.CurrentRatio != nil || got.InterestCover != nil || got.NetDebt != nil || got.FCFConversion != nil {
		t.Errorf("a withheld ratio reappeared: %s", mustJSON(t, got))
	}
	if got.ROEPct == nil || got.NetMarginPct == nil {
		t.Errorf("ROE and net margin stay meaningful for a financial: %s", mustJSON(t, got))
	}
}

// An FX-converted vendor series, or statements in another currency, is
// "non-aud": the API's Valuate withholds P/E and P/B. A value that arrives
// without its flag must stay absent (the MCP layer never recomputes it), and
// the note says why. A listed-unit mismatch (a CDI) withholds valuation too.
func TestGetStockFundamentalsNeverEmitsAWithheldValuation(t *testing.T) {
	for _, tc := range []struct {
		note, want string
		cap        bool
	}{
		{strategies.ValuationNoteNonAUD, "not in AUD", true},
		{strategies.ValuationNoteListedUnit, "not one ordinary share", false},
	} {
		t.Run(tc.note, func(t *testing.T) {
			fixture := fundamentalsFixture()
			fixture.Quality = &shortsv1alpha1.FundamentalsQuality{
				BasisPeriodType: "annual", BasisPeriodEnd: "2026-06-30",
				RoePct: 18.1, HasRoePct: true,
				// Stale numbers behind false flags, as a careless source might send.
				PeRatio: 12.3, PriceToBook: 4.5, MarketCap: 9e9, HasMarketCap: tc.cap,
				PriceAsOf: "2026-09-25", ValuationNote: tc.note,
			}
			fixture.HasQuality = true
			res, out, err := getStockFundamentalsHandler(&fakeDataSource{fundamentals: fixture})(context.Background(), nil, GetStockFundamentalsInput{Code: "XRO"})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			q := out.Quality
			if q == nil || q.PERatio != nil || q.PriceToBook != nil {
				t.Fatalf("a withheld P/E or P/B was emitted: %s", mustJSON(t, q))
			}
			if (q.MarketCap != nil) != tc.cap {
				t.Errorf("market_cap presence = %v, want %v", q.MarketCap != nil, tc.cap)
			}
			if q.ValuationNote != tc.note {
				t.Errorf("valuation_note = %q, want %q", q.ValuationNote, tc.note)
			}
			if text := textOf(t, res); !strings.Contains(text, tc.want) || strings.Contains(text, "P/E 12") {
				t.Errorf("summary should say why valuation is withheld and quote no P/E: %q", text)
			}
		})
	}
}

// Coverage says what the collector knows. Absent is not a status: an API
// without it, or one that could not decide, sends nothing and so does the
// tool. An empty result is explained in the stock page's words, and never as
// "the company publishes no statements".
func TestGetStockFundamentalsExplainsCoverage(t *testing.T) {
	fixture := fundamentalsFixture()
	fixture.Coverage = &shortsv1alpha1.FundamentalsCoverage{
		Status: "covered", LastAttemptAt: "2026-09-26T08:00:00Z", LastSuccessAt: "2026-09-26T08:00:00Z",
		Sources: []string{"yahoo-timeseries", " ", "asx-filing-extraction"},
	}
	_, out, err := getStockFundamentalsHandler(&fakeDataSource{fundamentals: fixture})(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	c := out.Coverage
	if c == nil || c.Status != "covered" || c.LastSuccessAt != "2026-09-26T08:00:00Z" ||
		len(c.Sources) != 2 || c.Sources[1] != "asx-filing-extraction" {
		t.Errorf("coverage: %+v", c)
	}

	for _, cov := range []*shortsv1alpha1.FundamentalsCoverage{nil, {}, {Status: "  "}} {
		fixture.Coverage = cov
		_, out, err := getStockFundamentalsHandler(&fakeDataSource{fundamentals: fixture})(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if out.Coverage != nil {
			t.Errorf("coverage %v should be absent, got %+v", cov, out.Coverage)
		}
	}

	for _, tc := range []struct {
		status string
		want   []string
	}{
		{"empty", []string{"Our data providers hold no financial statements for XYZ", "last checked 2026-09-20", "does not mean the company reported nothing"}},
		{"pending", []string{"Fundamentals not yet collected for XYZ."}},
		{"failed", []string{"could not be collected on 2026-09-20", "the next run retries"}},
		{"", []string{"No reported fundamentals are held for XYZ yet", "does not mean the company reported nothing"}},
	} {
		t.Run("empty result, status "+tc.status, func(t *testing.T) {
			src := &fakeDataSource{fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{
				StockCode: "XYZ",
				Coverage:  &shortsv1alpha1.FundamentalsCoverage{Status: tc.status, LastAttemptAt: "2026-09-20T15:04:05Z"},
			}}
			res, _, err := getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "XYZ"})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			text := textOf(t, res)
			for _, want := range tc.want {
				if !strings.Contains(text, want) {
					t.Errorf("summary missing %q: %q", want, text)
				}
			}
			for _, never := range []string{"publishes no", "does not publish", "has no financial statements"} {
				if strings.Contains(text, never) {
					t.Errorf("summary implies the company publishes no statements (%q): %q", never, text)
				}
			}
		})
	}
}

// A response from an API that predates the quality block and coverage (no
// has_quality, no coverage) is published exactly as before: no empty objects,
// no invented status.
func TestGetStockFundamentalsReadsAnOlderAPIAsBefore(t *testing.T) {
	src := &fakeDataSource{fundamentals: fundamentalsFixture()}
	_, out, err := getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	raw := mustJSON(t, out)
	for _, key := range []string{`"quality"`, `"coverage"`, `"field_sources"`, `"status"`} {
		if strings.Contains(raw, key) {
			t.Errorf("%s emitted for an older API: %s", key, raw)
		}
	}
}

// validFundamentalsPeriodTypes duplicates the store's set so the tool can
// reject a typo itself. A drift either way is a filter the handler refuses or
// a valid one the tool refuses — pin them together.
func TestFundamentalsPeriodTypesMatchTheStore(t *testing.T) {
	if len(validFundamentalsPeriodTypes) != len(shortsstore.FundamentalsPeriodTypes) {
		t.Fatalf("tool accepts %v, store accepts %v", validFundamentalsPeriodTypes, shortsstore.FundamentalsPeriodTypes)
	}
	for _, pt := range validFundamentalsPeriodTypes {
		if !shortsstore.FundamentalsPeriodTypes[pt] {
			t.Errorf("tool accepts period type %q, which the store rejects", pt)
		}
	}
}

// A quarter row is a balance-sheet snapshot, so the summary's "latest" names
// the newest period with a statement behind it, and falls back to the
// snapshot only when nothing else came back.
func TestGetStockFundamentalsSummaryNamesTheLatestStatementPeriod(t *testing.T) {
	fixture := fundamentalsFixture()
	snapshot := &shortsv1alpha1.FundamentalsPeriod{
		PeriodType: "quarter", PeriodEnd: "2026-09-30", Currency: "USD",
		TotalEquity: 48e9, HasTotalEquity: true,
	}
	fixture.Periods = append([]*shortsv1alpha1.FundamentalsPeriod{snapshot}, fixture.Periods...)
	res, _, err := getStockFundamentalsHandler(&fakeDataSource{fundamentals: fixture})(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text := textOf(t, res); !strings.Contains(text, "latest annual to 2026-06-30") {
		t.Errorf("summary should lead with the newest statement period: %q", text)
	}

	only := &shortsv1alpha1.GetStockFundamentalsResponse{StockCode: "BHP", Periods: []*shortsv1alpha1.FundamentalsPeriod{snapshot}}
	res, _, err = getStockFundamentalsHandler(&fakeDataSource{fundamentals: only})(context.Background(), nil,
		GetStockFundamentalsInput{Code: "BHP", PeriodType: "quarter"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text := textOf(t, res); !strings.Contains(text, "latest balance snapshot at 2026-09-30") {
		t.Errorf("a snapshot-only result should say so: %q", text)
	}
}

// With no period type the quarter balance snapshots are left out, so they
// never crowd the statement periods out of a small limit: the tool reads the
// handler's full window and keeps the first `limit` statement periods.
func TestGetStockFundamentalsDefaultLeavesOutBalanceSnapshots(t *testing.T) {
	var periods []*shortsv1alpha1.FundamentalsPeriod
	for i := 0; i < 6; i++ {
		periods = append(periods,
			&shortsv1alpha1.FundamentalsPeriod{PeriodType: "quarter", PeriodEnd: fmt.Sprintf("2026-%02d-30", 9-i), Currency: "AUD"},
			&shortsv1alpha1.FundamentalsPeriod{PeriodType: "ttm", PeriodEnd: fmt.Sprintf("202%d-06-30", 6-i), Currency: "AUD", Revenue: 1e9, HasRevenue: true},
		)
	}
	src := &fakeDataSource{fundamentals: &shortsv1alpha1.GetStockFundamentalsResponse{StockCode: "BHP", Periods: periods}}
	_, out, err := getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP", Limit: 3})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotFundamentals.GetLimit() != fundamentalsHandlerCeiling {
		t.Errorf("read limit = %d, want the handler ceiling %d", src.gotFundamentals.GetLimit(), fundamentalsHandlerCeiling)
	}
	if len(out.Periods) != 3 {
		t.Fatalf("got %d periods, want 3", len(out.Periods))
	}
	for _, p := range out.Periods {
		if p.PeriodType == "quarter" {
			t.Errorf("a balance snapshot came back without being asked for: %+v", p)
		}
	}

	// Asked for, they come back, and the read limit is the caller's.
	_, out, err = getStockFundamentalsHandler(src)(context.Background(), nil, GetStockFundamentalsInput{Code: "BHP", PeriodType: "quarter", Limit: 2})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotFundamentals.GetLimit() != 2 || src.gotFundamentals.GetPeriodType() != "quarter" {
		t.Errorf("request = %+v", src.gotFundamentals)
	}
	if len(out.Periods) == 0 || out.Periods[0].PeriodType != "quarter" {
		t.Errorf("quarter rows asked for: %+v", out.Periods)
	}
}
