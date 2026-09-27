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
	for _, want := range []string{"No reported fundamentals", "XYZ", "half-yearly"} {
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
// revenue as AUD or reads a missing quarter as a bad one.
func TestGetStockFundamentalsDescriptionCarriesItsCaveats(t *testing.T) {
	for _, want := range []string{"REPORTING currency", "USD", "same series", "absent, never zero",
		"half-yearly", "quarterly", "market data provider", "not estimates or financial advice"} {
		if !strings.Contains(getStockFundamentalsDescription, want) {
			t.Errorf("description missing %q", want)
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
