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
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
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
//
// The budget applies to each REPRESENTATION, not to the two together, because
// a client hands its model one of them: Claude Code reads structuredContent,
// claude.ai reads content. content is the summary plus the same JSON (see
// structuredContentAsText), so it is always the larger of the two.
const maxToolResultBytes = 16 * 1024

// Drives every tool through a real in-memory MCP client session, so the number
// measured is the actual tools/call payload rather than an estimate of it.
func TestToolResultsStayWithinTheirPayloadBudget(t *testing.T) {
	src := realisticSource()

	ctx := context.Background()
	sess := connectToolSession(t, src)

	// The call table lives in nonfinite_test.go as toolCallFixtures() so this
	// budget and the non-finite guard drive the SAME set of calls, and
	// TestToolCallFixturesCoverTheRegistry proves that set is every tool. Two
	// hand-maintained lists would drift, and the tool omitted from one is
	// exactly the tool nobody measured.
	calls := toolCallFixtures()
	for _, c := range calls {
		res, err := sess.CallTool(ctx, &sdk.CallToolParams{Name: c.name, Arguments: c.args})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if res.IsError {
			t.Fatalf("%s returned a tool error: %v", c.name, res.Content)
		}
		structured, _ := json.Marshal(res.StructuredContent)
		content := contentTextBytes(res)
		t.Logf("%-26s content %6d bytes (%.1f KB), structuredContent %6d bytes",
			c.name, content, float64(content)/1024, len(structured))
		for _, rep := range []struct {
			name string
			size int
		}{{"content", content}, {"structuredContent", len(structured)}} {
			if rep.size > maxToolResultBytes {
				t.Errorf("%s returned %d bytes of %s, over the %d-byte budget — tighten its cap rather than raising the budget",
					c.name, rep.size, rep.name, maxToolResultBytes)
			}
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
	for i := range 20 {
		ts = append(ts, &stocksv1alpha1.TimeSeriesData{
			ProductCode: fmt.Sprintf("PL%d", i%10), Name: "PILBARA MINERALS LIMITED",
			Industry: "Metals & Mining", LatestShortPosition: 19.4 - float64(i)/3,
		})
	}
	src.topShorts = &shortsv1alpha1.GetTopShortsResponse{TimeSeries: ts}

	// The cap: 150 rows.
	rows := make([]*stocksv1alpha1.TreemapShortPosition, 0, 200)
	for i := range 200 {
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
	for i := range 25 {
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
	for i := range 20 {
		bg = append(bg, &shortsv1alpha1.BattlegroundStock{
			StockCode: fmt.Sprintf("SQ%d", i%10), CompanyName: "PILBARA MINERALS LIMITED",
			Industry: "Metals & Mining", ShortPct: 19.4321, ShortPctChange_4W: 2.1234,
			LatestPrice: 2.3456, PriceChange_1M: 8.4321, DaysToCover: 6.2345,
			SqueezeScore: 88.5432, DivergenceScore: 71.0123, MarketCap: 7_123_456_789,
		})
	}
	src.battlegrounds = &shortsv1alpha1.GetBattlegroundStocksResponse{Stocks: bg, TotalCount: 120}

	// MAX period: ~2,500 daily observations, downsampled to <=200. Every point
	// carries its raw count and denominator too — those are returned on every
	// point in production, so a fixture omitting them would measure a payload
	// no caller receives and leave the real one unbudgeted.
	pts := make([]*stocksv1alpha1.TimeSeriesPoint, 0, 2500)
	base := time.Date(2016, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := range 2500 {
		pts = append(pts, &stocksv1alpha1.TimeSeriesPoint{
			Timestamp: timestamppb.New(base.AddDate(0, 0, i)), ShortPosition: 12.345678,
			ReportedShortPositions: 637_919_240.5, TotalProductInIssue: 5_084_182_500.75,
			AvailableFrom: base.AddDate(0, 0, i+6).Format("2006-01-02"),
		})
	}
	src.stockData = &stocksv1alpha1.TimeSeriesData{
		ProductCode: "PLS", Name: "PILBARA MINERALS LIMITED", LatestShortPosition: 19.4321, Points: pts,
	}

	// The same worst case for prices: a MAX window of daily sessions, thinned
	// to the default cap (maxPricePoints).
	prices := make([]*shortsv1alpha1.StockPricePoint, 0, 2500)
	for i := range 2500 {
		prices = append(prices, &shortsv1alpha1.StockPricePoint{
			Date: base.AddDate(0, 0, i).Format("2006-01-02"),
			Open: 41.234567, High: 42.345678, Low: 40.123456,
			Close: 41.987654, AdjustedClose: 39.876543, Volume: 12_345_678,
		})
	}
	src.stockPrices = &shortsv1alpha1.GetStockPricesResponse{
		ProductCode: "PLS", Name: "PILBARA MINERALS LIMITED", Currency: "AUD", Points: prices,
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
	for range 20 {
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
	for i := range 5 {
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
	realisticStrategySource(src)
	realisticBriefingSource(src)
	realisticHousingSource(src)
	realisticEconomySource(src)
	realisticPoliticsSource(src)
	realisticOwnershipSource(src)
	return src
}

// realisticOwnershipSource fills the ownership fixtures past every cap, with
// the longest names production holds: a holder named with its annexure ("FMR
// LLC and its entities listed in Annexure A"), a super option named for its
// fund, and the 100 fund rows the API serves for one institution. Rows past
// the caps cost nothing, so the expensive case is a full page of the longest.
func realisticOwnershipSource(src *fakeDataSource) {
	holding := func(i int) *shortsv1alpha1.SubstantialHolding {
		return &shortsv1alpha1.SubstantialHolding{
			StockCode: "PLS", CompanyName: "Pilbara Minerals Limited", Industry: "Materials",
			HolderKey: "state-street", HolderName: "FMR LLC and its entities listed in Annexure A and Annexure B",
			InstitutionSlug: "state-street", Kind: "active_manager", Form: "604",
			VotingPowerPct: 12.3456, PreviousPct: 11.2345, HasPrevious: true, Votes: 398_765_432, HasVotes: true,
			EventDate: "2026-10-16", AnnouncedOn: "2026-10-20",
			AnnouncementUrl: fmt.Sprintf("https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=0300%04d", i),
		}
	}
	fund := func(i int) *shortsv1alpha1.FundHolding {
		return &shortsv1alpha1.FundHolding{
			InstitutionSlug: "australian-retirement-trust", InstitutionName: "Australian Retirement Trust",
			Kind: "super_fund", FundName: "Balanced (Lifecycle Investment Strategy, Accumulation)",
			FundCode: "", SourceKind: "super_phd", AsAt: "2026-06-30",
			StockCode: "PLS", CompanyName: "Pilbara Minerals Limited",
			Units: 123_456_789, HasUnits: true, ValueAud: float64(9_876_543_210 - i), HasValue: true,
			WeightPct: 2.345678, HasWeight: true, PctOfIssued: 1.234567, HasPctOfIssued: true,
		}
	}
	holders := make([]*shortsv1alpha1.SubstantialHolding, 0, maxOwnershipHolders+10)
	for i := range maxOwnershipHolders + 10 {
		holders = append(holders, holding(i))
	}
	funds := make([]*shortsv1alpha1.FundHolding, 0, 40)
	for i := range 40 {
		funds = append(funds, fund(i))
	}
	kinds := []*shortsv1alpha1.KindShare{}
	for _, k := range []string{"super_fund", "index_manager", "hedge_fund", "active_manager", "bank_broker",
		"sovereign_public", "insurer", "private_equity", "corporate", "unclassified"} {
		kinds = append(kinds, &shortsv1alpha1.KindShare{Kind: k, Pct: 5.4321, Holders: 3})
	}
	src.stockOwnership = &shortsv1alpha1.GetStockOwnershipResponse{
		Summary: &shortsv1alpha1.OwnershipStock{
			StockCode: "PLS", CompanyName: "Pilbara Minerals Limited", Industry: "Materials",
			Holders: int32(len(holders)), DisclosedPct: 54.321, ByKind: kinds,
			ShortPct: 13.0833, HasShortPct: true, IndexPct: 3.0129, HasIndexPct: true,
			SuperOptions: 11, SuperValueAud: 579_467_732.02, HasSuperValue: true,
			MarketCap: 9_581_061_901, HasMarketCap: true,
		},
		Holders: holders, FundHoldings: funds,
		SharesOnIssue: 3_225_946_768, HasSharesOnIssue: true,
	}

	positions := make([]*shortsv1alpha1.SubstantialHolding, 0, 119)
	for i := range 119 {
		positions = append(positions, holding(i))
	}
	instFunds := make([]*shortsv1alpha1.FundHolding, 0, 100)
	for i := range 100 {
		instFunds = append(instFunds, fund(i))
	}
	src.institution = &shortsv1alpha1.GetInstitutionResponse{
		Institution: &shortsv1alpha1.OwnershipInstitution{
			Slug: "state-street", Name: "State Street", Kind: "index_manager", Country: "US",
			Website:     "https://www.ssga.com/au",
			Description: strings.Repeat("State Street Global Advisors (SPDR ETFs, STW) and State Street Bank, a large custodian and agent lender. ", 8),
			AumAud:      412_301_040_000, HasAum: true,
			SubstantialPositions: 119, Notices: 1117, LatestNoticeDate: "2026-10-20",
			Funds: 19, FundsSizeAud: 12_573_950_000, HasFundsSize: true,
		},
		Positions: positions, FundHoldings: instFunds,
	}
	src.institutions = &shortsv1alpha1.ListInstitutionsResponse{
		Institutions: []*shortsv1alpha1.OwnershipInstitution{
			{Slug: "state-street", Name: "State Street", Kind: "index_manager"},
			{Slug: "australiansuper", Name: "AustralianSuper", Kind: "super_fund"},
			{Slug: "aware-super", Name: "Aware Super", Kind: "super_fund"},
		},
		Total: 3,
	}
}

// realisticStrategySource fills the strategy and fundamentals fixtures at each
// tool's CEILING rather than its default, because both have a worst case one
// ordinary call can reach:
//
//   - list_strategies from the REAL registry, so a strategy gaining a rule or
//     a longer tagline is measured here without anyone remembering to.
//   - get_strategy_picks at 25 picks of the widest strategy (7 rules), every
//     pick a watch-status row that passes ONE rule and fails or cannot
//     evaluate the rest, each with an evidence sentence over the truncation
//     limit, and every pick carrying a full fundamentals block whose growth
//     figures both came from a filing. That is the row the evidence allowance
//     exists for; a triggered row fails at most one or two rules and costs
//     far less.
//   - get_stock_fundamentals at its 24-period ceiling with every figure
//     reported, a two-key field_sources map on every period, a full quality
//     block (every ratio AND the not-meaningful list, which the API never
//     sends together, so this over-counts), coverage and a latest filing.
func realisticStrategySource(src *fakeDataSource) {
	regime := &shortsv1alpha1.MarketRegime{
		IndexCode: "XJO", AsOf: "2026-09-25", Regime: "downtrend",
		Close: 8_123.45, Sma50: 8_234.56, Sma200: 8_345.67, PctOff_52WHigh: -7.1234,
		Verdict: "Stand aside: XJO is below its 200-day average. Breakouts fail more often in a falling market, " +
			"so no stock can trigger until the trend turns.",
	}

	registry := strategies.Registry()
	list := make([]*shortsv1alpha1.Strategy, 0, len(registry))
	widest := registry[0]
	for _, st := range registry {
		if len(st.Rules) > len(widest.Rules) {
			widest = st
		}
		list = append(list, strategyFixture(st))
	}
	src.strategies = &shortsv1alpha1.ListStrategiesResponse{Strategies: list, Regime: regime}

	evidence := "Close A$12.34, 150-day A$13.45, 200-day A$14.56: close is not above the 150-day; " +
		"150-day is not above the 200-day, and the 200-day has fallen for a month"
	picks := make([]*shortsv1alpha1.StrategyPick, 0, maxStrategyPicksLimit)
	for i := range maxStrategyPicksLimit {
		rules := make([]*shortsv1alpha1.RuleResult, 0, len(widest.Rules))
		for j, r := range widest.Rules {
			status := "fail"
			switch {
			case j == len(widest.Rules)-1:
				status = "pass"
			case j == 0:
				status = "unknown"
			}
			rules = append(rules, &shortsv1alpha1.RuleResult{
				RuleId: r.ID, Status: status, Detail: evidence, Value: 12.3456, HasValue: true,
			})
		}
		picks = append(picks, &shortsv1alpha1.StrategyPick{
			Rank: int32(i + 1), StockCode: fmt.Sprintf("PK%02d", i), CompanyName: "PILBARA MINERALS LIMITED",
			Industry: "Metals & Mining", Status: "watch", Score: 41.2345, Rules: rules,
			Close: 12.3456, AsOf: "2026-09-25", PctOff_52WHigh: -31.2345, VolumeRatio_50D: 1.8765,
			BaseDepthPct: 18.7654, BaseLengthDays: 87, Pivot: 14.5678,
			RevenueYoyPct: 41.2345, HasRevenueYoy: true, EpsYoyPct: -12.3456, HasEpsYoy: true,
			Rs_3MPct: -8.7654, ShortPct: 6.5432, MarketCap: 7_123_456_789,
			HasClose: true, HasRs_3MPct: true, HasShortPct: true, HasMarketCap: true,
			LogoUrl:      "https://storage.googleapis.com/shorted/logos/pls.png",
			Fundamentals: pickFundamentalsFixture(),
		})
	}
	src.strategyPicks = &shortsv1alpha1.GetStrategyPicksResponse{
		Strategy: strategyFixture(widest), Regime: regime, Picks: picks,
		TotalCount: 212, UniverseCount: 1_234, FundamentalsCoverageCount: 987, FundamentalsRowsCount: 1_101,
		AsOf: "2026-09-25",
	}

	// More periods than the tool publishes: the fake ignores the limit, so the
	// handler's own cap is what is measured.
	periods := make([]*shortsv1alpha1.FundamentalsPeriod, 0, maxFundamentalsLimit+16)
	types := []string{"annual", "half", "ttm"}
	for i := range maxFundamentalsLimit + 16 {
		periods = append(periods, fullFundamentalsPeriod(types[i%3], fmt.Sprintf("20%02d-06-30", 26-i/3), int32(2026-i/3)))
	}
	src.fundamentals = &shortsv1alpha1.GetStockFundamentalsResponse{
		StockCode: "BHP", Periods: periods, HasGrowth: true,
		Growth: &shortsv1alpha1.FundamentalsGrowth{
			BasisPeriodType: "ttm", LatestPeriodEnd: "2026-06-30",
			RevenueYoyPct: 41.2345, HasRevenueYoy: true, RevenueYoyPriorPct: 12.3456, HasRevenueYoyPrior: true,
			EpsYoyPct: 55.4321, HasEpsYoy: true, EpsYoyPriorPct: 20.9876, HasEpsYoyPrior: true,
			NetIncomePositive: true, PeriodsAvailable: 40,
			RevenueTtm: 55_658_123_456.78, HasRevenueTtm: true, NetIncomeTtm: 12_345_678_901.23, HasNetIncomeTtm: true,
			EpsTtm: 2.345678, HasEpsTtm: true,
			RevenueBasisPeriodType: "half", HalfLatestPeriodEnd: "2026-06-30",
			RevenueHalfYoyPct: 38.7654, HasRevenueHalfYoy: true, EpsHalfYoyPct: 61.2345, HasEpsHalfYoy: true,
			RevenueBasisSource: "filing", EpsBasisSource: "filing", FetchedAt: "2026-09-26T08:12:34Z",
			RevenueLatestPeriodEnd: "2026-06-30", RevenuePriorPeriodEnd: "2025-06-30",
		},
		HasQuality: true,
		Quality: &shortsv1alpha1.FundamentalsQuality{
			BasisPeriodType: "ttm", BasisPeriodEnd: "2026-06-30", Currency: "AUD", BalancePeriodEnd: "2025-12-31",
			GrossMarginPct: 48.1234, HasGrossMarginPct: true, OperatingMarginPct: 31.2345, HasOperatingMarginPct: true,
			NetMarginPct: -22.1234, HasNetMarginPct: true, FcfMarginPct: 17.7654, HasFcfMarginPct: true,
			FcfConversion: 0.812345, HasFcfConversion: true, RoePct: 23.4567, HasRoePct: true,
			RoaPct: 11.2345, HasRoaPct: true, NetDebt: -12_345_678_901.23, HasNetDebt: true,
			NetDebtToEbitda: 0.412345, HasNetDebtToEbitda: true, NetDebtToEquity: 0.212345, HasNetDebtToEquity: true,
			CurrentRatio: 1.712345, HasCurrentRatio: true, InterestCover: 123.4567, HasInterestCover: true,
			PayoutRatioPct: 61.2345, HasPayoutRatioPct: true,
			IsFinancial: true, Source: "yahoo-timeseries", OperatingCashFlowDerived: true,
			MarketCap: 331_234_567_890.12, HasMarketCap: true, PeRatio: 14.23456, HasPeRatio: true,
			PriceToBook: 3.123456, HasPriceToBook: true, PriceAsOf: "2026-09-25", BalanceCurrency: "USD",
			NotMeaningful: strategies.NotMeaningfulForFinancials(), IsProperty: true, BalanceLagMonths: 6,
			SharesAsOf: "2026-06-30", PeEpsPeriodEnd: "2026-06-30", PeEpsBasis: "diluted",
			ValuationNote: "listed-unit",
		},
		Coverage: &shortsv1alpha1.FundamentalsCoverage{
			Status: "covered", LastAttemptAt: "2026-09-26T08:12:34Z", LastSuccessAt: "2026-09-26T08:12:34Z",
			Sources: []string{"yahoo-timeseries", "markit-key-statistics", "asx-filing-extraction"},
		},
		HasLatestFiling: true,
		LatestFiling: &shortsv1alpha1.LatestFilingSummary{
			ReportUrl:   "https://www.asx.com.au/asxpdf/20260819/pdf/06abcdefghij.pdf",
			ReportTitle: "Appendix 4E and Annual Report 2026", ReportDate: "2026-08-19",
			PeriodEnd: "2026-06-30", PeriodType: "annual",
			Digest:           strings.Repeat("Underlying EBITDA rose on higher copper volumes. ", 20),
			DigestConfidence: 0.8765,
		},
	}
}

// fullFundamentalsPeriod is one period with every statement line reported and
// a two-key field_sources map: the widest row the tool can publish.
func fullFundamentalsPeriod(periodType, periodEnd string, fiscalYear int32) *shortsv1alpha1.FundamentalsPeriod {
	return &shortsv1alpha1.FundamentalsPeriod{
		PeriodType: periodType, PeriodEnd: periodEnd, FiscalYear: fiscalYear,
		Currency: "USD", Source: "yahoo-timeseries", FetchedAt: "2026-09-26T08:12:34Z",
		Revenue: 55_658_123_456.78, HasRevenue: true, NetIncome: -12_345_678_901.23, HasNetIncome: true,
		EpsBasic: 1.234567, HasEpsBasic: true, EpsDiluted: 1.223456, HasEpsDiluted: true,
		OperatingCashFlow: 18_765_432_109.87, HasOperatingCashFlow: true,
		FreeCashFlow: 9_876_543_210.98, HasFreeCashFlow: true,
		SharesOutstanding: 5_071_234_567, HasSharesOutstanding: true,
		GrossProfit: 27_123_456_789.01, HasGrossProfit: true, OperatingIncome: -21_234_567_890.12, HasOperatingIncome: true,
		Ebitda: 28_123_456_789.01, HasEbitda: true, NormalizedEbitda: 29_123_456_789.01, HasNormalizedEbitda: true,
		Ebit: 20_123_456_789.01, HasEbit: true, InterestExpense: 1_234_567_890.12, HasInterestExpense: true,
		PretaxIncome: 19_123_456_789.01, HasPretaxIncome: true, TaxProvision: 6_123_456_789.01, HasTaxProvision: true,
		NetInterestIncome: -1_123_456_789.01, HasNetInterestIncome: true,
		CapitalExpenditure: -10_123_456_789.01, HasCapitalExpenditure: true,
		DividendsPaid: -8_123_456_789.01, HasDividendsPaid: true, ShareBuybacks: -1_123_456_789.01, HasShareBuybacks: true,
		TotalAssets: 108_123_456_789.01, HasTotalAssets: true, TotalLiabilities: 58_123_456_789.01, HasTotalLiabilities: true,
		TotalEquity: -48_123_456_789.01, HasTotalEquity: true, CashAndEquivalents: 12_123_456_789.01, HasCashAndEquivalents: true,
		TotalDebt: 22_123_456_789.01, HasTotalDebt: true, CapitalLeaseObligations: 2_123_456_789.01, HasCapitalLeaseObligations: true,
		NetDebt: -11_123_456_789.01, HasNetDebt: true, CurrentAssets: 25_123_456_789.01, HasCurrentAssets: true,
		CurrentLiabilities: 17_123_456_789.01, HasCurrentLiabilities: true,
		FieldSources: map[string]string{
			"operating_cash_flow": "derived:fcf-minus-capex",
			"net_income":          "asx-filing-extraction",
		},
		SourceDocumentUrl:  "https://www.asx.com.au/asxpdf/20260819/pdf/06abcdefghij.pdf",
		SourceDocumentDate: "2026-08-19",
	}
}

// pickFundamentalsFixture is a pick's full fundamentals block: every ratio
// reported, both growth figures from a filing (the longer source string).
func pickFundamentalsFixture() *shortsv1alpha1.PickFundamentals {
	return &shortsv1alpha1.PickFundamentals{
		RevenueBasisPeriodType: "ttm", RevenuePeriodEnd: "2026-06-30",
		EpsBasisPeriodType: "half", EpsPeriodEnd: "2026-06-30",
		Currency: "AUD", FetchedAt: "2026-09-26T08:12:34Z",
		RevenueBasisSource: "filing", EpsBasisSource: "filing",
		NetMarginPct: -22.1234, HasNetMarginPct: true, RoePct: -123.4567, HasRoePct: true,
		FcfMarginPct: 17.7654, HasFcfMarginPct: true, NetDebtToEbitda: 0.412345, HasNetDebtToEbitda: true,
		PeRatio: 14.23456, HasPeRatio: true, IsFinancial: true, NetIncomePositive: true,
		NotMeaningful: strategies.NotMeaningfulForFinancials(),
	}
}

// strategyFixture renders a registry strategy the way the handler does, prose
// and all, so the list fixture costs what production costs.
func strategyFixture(st strategies.Strategy) *shortsv1alpha1.Strategy {
	rules := make([]*shortsv1alpha1.StrategyRule, 0, len(st.Rules))
	for _, r := range st.Rules {
		rules = append(rules, &shortsv1alpha1.StrategyRule{
			Id: r.ID, Title: r.Title, RuleText: r.RuleText, Evaluation: r.Evaluation,
			Core: r.Core, DataSource: r.DataSource,
		})
	}
	return &shortsv1alpha1.Strategy{
		Id: st.ID, Name: st.Name, Author: st.Author, Tagline: st.Tagline,
		DescriptionParagraphs: st.Description, Rules: rules,
		Metadata: &shortsv1alpha1.StrategyMetadata{
			Style: st.Metadata.Style, HoldingPeriod: st.Metadata.HoldingPeriod,
			RiskPosture: st.Metadata.RiskPosture, Universe: st.Metadata.Universe,
			RefreshCadence: st.Metadata.RefreshCadence, RuleCount: int32(len(st.Rules)),
		},
		Caveats: st.Caveats, Sources: st.Sources,
	}
}

// realisticBriefingSource fills the get_stock_briefing fixtures at worst case:
// realisticBriefingSource fills the get_stock_briefing fixtures at worst case:
// 5 strategy fits, 15 dividends (to exercise the 12-cap), 10 adverse + 10
// positive signals with 150-character headlines and 300-character citations
// realisticBriefingSource fills the get_stock_briefing fixtures at worst case:
// 5 strategy fits, 15 dividends (to exercise the 12-cap), 10 adverse + 10
// positive signals with 150-character headlines and 300-character citations
// (not rendered). Latest filing digest is set in fundamentals (line 338).
func realisticBriefingSource(src *fakeDataSource) {
	// 5 strategy fits
	fits := make([]*shortsv1alpha1.StrategyFit, 0, 5)
	strategyNames := []string{"zanger-breakout", "canslim", "minervini-trend-template", "crowded-short-breakout", "quality-compounders"}
	for i, name := range strategyNames {
		fits = append(fits, &shortsv1alpha1.StrategyFit{
			StrategyId:   name,
			StrategyName: name,
			Score:        float64(70 + i*5), // 70-90% score
			Status:       "triggered",
		})
	}
	src.strategyFit = &shortsv1alpha1.GetStockStrategyFitResponse{Fits: fits}

	// 15 dividends (worst case: exceeds 12-cap)
	divs := make([]*shortsv1alpha1.DividendRecord, 0, 15)
	for i := range 15 {
		divs = append(divs, &shortsv1alpha1.DividendRecord{
			ExDate:             fmt.Sprintf("2026-%02d-15", 1+i%12),
			PaymentDate:        fmt.Sprintf("2026-%02d-28", 1+i%12),
			AmountPerShare:     0.35 + float64(i)*0.02,
			FrankingPercentage: 100.0,
		})
	}
	src.dividendHistory = &shortsv1alpha1.GetDividendHistoryResponse{Dividends: divs}

	// 10 adverse signals + 10 positive signals, each with 150-char headline
	headlineBase := strings.Repeat("X", 150)
	citationBase := strings.Repeat("A", 300)

	adverseSignals := make([]*shortsv1alpha1.StockSignal, 0, 10)
	for i := range 10 {
		date := time.Date(2026, 10, 15-i*2, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
		adverseSignals = append(adverseSignals, &shortsv1alpha1.StockSignal{
			EventDate: date,
			Polarity:  "adverse",
			Headline:  fmt.Sprintf("Adverse signal %d: %s", i+1, headlineBase),
			Citations: []string{citationBase, citationBase, citationBase},
		})
	}

	positiveSignals := make([]*shortsv1alpha1.StockSignal, 0, 10)
	for i := range 10 {
		date := time.Date(2026, 10, 10-i*2, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
		positiveSignals = append(positiveSignals, &shortsv1alpha1.StockSignal{
			EventDate: date,
			Polarity:  "positive",
			Headline:  fmt.Sprintf("Positive signal %d: %s", i+1, headlineBase),
			Citations: []string{citationBase, citationBase, citationBase},
		})
	}

	src.stockSignals = &shortsv1alpha1.GetStockSignalsResponse{Adverse: adverseSignals, Positive: positiveSignals}
}

// realisticPoliticsSource fills the register fixtures at each tool's worst
// case: a full search page, a member well past the declaration cap with the
// longest declared text APH actually publishes (item 3 real-estate rows run to
// a couple of hundred characters), and a company declared by every member the
// stock tool will return. The declared text is what makes these expensive and
// is exactly what may not be shortened, so the cap on ROW COUNT is the only
// lever the budget has.
func realisticPoliticsSource(src *fakeDataSource) {
	declared := "Residential investment property, jointly held with spouse, in the suburb of " +
		"Wagga Wagga, New South Wales (acquired prior to entering Parliament; mortgage held with a " +
		"major Australian bank)"
	person := func(i int) *shortsv1alpha1.Politician {
		return &shortsv1alpha1.Politician{
			Slug: fmt.Sprintf("alexandra-fitzgerald-%d", i), DisplayName: "Alexandra Fitzgerald",
			Chamber: "senate", Division: "Corangamite", StateCode: "NSW",
			Party: "Australian Labor Party", PartyAb: "ALP",
			DeclaredListedCount: 27, DeclaredPropertyCount: 4,
			PhotoUrl:     "https://upload.wikimedia.org/wikipedia/commons/a/ab/Alexandra_Fitzgerald.jpg",
			PhotoLicence: "CC BY-SA 4.0", PhotoAuthor: "A Commons Photographer",
			PhotoSourceUrl: "https://commons.wikimedia.org/wiki/File:Alexandra_Fitzgerald.jpg",
		}
	}
	interest := func() *shortsv1alpha1.DeclaredInterest {
		return &shortsv1alpha1.DeclaredInterest{
			ItemNo: 3, ItemLabel: "Real estate", EntityKind: "not_an_entity",
			Holder:       shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_SPOUSE_PARTNER,
			DeclaredText: declared, SecondaryText: "Investment", StockCode: "BHP",
			CompanyName: "BHP GROUP LIMITED", Industry: "Metals & Mining",
			SuburbName: "Wagga Wagga", PropertyState: "NSW",
			DeclaredFrom:      timestamppb.New(time.Date(2022, 6, 1, 0, 0, 0, 0, time.UTC)),
			DeclaredFromKnown: true, CurrentlyDeclared: true,
			SourceUrl: "https://www.aph.gov.au/-/media/03_Senators_and_Members/registerofinterests.pdf",
		}
	}

	people := make([]*shortsv1alpha1.Politician, 0, maxPoliticianSearchLimit)
	for i := range maxPoliticianSearchLimit {
		people = append(people, person(i))
	}
	src.listPoliticians = &shortsv1alpha1.ListPoliticiansResponse{Politicians: people, Total: 319}

	interests := make([]*shortsv1alpha1.DeclaredInterest, 0, maxRegisterInterests+20)
	for range maxRegisterInterests + 20 {
		interests = append(interests, interest())
	}
	src.politician = &shortsv1alpha1.GetPoliticianResponse{
		Politician: person(0), Interests: interests,
		ExtractedParliaments: []int32{47, 48}, PartialParliaments: []int32{46},
		PendingParliaments: []int32{44, 45},
	}

	declarations := make([]*shortsv1alpha1.StockPoliticianInterest, 0, maxStockDeclarations+10)
	for i := range maxStockDeclarations + 10 {
		declarations = append(declarations, &shortsv1alpha1.StockPoliticianInterest{
			Politician: person(i), Interest: interest(),
		})
	}
	parties := make([]*shortsv1alpha1.PartyCount, 0, 8)
	for _, ab := range []string{"ALP", "LP", "GRN", "NP", "IND", "PHON", "CLP", ""} {
		parties = append(parties, &shortsv1alpha1.PartyCount{
			PartyAb: ab, Party: "Australian Labor Party", PoliticianCount: 12,
		})
	}
	src.stockPoliticians = &shortsv1alpha1.ListStockPoliticiansResponse{
		StockCode: "BHP", CompanyName: "BHP GROUP LIMITED", PoliticianCount: 41,
		PartyCounts: parties, Interests: declarations,
	}
}

// realisticEconomySource fills the economy fixtures at each tool's worst case:
// the catalogue at its ceiling with the longest realistic keys, and
// three series each carrying the store's full 600-observation run so the
// downsample is what stands between the tool and a 30KB result.
func realisticEconomySource(src *fakeDataSource) {
	info := func(key string) *shortsv1alpha1.EconomicSeriesInfo {
		return &shortsv1alpha1.EconomicSeriesInfo{
			SeriesKey: key, Topic: "trade", Metric: "merchandise_exports_value",
			Product: "lng", RegionType: "state", RegionCode: "wa", RegionName: "Western Australia",
			Unit: "aud", Frequency: "monthly", Adjustment: "seasadj",
			SourceKey: "abs-merch-trade-state", SourceLicence: "CC-BY-4.0",
			LatestPeriod: timestamppb.New(time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC)),
		}
	}

	catalogue := make([]*shortsv1alpha1.EconomicSeriesInfo, 0, maxEconomySeriesListLimit)
	for i := range maxEconomySeriesListLimit {
		catalogue = append(catalogue, info(fmt.Sprintf("trade.merchandise_exports_value.lng.wa.seasadj.%d", i)))
	}
	src.economicSeriesList = &shortsv1alpha1.ListEconomicSeriesResponse{Series: catalogue}

	base := time.Date(1976, 1, 31, 0, 0, 0, 0, time.UTC)
	series := make([]*shortsv1alpha1.EconomicSeriesData, 0, maxEconomySeriesPerCall)
	for s := range maxEconomySeriesPerCall {
		obs := make([]*shortsv1alpha1.EconomicObservation, 0, 600)
		for i := range 600 {
			obs = append(obs, &shortsv1alpha1.EconomicObservation{
				Period: timestamppb.New(base.AddDate(0, i, 0)), Value: 12_345_678.9123,
			})
		}
		series = append(series, &shortsv1alpha1.EconomicSeriesData{
			Info:         info(fmt.Sprintf("trade.merchandise_exports_value.lng.wa.seasadj.%d", s)),
			Observations: obs,
		})
	}
	src.economicSeries = &shortsv1alpha1.GetEconomicSeriesResponse{Series: series}

	aggs := make([]*shortsv1alpha1.StateCompanyAggregate, 0, 8)
	for _, state := range []string{"nsw", "vic", "qld", "sa", "wa", "tas", "nt", "act"} {
		aggs = append(aggs, &shortsv1alpha1.StateCompanyAggregate{
			State: state, CompanyCount: 123,
			ExposureWeightedMarketCap: 812_345_678_901.23, ExposureWeightedShortPercent: 2.3456,
		})
	}
	src.stateCompanyAggregates = &shortsv1alpha1.GetStateCompanyAggregatesResponse{Aggregates: aggs}
}

// realisticHousingSource fills the housing fixtures at each tool's worst case:
// the overview at its 60-metric cap, the series at more observations than any
// real quarterly run so downsampling is exercised, and the drops board with
// every row above the k-anonymity floor (a suppressed row costs nothing, so the
// expensive case is the one where nothing is withheld).
func realisticHousingSource(src *fakeDataSource) {
	period := timestamppb.New(time.Date(2026, 3, 31, 0, 0, 0, 0, time.UTC))
	metrics := make([]*shortsv1alpha1.HousingMetric, 0, 80)
	for range 80 {
		metrics = append(metrics, &shortsv1alpha1.HousingMetric{
			RegionCode: "1GSYD", RegionName: "Greater Sydney", RegionType: "gccsa",
			StateCode: "NSW", Measure: "mean_price", DwellingType: "established_house",
			Value: 1_234_567.89, Unit: "AUD", Period: period,
			QoqPct: 1.2345, YoyPct: 4.5678, IsPreliminary: true,
		})
	}
	src.housingOverview = &shortsv1alpha1.GetHousingOverviewResponse{Metrics: metrics, AsOf: period}

	pts := make([]*shortsv1alpha1.HousePricePoint, 0, 400)
	base := time.Date(1926, 3, 31, 0, 0, 0, 0, time.UTC)
	for i := range 400 {
		pts = append(pts, &shortsv1alpha1.HousePricePoint{
			Period: timestamppb.New(base.AddDate(0, 3*i, 0)),
			Value:  1_234_567.89, IsPreliminary: i == 399,
		})
	}
	src.housePriceSeries = &shortsv1alpha1.GetHousePriceSeriesResponse{
		RegionCode: "AUS", RegionName: "Australia", Measure: "median_price",
		DwellingType: "all", Unit: "AUD", Source: "abs", SourceLicence: "CC-BY-4.0",
		Points: pts,
	}

	src.suburbProfile = &shortsv1alpha1.GetSuburbProfileResponse{
		Summary: &shortsv1alpha1.SuburbSummary{
			SalCode: "SAL21234", SalName: "Richmond", StateCode: "VIC", Postcode: "3121",
			LatestMedianPrice: 1_450_000, LatestPeriod: period, YoyPct: 3.2345,
			Population: 28_000, MedianAge: 34.5, MedianWeeklyHhdIncome: 2_400,
			PctBornOverseas: 31.4567, TopLanguage: "Mandarin", PctTopLanguage: 4.2345,
			FederalDivision: "Melbourne", FederalMember: "Alexandra Fitzgerald",
			FederalParty:  "Australian Greens",
			StateDistrict: "Richmond", StateMember: "Alexandra Fitzgerald",
			StateParty: "Australian Labor Party",
			Seifa: &shortsv1alpha1.SuburbSeifa{
				Irsad: &shortsv1alpha1.SuburbSeifaIndex{Score: 1080, DecileAus: 9, DecileState: 9},
			},
		},
		Demographics: &shortsv1alpha1.SuburbDemographics{
			MedianWeeklyRent: 550, MedianMonthlyMortgage: 2_800, PctRented: 48.2345, CensusYear: 2021,
		},
		Baselines: &shortsv1alpha1.ComparisonBaselines{
			StateMedianPrice: 900_000, CapitalMedianPrice: 850_000,
		},
		Council: &shortsv1alpha1.LgaInfo{LgaName: "Yarra"},
		Crime: &shortsv1alpha1.SuburbCrime{
			SourceJurisdiction: "NSW",
			Stats: []*shortsv1alpha1.SuburbCrimeStat{
				{CrimeType: "break_ins", PctRank: 62.5}, {CrimeType: "violent", PctRank: 71.1},
				{CrimeType: "motor_vehicle", PctRank: 44.0},
			},
		},
		ListingStats: &shortsv1alpha1.SuburbListingStats{
			ForSaleCount: 42, AvgAsking: 1_300_000, MedianAsking: 1_275_000,
			SoldCount: 18, AvgSold: 1_100_000, MedianSold: 1_090_000,
		},
	}

	drops := make([]*shortsv1alpha1.SuburbPriceDrop, 0, 50)
	for range 50 {
		drops = append(drops, &shortsv1alpha1.SuburbPriceDrop{
			RegionCode: "SUBURB:VIC-RICHMOND", SalCode: "SAL21234", SalName: "Richmond",
			StateCode: "VIC", Postcode: "3121", DroppedListingCount: 12,
			AvgDropPct: 0.0621, MedianDropPct: 0.0554, MaxDropPct: 0.39, MaxDropAbs: 410_000,
			TotalActiveListings: 50, DroppedShare: 0.2412, DroppedValue: 1_200_000,
			ForSaleCount: 50, AvgAsking: 1_300_000, MedianAsking: 1_275_000,
			SoldCount: 9, AvgSold: 1_100_000, MedianSold: 1_090_000,
		})
	}
	src.suburbPriceDrops = &shortsv1alpha1.ListSuburbPriceDropsResponse{Suburbs: drops}
}

// realisticDiscoverySource fills the search/screener/news/reports fixtures, each
// at the DEFAULT limit of its tool and with every bounded field over its cap —
// the worst case a real call can produce.
func realisticDiscoverySource(src *fakeDataSource) {
	// 10 matches (default limit).
	matches := make([]*stocksv1alpha1.Stock, 0, 10)
	for i := range 10 {
		matches = append(matches, &stocksv1alpha1.Stock{
			ProductCode: fmt.Sprintf("MN%d", i), Name: "PILBARA MINERALS LIMITED",
			Industry: "Metals & Mining", PercentageShorted: 19.4321,
			LogoUrl: "https://storage.googleapis.com/shorted/logos/pls.png",
		})
	}
	src.searchStocks = &shortsv1alpha1.SearchStocksResponse{Query: "minerals", Stocks: matches, Count: 10}

	// 20 screened rows (default limit).
	screened := make([]*shortsv1alpha1.ScreenerStock, 0, 20)
	for i := range 20 {
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
	for range 10 {
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
	// The store returns len(articles) after the limit; mirroring that keeps the
	// fixture honest about what the backend actually reports.
	src.stockNews = &shortsv1alpha1.GetStockNewsResponse{Articles: articles, TotalCount: int32(len(articles))}

	// 12 reports (default limit), every standfirst over the truncation limit.
	// 100 repeats ≈ 6KB. The generator writes this field into unbounded JSONB
	// and it does run long; a 20-repeat fixture was small enough that
	// get_report's untruncated summary passed the budget test while measuring
	// 18,672 bytes against real data.
	longStandfirst := strings.Repeat("Short interest across the ASX rose for a third straight week. ", 100)
	reports := make([]*shortsv1alpha1.ReportListItem, 0, 12)
	for i := range 12 {
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
	for i := range 40 {
		topShorted = append(topShorted, &shortsv1alpha1.WeeklyReportStock{
			Rank: int32(i + 1), Code: fmt.Sprintf("TS%d", i%10), Name: "PILBARA MINERALS LIMITED",
			ShortPct: 19.4321, WowChange: 1.2345, DaysToCover: 6.2345, IsNewEntrant: i%3 == 0,
			Industry: "Metals & Mining", LogoUrl: "https://x/pls.png",
			History: []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13},
		})
	}
	movers := make([]*shortsv1alpha1.WeeklyReportMover, 0, 30)
	for i := range 30 {
		movers = append(movers, &shortsv1alpha1.WeeklyReportMover{
			Code: fmt.Sprintf("MV%d", i%10), Name: "PALADIN ENERGY LTD", CurrentPct: 12.3456,
			PreviousPct: 10.1234, Change: 2.2222, DaysToCover: 4.5678, ZScore: 1.9876,
			StreakWeeks: 3, Industry: "Energy", LogoUrl: "https://x/pdn.png",
			History: []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13},
		})
	}
	industries := make([]*shortsv1alpha1.WeeklyIndustryStat, 0, 25)
	for range 25 {
		industries = append(industries, &shortsv1alpha1.WeeklyIndustryStat{
			Industry: "Consumer Discretionary", AvgShortPct: 3.2345, WowChange: 0.1234,
			StockCount: 87, TopStockCode: "JBH", TopStockPct: 9.8765,
		})
	}
	citations := make([]*shortsv1alpha1.WeeklyReportCitation, 0, 25)
	for i := range 25 {
		citations = append(citations, &shortsv1alpha1.WeeklyReportCitation{
			Id: fmt.Sprintf("ref-%d", i), Source: "Pilbara Minerals H1 FY2026 Results",
			Date: "2026-02-20", Url: "https://www.asx.com.au/asxpdf/20260220/pdf/06abcdefghij.pdf",
			Type: "financial_report",
		})
	}
	faqs := make([]*shortsv1alpha1.WeeklyReportFAQ, 0, 8)
	for range 8 {
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

// contentTextBytes is what a client that reads content puts in front of its
// model: the text of every block, unescaped.
func contentTextBytes(res *sdk.CallToolResult) int {
	n := 0
	for _, c := range res.Content {
		if text, ok := c.(*sdk.TextContent); ok {
			n += len(text.Text)
		}
	}
	return n
}
