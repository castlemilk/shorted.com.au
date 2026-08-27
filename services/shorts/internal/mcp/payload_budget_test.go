package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// maxToolResultBytes is the per-call budget. A tool result is pasted verbatim
// into a model's context window, so an uncapped tool does not fail loudly — it
// quietly spends someone else's budget. Measured at each tool's DEFAULT limit
// against a deliberately worst-case source (every list full, every prose field
// over the truncation limit, a MAX-period series of 2,500 observations).
//
// 16KB leaves roughly 40% headroom over today's largest (get_industry_treemap
// at its 150-row cap). If this trips, fix the cap, do not raise the budget.
const maxToolResultBytes = 16 * 1024

// Drives every tool through a real in-memory MCP client session, so the number
// measured is the actual tools/call payload rather than an estimate of it.
func TestToolResultsStayWithinTheirPayloadBudget(t *testing.T) {
	src := realisticSource()

	ctx := context.Background()
	server := NewServer(src)
	client := sdk.NewClient(&sdk.Implementation{Name: "size", Version: "0"}, nil)
	ct, st := sdk.NewInMemoryTransports()
	ss, err := server.Connect(ctx, st, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { _ = ss.Close() })
	sess, err := client.Connect(ctx, ct, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = sess.Close() })

	calls := []struct {
		name string
		args map[string]any
	}{
		{"get_stock", map[string]any{"code": "BHP"}},
		{"list_top_shorts", map[string]any{}},
		{"get_industry_treemap", map[string]any{}},
		{"get_market_snapshot", map[string]any{"date": "2026-08-01"}},
		{"list_squeeze_candidates", map[string]any{}},
		{"get_stock_history", map[string]any{"code": "PLS", "period": "MAX"}},
		{"get_stock_details", map[string]any{"code": "BHP"}},
		{"get_director_trades", map[string]any{"code": "BHP"}},
		{"get_peer_comparison", map[string]any{"code": "PLS"}},
	}
	for _, c := range calls {
		res, err := sess.CallTool(ctx, &sdk.CallToolParams{Name: c.name, Arguments: c.args})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if res.IsError {
			t.Fatalf("%s returned a tool error: %v", c.name, res.Content)
		}
		b, _ := json.Marshal(res)
		t.Logf("%-26s %6d bytes (%.1f KB)", c.name, len(b), float64(len(b))/1024)
		if len(b) > maxToolResultBytes {
			t.Errorf("%s returned %d bytes, over the %d-byte budget — tighten its cap rather than raising the budget",
				c.name, len(b), maxToolResultBytes)
		}
	}

	// Also size the tools/list payload. Every client pays it once per session,
	// before any question is asked, so it is a floor on the cost of connecting.
	lst, err := sess.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(lst)
	t.Logf("%-26s %6d bytes (%.1f KB) for %d tools", "tools/list", len(b), float64(len(b))/1024, len(lst.Tools))
}

