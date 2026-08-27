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
		{"search_stocks", map[string]any{"query": "minerals"}},
		{"screen_stocks", map[string]any{"min_short_pct": 5.0}},
		{"get_stock_news", map[string]any{"code": "PLS"}},
		{"list_reports", map[string]any{}},
		{"get_report", map[string]any{"slug": "2026-W23"}},
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

	realisticDiscoverySource(src)
	return src
}

// realisticDiscoverySource fills the search/screener/news/reports fixtures, each
// at the DEFAULT limit of its tool and with every bounded field over its cap —
// the worst case a real call can produce.
func realisticDiscoverySource(src *fakeDataSource) {
	// 10 matches (default limit).
	matches := make([]*stocksv1alpha1.Stock, 0, 10)
	for i := 0; i < 10; i++ {
		matches = append(matches, &stocksv1alpha1.Stock{
			ProductCode: fmt.Sprintf("MN%d", i), Name: "PILBARA MINERALS LIMITED",
			Industry: "Metals & Mining", PercentageShorted: 19.4321,
			LogoUrl: "https://storage.googleapis.com/shorted/logos/pls.png",
		})
	}
	src.searchStocks = &shortsv1alpha1.SearchStocksResponse{Query: "minerals", Stocks: matches, Count: 10}

	// 20 screened rows (default limit).
	screened := make([]*shortsv1alpha1.ScreenerStock, 0, 20)
	for i := 0; i < 20; i++ {
		screened = append(screened, &shortsv1alpha1.ScreenerStock{
			StockCode: fmt.Sprintf("SC%d", i), CompanyName: "PILBARA MINERALS LIMITED",
			Industry: "Metals & Mining", ShortPct: 19.4321, ShortPctChange_4W: 2.1234,
			LatestPrice: 2.3456, PriceChange_1M: 8.4321, LatestVolume: 12_345_678,
			MarketCap: 7_123_456_789, PeRatio: 22.1234, DividendYield: 0.9123,
			NetDirectorBuyValue: 1_234_567, DirectorBuyCount: 3, DirectorSellCount: 1,
			NewsCount_30D: 14, AvgSentiment: 0.4321, PriceSensitiveCount: 2,
			Trailing_12MDividend: 0.21, AvgFrankingPct: 100, DaysToCover: 6.2345,
			AvgVolume_20D: 11_222_333,
			LogoUrl:       "https://storage.googleapis.com/shorted/logos/pls.png",
		})
	}
	src.screenStocks = &shortsv1alpha1.ScreenStocksResponse{Stocks: screened, TotalCount: 812}

	// 10 articles (default limit), every summary over the truncation limit.
	longSummary := strings.Repeat("Lithium spodumene prices firmed again in the September quarter. ", 40)
	articles := make([]*shortsv1alpha1.NewsArticle, 0, 10)
	for i := 0; i < 10; i++ {
		articles = append(articles, &shortsv1alpha1.NewsArticle{
			Id: "1f2e3d4c-5b6a-7980-1234-567890abcdef", StockCode: "PLS", Source: "stockhead",
			Headline:  "Pilbara Minerals lifts FY27 guidance as spodumene prices firm",
			Url:       "https://stockhead.com.au/resources/pilbara-minerals-lifts-fy27-guidance/",
			Sentiment: "positive", RelevanceScore: 0.9234, IsPriceSensitive: true,
			Summary: longSummary, PublishedAt: timestamppb.New(time.Date(2026, 8, 20, 3, 4, 5, 0, time.UTC)),
			ImageUrl:         "https://stockhead.com.au/wp-content/uploads/2026/08/hero.jpg",
			Tags:             []string{"lithium", "guidance", "resources"},
			SyndicationCount: 4, SyndicatedSources: []string{"afr", "livewire", "motleyfool"},
		})
	}
	src.stockNews = &shortsv1alpha1.GetStockNewsResponse{Articles: articles, TotalCount: 143}

	// 12 reports (default limit), every standfirst over the truncation limit.
	longStandfirst := strings.Repeat("Short interest across the ASX rose for a third straight week. ", 20)
	reports := make([]*shortsv1alpha1.ReportListItem, 0, 12)
	for i := 0; i < 12; i++ {
		reports = append(reports, &shortsv1alpha1.ReportListItem{
			Slug: fmt.Sprintf("2026-W%02d", i+10), ReportType: "weekly",
			Headline: "Lithium shorts build for a third straight week",
			Summary:  longStandfirst, ReportDate: "2026-06-05",
			MaxShortPct: 19.4321, MaxShortCode: "PLS", TotalStocksShorted: 812,
			QualityScore: 0.8765,
			TopCodes:     []string{"PLS", "PDN", "IEL", "SYA", "LTR"},
			TopLogoUrls:  []string{"https://x/pls.png", "https://x/pdn.png", "https://x/iel.png", "https://x/sya.png", "https://x/ltr.png"},
		})
	}
	src.listReports = &shortsv1alpha1.ListReportsResponse{Reports: reports}

	// A full report: every narrative section over the truncation limit, every
	// repeated section over its cap.
	longSection := strings.Repeat("Short interest across the resources sector rose again this week. ", 100)
	topShorted := make([]*shortsv1alpha1.WeeklyReportStock, 0, 40)
	for i := 0; i < 40; i++ {
		topShorted = append(topShorted, &shortsv1alpha1.WeeklyReportStock{
			Rank: int32(i + 1), Code: fmt.Sprintf("TS%d", i%10), Name: "PILBARA MINERALS LIMITED",
			ShortPct: 19.4321, WowChange: 1.2345, DaysToCover: 6.2345, IsNewEntrant: i%3 == 0,
			Industry: "Metals & Mining", LogoUrl: "https://x/pls.png",
			History: []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13},
		})
	}
	movers := make([]*shortsv1alpha1.WeeklyReportMover, 0, 30)
	for i := 0; i < 30; i++ {
		movers = append(movers, &shortsv1alpha1.WeeklyReportMover{
			Code: fmt.Sprintf("MV%d", i%10), Name: "PALADIN ENERGY LTD", CurrentPct: 12.3456,
			PreviousPct: 10.1234, Change: 2.2222, DaysToCover: 4.5678, ZScore: 1.9876,
			StreakWeeks: 3, Industry: "Energy", LogoUrl: "https://x/pdn.png",
			History: []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13},
		})
	}
	industries := make([]*shortsv1alpha1.WeeklyIndustryStat, 0, 25)
	for i := 0; i < 25; i++ {
		industries = append(industries, &shortsv1alpha1.WeeklyIndustryStat{
			Industry: "Consumer Discretionary", AvgShortPct: 3.2345, WowChange: 0.1234,
			StockCount: 87, TopStockCode: "JBH", TopStockPct: 9.8765,
		})
	}
	citations := make([]*shortsv1alpha1.WeeklyReportCitation, 0, 25)
	for i := 0; i < 25; i++ {
		citations = append(citations, &shortsv1alpha1.WeeklyReportCitation{
			Id: fmt.Sprintf("ref-%d", i), Source: "Pilbara Minerals H1 FY2026 Results",
			Date: "2026-02-20", Url: "https://www.asx.com.au/asxpdf/20260220/pdf/06abcdefghij.pdf",
			Type: "financial_report",
		})
	}
	faqs := make([]*shortsv1alpha1.WeeklyReportFAQ, 0, 8)
	for i := 0; i < 8; i++ {
		faqs = append(faqs, &shortsv1alpha1.WeeklyReportFAQ{
			Question: "What does a rising short position mean?", Answer: longSection,
		})
	}
	src.weeklyReport = &shortsv1alpha1.GetWeeklyReportResponse{
		WeekSlug: "2026-W23", Headline: "Lithium shorts build for a third straight week",
		Summary: longStandfirst, ReportDate: "2026-06-05", PreviousDate: "2026-05-29",
		Narrative: &shortsv1alpha1.WeeklyNarrative{
			OpeningHook: longSection, TopAnalysis: longSection, MoversAnalysis: longSection,
			IndustryAnalysis: longSection, Outlook: longSection,
		},
		TopShorted: topShorted, Risers: movers, Fallers: movers, Faqs: faqs,
		QualityScore:      0.8765,
		IndustryBreakdown: industries, Citations: citations,
		MarketStats: &shortsv1alpha1.WeeklyMarketStats{
			TotalStocksShorted: 812, AvgShortPct: 2.1234, MaxShortPct: 19.4321,
			MaxShortCode: "PLS", WowAvgChange: 0.0456, MedianShortPct: 1.2345,
			StocksAbove_10Pct: 41, StocksAbove_5Pct: 128, RiserCount: 412, FallerCount: 388,
		},
	}
}