func realisticSource() *fakeDataSource {
	src := &fakeDataSource{}

	src.stock = &stocksv1alpha1.Stock{
		ProductCode: "BHP", Name: "BHP GROUP LIMITED", Industry: "Metals & Mining",
		PercentageShorted: 1.25, ReportedShortPositions: 63_000_000, TotalProductInIssue: 5_040_000_000,
	}

	// 20 stocks (default limit), summary_only shape.
	ts := make([]*stocksv1alpha1.TimeSeriesData, 0, 20)
	for i := 0; i < 20; i++ {
		ts = append(ts, &stocksv1alpha1.TimeSeriesData{
			ProductCode: fmt.Sprintf("PL%d", i%10), Name: "PILBARA MINERALS LIMITED",
			Industry: "Metals & Mining", LatestShortPosition: 19.4 - float64(i)/3,
		})
	}
	src.topShorts = &shortsv1alpha1.GetTopShortsResponse{TimeSeries: ts}

	// The cap: 150 rows.
	rows := make([]*stocksv1alpha1.TreemapShortPosition, 0, 200)
	for i := 0; i < 200; i++ {
		rows = append(rows, &stocksv1alpha1.TreemapShortPosition{
			Industry: "Metals & Mining", ProductCode: fmt.Sprintf("AB%d", i%10), ShortPosition: 4.321,
		})
	}
	src.treeMap = &stocksv1alpha1.IndustryTreeMap{
		Industries: []string{"Metals & Mining", "Energy", "Consumer Discretionary", "Financials",
			"Health Care", "Information Technology", "Real Estate", "Industrials", "Utilities", "Materials"},
		Stocks: rows,
	}

	// 25 stocks (default limit).
	snap := make([]*stocksv1alpha1.Stock, 0, 25)
	for i := 0; i < 25; i++ {
		snap = append(snap, &stocksv1alpha1.Stock{
			ProductCode: fmt.Sprintf("XY%d", i%10), Name: "SOME AUSTRALIAN COMPANY LIMITED",
			Industry: "Consumer Discretionary", PercentageShorted: 12.34,
			ReportedShortPositions: 45_123_456, TotalProductInIssue: 5_012_345_678,
		})
	}
	src.marketByDate = &shortsv1alpha1.GetMarketByDateResponse{
		Date: "2026-08-01", Stocks: snap, TotalCount: 812,
		PreviousDate: "2026-07-31", NextDate: "2026-08-04",
	}

	// 20 candidates (default limit).
	bg := make([]*shortsv1alpha1.BattlegroundStock, 0, 20)
	for i := 0; i < 20; i++ {
		bg = append(bg, &shortsv1alpha1.BattlegroundStock{
			StockCode: fmt.Sprintf("SQ%d", i%10), CompanyName: "PILBARA MINERALS LIMITED",
			Industry: "Metals & Mining", ShortPct: 19.4321, ShortPctChange_4W: 2.1234,
			LatestPrice: 2.3456, PriceChange_1M: 8.4321, DaysToCover: 6.2345,
			SqueezeScore: 88.5432, DivergenceScore: 71.0123, MarketCap: 7_123_456_789,
		})
	}
	src.battlegrounds = &shortsv1alpha1.GetBattlegroundStocksResponse{Stocks: bg, TotalCount: 120}

	// MAX period: ~2,500 daily observations, downsampled to <=200.
	pts := make([]*stocksv1alpha1.TimeSeriesPoint, 0, 2500)
	base := time.Date(2016, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 2500; i++ {
		pts = append(pts, &stocksv1alpha1.TimeSeriesPoint{
			Timestamp: timestamppb.New(base.AddDate(0, 0, i)), ShortPosition: 12.345678,
		})
	}
	src.stockData = &stocksv1alpha1.TimeSeriesData{
		ProductCode: "PLS", Name: "PILBARA MINERALS LIMITED", LatestShortPosition: 19.4321, Points: pts,
	}

	// Enriched profile: every prose field over the truncation limit, 40 risks,
	// 12 people — i.e. the worst realistic case.
	long := strings.Repeat("The company operates across multiple jurisdictions. ", 200)
	risks := make([]string, 40)
	for i := range risks {
		risks[i] = "Commodity price volatility could materially affect earnings."
	}
	people := make([]*stocksv1alpha1.CompanyPerson, 12)
	for i := range people {
		people[i] = &stocksv1alpha1.CompanyPerson{
			Name: "Alexandra Fitzgerald", Role: "Chief Financial Officer", Bio: long,
			ImageGcsUrl: "https://storage.googleapis.com/shorted/people/x.png",
		}
	}
	src.stockDetails = &stocksv1alpha1.StockDetails{
		ProductCode: "BHP", CompanyName: "BHP GROUP LIMITED", Industry: "Metals & Mining",
		Website: "https://www.bhp.com", Address: "171 Collins Street, Melbourne VIC 3000",
		Summary: long, EnhancedSummary: long, CompanyHistory: long,
		CompetitiveAdvantages: long, RecentDevelopments: long,
		RiskFactors: risks, KeyPeople: people,
		Tags: []string{"mining", "iron-ore", "copper", "asx20", "dividend"},
	}

	// 20 trades (default limit).
	trades := make([]*shortsv1alpha1.DirectorTrade, 0, 20)
	for i := 0; i < 20; i++ {
		trades = append(trades, &shortsv1alpha1.DirectorTrade{
			StockCode: "BHP", DirectorName: "Alexandra Fitzgerald", TradeType: "buy",
			SharesTraded: 12_000, PricePerShare: 44.10, TotalValue: 529_200,
			TradeDate:       "2026-06-14",
			AnnouncementUrl: "https://www.asx.com.au/asxpdf/20260614/pdf/06abcdefghij.pdf",
		})
	}
	src.directorTrades = &shortsv1alpha1.GetDirectorTradesResponse{Trades: trades, TotalCount: 97}

	// 5 peers (default limit).
	peers := make([]*shortsv1alpha1.PeerStock, 0, 5)
	for i := 0; i < 5; i++ {
		peers = append(peers, &shortsv1alpha1.PeerStock{
			StockCode: fmt.Sprintf("PR%d", i), CompanyName: "IGO LIMITED", Industry: "Metals & Mining",
			ShortPositionPercent: 9.2345, MarketCap: 4_123_456_789, PeRatio: 18.23,
			DividendYield: 1.12, PriceChange_1M: -3.45,
			LogoUrl: "https://storage.googleapis.com/shorted/logos/igo.png",
		})
	}
	src.peerComparison = &shortsv1alpha1.GetPeerComparisonResponse{
		Industry: "Metals & Mining",
		Subject: &shortsv1alpha1.PeerStock{
			StockCode: "PLS", CompanyName: "PILBARA MINERALS LIMITED", Industry: "Metals & Mining",
			ShortPositionPercent: 19.4321, MarketCap: 7_123_456_789, PeRatio: 22.1, DividendYield: 0.9,
			PriceChange_1M: 8.43,
		},
		Peers: peers,
	}

	return src
}
