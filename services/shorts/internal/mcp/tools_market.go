package mcp

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Market-wide tools: rankings, sector aggregates and whole-of-market snapshots.
// Single-stock lookups live in tools_stock.go.

// ---------------------------------------------------------------------------
// list_top_shorts
// ---------------------------------------------------------------------------

// ListTopShortsInput is the tool's argument schema. The jsonschema tags are
// what the client (and therefore the model) reads, so they describe the value.
type ListTopShortsInput struct {
	Period string `json:"period,omitempty" jsonschema:"Lookback window used to compute the ranking: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX. Defaults to 1M."`
	Limit  int    `json:"limit,omitempty" jsonschema:"How many stocks to return, 1-100. Defaults to 20. Values above 100 are clamped, not rejected."`
}

// TopShortEntry is one row of the ranking.
type TopShortEntry struct {
	Rank           int     `json:"rank" jsonschema:"Position in the ranking, 1 = most shorted."`
	Code           string  `json:"code" jsonschema:"ASX ticker code."`
	Name           string  `json:"name,omitempty" jsonschema:"Company or product name."`
	Industry       string  `json:"industry,omitempty" jsonschema:"Industry classification, where known."`
	PercentShorted float64 `json:"percent_shorted" jsonschema:"Latest reported short positions as a percentage of total product in issue, 0-100."`
}

// ListTopShortsOutput is a projection, not the raw GetTopShortsResponse: that
// message carries a full time series per stock, which is both enormous and not
// what a ranking question is asking.
type ListTopShortsOutput struct {
	Period string          `json:"period" jsonschema:"The lookback window actually used."`
	Count  int             `json:"count" jsonschema:"Number of stocks returned."`
	Stocks []TopShortEntry `json:"stocks" jsonschema:"The ranking, most shorted first. Empty when no data is available."`
}

const listTopShortsDescription = "List the most shorted ASX-listed stocks, ranked by latest reported short interest " +
	"(percent of total product in issue held short, 0-100), highest first. Returns ticker, company name, " +
	"industry and that percentage — no prices, volumes or market capitalisation. " +
	"Default 20 stocks, hard maximum 100. " +
	"Source is ASIC's daily short position report, published with a T+4 business-day delay, so these are the " +
	"most recent REPORTED positions and can be up to a week old. This is short interest, not short-sale flow. " +
	"Use this for 'what is most shorted' questions. " +
	"Use screen_stocks instead when the question has CRITERIA to filter on (an industry, a short-percentage " +
	"range, days-to-cover, market cap); this tool applies no filters and always returns the plain top-N. " +
	"Use list_squeeze_candidates instead when the question is about squeeze RISK or momentum rather than " +
	"raw short interest — a heavily shorted stock going nowhere ranks high here and low there."

func listTopShortsTool() Tool {
	tool := Tool{
		Name:        "list_top_shorts",
		Title:       "List most shorted ASX stocks",
		Description: listTopShortsDescription,
		RPC:         "shorts.v1alpha1.MarketService.GetTopShorts",
		Domain:      "market",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), listTopShortsHandler(src))
	}
	return tool
}

func listTopShortsHandler(src DataSource) sdk.ToolHandlerFor[ListTopShortsInput, ListTopShortsOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in ListTopShortsInput) (*sdk.CallToolResult, ListTopShortsOutput, error) {
		period, err := normalisePeriod(in.Period)
		if err != nil {
			return nil, ListTopShortsOutput{}, err
		}
		limit := clampLimit(in.Limit, defaultTopShortsLimit, maxListLimit)

		res, err := src.GetTopShorts(ctx, connect.NewRequest(&shortsv1alpha1.GetTopShortsRequest{
			Period: period,
			Limit:  limit,
			// Without this the RPC returns every point of every stock's time
			// series — megabytes, for a question that wants a leaderboard.
			SummaryOnly: true,
		}))
		if err != nil {
			return nil, ListTopShortsOutput{}, fmt.Errorf("could not list top shorts for period %s: %w", period, err)
		}
		if res == nil || res.Msg == nil {
			return nil, ListTopShortsOutput{}, fmt.Errorf("no data returned for period %s", period)
		}

		out := ListTopShortsOutput{Period: period, Stocks: []TopShortEntry{}}
		for i, series := range res.Msg.GetTimeSeries() {
			if series == nil {
				continue
			}
			out.Stocks = append(out.Stocks, TopShortEntry{
				Rank:           i + 1,
				Code:           series.GetProductCode(),
				Name:           series.GetName(),
				Industry:       series.GetIndustry(),
				PercentShorted: finite(series.GetLatestShortPosition()),
			})
		}
		out.Count = len(out.Stocks)

		var summary string
		if out.Count == 0 {
			// Say so rather than returning an empty list the model may read as
			// "nothing is shorted".
			summary = fmt.Sprintf("No short position rankings are available for period %s.", period)
		} else {
			lead := out.Stocks[0]
			summary = fmt.Sprintf("Top %d most shorted ASX stocks over %s. Most shorted: %s (%s) at %.2f%% of shares on issue.",
				out.Count, period, lead.Code, nonEmpty(lead.Name, "name unknown"), lead.PercentShorted)
			summary += asicCaveat
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// get_industry_treemap
// ---------------------------------------------------------------------------

type GetIndustryTreemapInput struct {
	Period string `json:"period,omitempty" jsonschema:"Lookback window: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX. Defaults to 1M."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Maximum stocks to return per industry, 1-100. Defaults to 20."`
}

type IndustryTreemapEntry struct {
	Industry       string  `json:"industry" jsonschema:"Industry classification the stock belongs to."`
	Code           string  `json:"code" jsonschema:"ASX ticker code."`
	PercentShorted float64 `json:"percent_shorted" jsonschema:"Latest reported short position as a percentage of total product in issue, 0-100."`
}

type GetIndustryTreemapOutput struct {
	Period     string                 `json:"period" jsonschema:"The lookback window actually used."`
	Industries []string               `json:"industries" jsonschema:"Every industry present in the result."`
	Count      int                    `json:"count" jsonschema:"Number of stock rows returned."`
	Truncated  bool                   `json:"truncated" jsonschema:"True when rows were dropped to stay within the tool's cap."`
	Stocks     []IndustryTreemapEntry `json:"stocks" jsonschema:"Flattened industry/stock rows. Empty when no data is available."`
}

const getIndustryTreemapDescription = "Break ASX short interest down by industry: returns the list of industries and, " +
	"within each, its constituent stocks with their latest reported short position as a percentage of shares on " +
	"issue (0-100). Answers 'which sectors are most shorted' and 'what is being shorted in mining/retail/energy'. " +
	"Returns at most 150 stock rows in total and sets truncated=true when it had to drop some. " +
	"Industry classification is Shorted's own company metadata, not GICS, and stocks with no classification are " +
	"absent. Source is ASIC's daily short position report, published T+4 business days. " +
	"Returns no prices, volumes or index weights — it is a short-interest breakdown, not a sector performance view."

func getIndustryTreemapTool() Tool {
	tool := Tool{
		Name:        "get_industry_treemap",
		Title:       "ASX short interest by industry",
		Description: getIndustryTreemapDescription,
		RPC:         "shorts.v1alpha1.MarketService.GetIndustryTreeMap",
		Domain:      "market",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getIndustryTreemapHandler(src))
	}
	return tool
}

func getIndustryTreemapHandler(src DataSource) sdk.ToolHandlerFor[GetIndustryTreemapInput, GetIndustryTreemapOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetIndustryTreemapInput) (*sdk.CallToolResult, GetIndustryTreemapOutput, error) {
		period, err := normalisePeriod(in.Period)
		if err != nil {
			return nil, GetIndustryTreemapOutput{}, err
		}
		limit := clampLimit(in.Limit, defaultTreemapLimit, maxListLimit)

		res, err := src.GetIndustryTreeMap(ctx, connect.NewRequest(&shortsv1alpha1.GetIndustryTreeMapRequest{
			Period: period,
			Limit:  limit,
			// CURRENT_CHANGE yields the latest reported position, which is what
			// percent_shorted is documented to mean. PERCENTAGE_CHANGE would
			// put a delta in the same field under the same name.
			ViewMode: shortsv1alpha1.ViewMode_CURRENT_CHANGE,
		}))
		if err != nil {
			return nil, GetIndustryTreemapOutput{}, fmt.Errorf("could not build the industry breakdown for period %s: %w", period, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetIndustryTreemapOutput{}, fmt.Errorf("no data returned for period %s", period)
		}

		rows := res.Msg.GetStocks()
		out := GetIndustryTreemapOutput{
			Period:     period,
			Industries: res.Msg.GetIndustries(),
			Truncated:  len(rows) > maxTreemapStocks,
			Stocks:     []IndustryTreemapEntry{},
		}
		if out.Industries == nil {
			out.Industries = []string{}
		}
		for _, row := range capItems(rows, maxTreemapStocks) {
			if row == nil {
				continue
			}
			out.Stocks = append(out.Stocks, IndustryTreemapEntry{
				Industry:       row.GetIndustry(),
				Code:           row.GetProductCode(),
				PercentShorted: finite(row.GetShortPosition()),
			})
		}
		out.Count = len(out.Stocks)

		var summary string
		if out.Count == 0 {
			summary = fmt.Sprintf("No industry short-interest breakdown is available for period %s.", period)
		} else {
			summary = fmt.Sprintf("%d stocks across %d industries over %s.", out.Count, len(out.Industries), period)
			if out.Truncated {
				summary += fmt.Sprintf(" Capped at %d rows; narrow the limit or ask about one industry for full coverage.", maxTreemapStocks)
			}
			summary += asicCaveat
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// get_market_snapshot
// ---------------------------------------------------------------------------

type GetMarketSnapshotInput struct {
	Date  string `json:"date" jsonschema:"Trading date in YYYY-MM-DD format, e.g. 2026-08-01. Required. Must be an ASX trading day on which ASIC reported; weekends, public holidays and dates inside the T+4 reporting lag return no stocks."`
	Limit int    `json:"limit,omitempty" jsonschema:"How many stocks to return, ranked most shorted first, 1-100. Defaults to 25."`
}

type MarketSnapshotStock struct {
	Code                   string  `json:"code" jsonschema:"ASX ticker code."`
	Name                   string  `json:"name,omitempty" jsonschema:"Company or product name."`
	Industry               string  `json:"industry,omitempty" jsonschema:"Industry classification, where known."`
	PercentShorted         float64 `json:"percent_shorted" jsonschema:"Reported short positions as a percentage of total product in issue on that date, 0-100."`
	ReportedShortPositions float64 `json:"reported_short_positions" jsonschema:"Number of shares reported as short positions on that date."`
	TotalProductInIssue    float64 `json:"total_product_in_issue" jsonschema:"Total shares on issue on that date."`
}

type GetMarketSnapshotOutput struct {
	Date                string                `json:"date" jsonschema:"The trading date the snapshot is for."`
	TotalCount          int                   `json:"total_count" jsonschema:"Total stocks reported on that date, before the limit was applied."`
	Returned            int                   `json:"returned" jsonschema:"How many stocks this result actually contains."`
	PreviousTradingDate string                `json:"previous_trading_date,omitempty" jsonschema:"Nearest reported date before this one, or empty if none. Retry with this when the requested date has no data."`
	NextTradingDate     string                `json:"next_trading_date,omitempty" jsonschema:"Nearest reported date after this one, or empty if none."`
	Stocks              []MarketSnapshotStock `json:"stocks" jsonschema:"The snapshot, most shorted first. Empty when the date was not a reported trading day."`
}

const getMarketSnapshotDescription = "Get every reported ASX short position as at one specific trading date — a point-in-time " +
	"snapshot rather than the latest figures. Pass date as YYYY-MM-DD (e.g. 2026-08-01). " +
	"Returns the most shorted stocks on that date with percent of shares on issue held short, the raw share " +
	"counts, and how many stocks were reported in total. Default 25 stocks, hard maximum 100. " +
	"If the date is a weekend, a public holiday, before the data begins, or inside ASIC's T+4 reporting lag, " +
	"the result contains NO stocks and returned=0 — it does not fall back to a nearby date. When that happens, " +
	"previous_trading_date and next_trading_date name the nearest dates that DO have data, so retry with one of " +
	"those rather than guessing. Use list_top_shorts instead when the question is about current positions; " +
	"this tool exists for historical 'what did it look like on X' questions."

func getMarketSnapshotTool() Tool {
	tool := Tool{
		Name:        "get_market_snapshot",
		Title:       "ASX short positions on a given date",
		Description: getMarketSnapshotDescription,
		RPC:         "shorts.v1alpha1.MarketService.GetMarketByDate",
		Domain:      "market",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getMarketSnapshotHandler(src))
	}
	return tool
}

func getMarketSnapshotHandler(src DataSource) sdk.ToolHandlerFor[GetMarketSnapshotInput, GetMarketSnapshotOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetMarketSnapshotInput) (*sdk.CallToolResult, GetMarketSnapshotOutput, error) {
		date := strings.TrimSpace(in.Date)
		if !isoDateRe.MatchString(date) {
			return nil, GetMarketSnapshotOutput{}, fmt.Errorf(
				"%q is not a valid date: expected YYYY-MM-DD, e.g. 2026-08-01", in.Date)
		}
		limit := clampLimit(in.Limit, defaultSnapshotLimit, maxListLimit)

		res, err := src.GetMarketByDate(ctx, connect.NewRequest(&shortsv1alpha1.GetMarketByDateRequest{
			Date:  date,
			Limit: limit,
		}))
		if err != nil {
			return nil, GetMarketSnapshotOutput{}, fmt.Errorf("could not get the market snapshot for %s: %w", date, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetMarketSnapshotOutput{}, fmt.Errorf("no data returned for %s", date)
		}

		msg := res.Msg
		out := GetMarketSnapshotOutput{
			Date:                nonEmpty(msg.GetDate(), date),
			TotalCount:          int(msg.GetTotalCount()),
			PreviousTradingDate: msg.GetPreviousDate(),
			NextTradingDate:     msg.GetNextDate(),
			Stocks:              []MarketSnapshotStock{},
		}
		for _, stock := range msg.GetStocks() {
			if stock == nil {
				continue
			}
			out.Stocks = append(out.Stocks, MarketSnapshotStock{
				Code:                   stock.GetProductCode(),
				Name:                   stock.GetName(),
				Industry:               stock.GetIndustry(),
				PercentShorted:         fromFloat32(stock.GetPercentageShorted()),
				ReportedShortPositions: fromFloat32(stock.GetReportedShortPositions()),
				TotalProductInIssue:    fromFloat32(stock.GetTotalProductInIssue()),
			})
		}
		out.Returned = len(out.Stocks)

		var summary string
		if out.Returned == 0 {
			// An empty snapshot is the common case for a guessed date, so the
			// text must name the remedy rather than just reporting zero.
			summary = fmt.Sprintf("No short positions were reported for %s — it is not an ASX trading day with ASIC data.", out.Date)
			switch {
			case out.PreviousTradingDate != "" && out.NextTradingDate != "":
				summary += fmt.Sprintf(" The nearest reported dates are %s and %s.", out.PreviousTradingDate, out.NextTradingDate)
			case out.PreviousTradingDate != "":
				summary += fmt.Sprintf(" The nearest earlier reported date is %s.", out.PreviousTradingDate)
			case out.NextTradingDate != "":
				summary += fmt.Sprintf(" The nearest later reported date is %s.", out.NextTradingDate)
			}
		} else {
			lead := out.Stocks[0]
			summary = fmt.Sprintf("%d of %d stocks reported short on %s. Most shorted: %s at %.2f%% of shares on issue.",
				out.Returned, out.TotalCount, out.Date, lead.Code, lead.PercentShorted)
			summary += asicCaveat
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// list_squeeze_candidates
// ---------------------------------------------------------------------------

type ListSqueezeCandidatesInput struct {
	View  string `json:"view,omitempty" jsonschema:"Which ranking to return: \"squeeze\" (default) ranks by squeeze_score; \"divergence\" returns only stocks whose price is RISING while short positions are still BUILDING, ranked by divergence_score."`
	Limit int    `json:"limit,omitempty" jsonschema:"How many stocks to return, 1-100. Defaults to 20."`
}

type SqueezeCandidate struct {
	Rank                 int     `json:"rank" jsonschema:"Position in the ranking, 1 = highest score."`
	Code                 string  `json:"code" jsonschema:"ASX ticker code."`
	Name                 string  `json:"name,omitempty" jsonschema:"Company name."`
	Industry             string  `json:"industry,omitempty" jsonschema:"Industry classification, where known."`
	ShortPercent         float64 `json:"short_percent" jsonschema:"Latest reported short position as a percentage of shares on issue, 0-100."`
	ShortPercentChange4W float64 `json:"short_percent_change_4w" jsonschema:"Change in that percentage over the last four weeks, in percentage points. Positive means shorts are building."`
	LatestPrice          float64 `json:"latest_price" jsonschema:"Most recent close in AUD. 0 when unknown."`
	PriceChange1M        float64 `json:"price_change_1m" jsonschema:"One-month price change, percent."`
	DaysToCover          float64 `json:"days_to_cover" jsonschema:"Reported short position divided by 20-day average volume — trading days it would take to buy back the short interest."`
	SqueezeScore         float64 `json:"squeeze_score" jsonschema:"Composite 0-100 squeeze-risk score. Shorted's own derived metric, not an official or third-party rating."`
	DivergenceScore      float64 `json:"divergence_score" jsonschema:"Composite 0-100 score, 0 unless price is rising AND shorts are building. Shorted's own derived metric."`
	MarketCap            float64 `json:"market_cap" jsonschema:"Market capitalisation in AUD. 0 when unknown."`
}

type ListSqueezeCandidatesOutput struct {
	View       string             `json:"view" jsonschema:"The ranking actually used, \"squeeze\" or \"divergence\"."`
	TotalCount int                `json:"total_count" jsonschema:"Total stocks in the ranking before the limit was applied."`
	Count      int                `json:"count" jsonschema:"How many stocks this result contains."`
	Stocks     []SqueezeCandidate `json:"stocks" jsonschema:"The ranking, highest score first. Empty when no candidates qualify."`
}

const listSqueezeCandidatesDescription = "Rank ASX stocks by short-squeeze risk or by bull-versus-bear divergence. " +
	"view=\"squeeze\" (default) ranks by a composite 0-100 squeeze_score that blends short interest, the " +
	"four-week change in short positions, price momentum and days-to-cover. view=\"divergence\" returns ONLY " +
	"stocks whose price is rising while shorts are still building, ranked by divergence_score. " +
	"Each row carries the inputs as well as the score: short percent, four-week change in percentage points, " +
	"latest price and one-month price change in AUD/percent, days-to-cover, and market cap. " +
	"Default 20 stocks, hard maximum 100. " +
	"squeeze_score and divergence_score are SHORTED'S OWN derived metrics — not an official ASIC or exchange " +
	"figure, not a broker rating, and not a prediction or investment recommendation. " +
	"Short data is ASIC's, published T+4 business days; prices are end-of-day, not live. " +
	"Differs from list_top_shorts, which is a plain ranking by short interest alone and ignores price entirely, " +
	"and from screen_stocks, which filters on criteria you supply rather than ranking by a computed score."

func listSqueezeCandidatesTool() Tool {
	tool := Tool{
		Name:        "list_squeeze_candidates",
		Title:       "Rank ASX stocks by squeeze risk",
		Description: listSqueezeCandidatesDescription,
		RPC:         "shorts.v1alpha1.MarketService.GetBattlegroundStocks",
		Domain:      "market",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), listSqueezeCandidatesHandler(src))
	}
	return tool
}

func listSqueezeCandidatesHandler(src DataSource) sdk.ToolHandlerFor[ListSqueezeCandidatesInput, ListSqueezeCandidatesOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in ListSqueezeCandidatesInput) (*sdk.CallToolResult, ListSqueezeCandidatesOutput, error) {
		view := strings.ToLower(strings.TrimSpace(in.View))
		var pbView shortsv1alpha1.BattlegroundView
		switch view {
		case "", "squeeze":
			view, pbView = "squeeze", shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_SQUEEZE
		case "divergence":
			pbView = shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_DIVERGENCE
		default:
			return nil, ListSqueezeCandidatesOutput{}, fmt.Errorf(
				"%q is not a valid view: use \"squeeze\" or \"divergence\"", in.View)
		}
		limit := clampLimit(in.Limit, defaultSqueezeLimit, maxListLimit)

		res, err := src.GetBattlegroundStocks(ctx, connect.NewRequest(&shortsv1alpha1.GetBattlegroundStocksRequest{
			View:  pbView,
			Limit: limit,
		}))
		if err != nil {
			return nil, ListSqueezeCandidatesOutput{}, fmt.Errorf("could not rank %s candidates: %w", view, err)
		}
		if res == nil || res.Msg == nil {
			return nil, ListSqueezeCandidatesOutput{}, fmt.Errorf("no data returned for the %s ranking", view)
		}

		out := ListSqueezeCandidatesOutput{
			View:       view,
			TotalCount: int(res.Msg.GetTotalCount()),
			Stocks:     []SqueezeCandidate{},
		}
		for i, stock := range res.Msg.GetStocks() {
			if stock == nil {
				continue
			}
			out.Stocks = append(out.Stocks, SqueezeCandidate{
				Rank:                 i + 1,
				Code:                 stock.GetStockCode(),
				Name:                 stock.GetCompanyName(),
				Industry:             stock.GetIndustry(),
				ShortPercent:         finite(stock.GetShortPct()),
				ShortPercentChange4W: finite(stock.GetShortPctChange_4W()),
				LatestPrice:          finite(stock.GetLatestPrice()),
				PriceChange1M:        finite(stock.GetPriceChange_1M()),
				DaysToCover:          finite(stock.GetDaysToCover()),
				SqueezeScore:         finite(stock.GetSqueezeScore()),
				DivergenceScore:      finite(stock.GetDivergenceScore()),
				MarketCap:            finite(stock.GetMarketCap()),
			})
		}
		out.Count = len(out.Stocks)

		var summary string
		if out.Count == 0 {
			summary = fmt.Sprintf("No stocks currently qualify for the %s ranking.", view)
		} else {
			lead := out.Stocks[0]
			score := lead.SqueezeScore
			if view == "divergence" {
				score = lead.DivergenceScore
			}
			summary = fmt.Sprintf("%d ASX stocks ranked by %s. Highest: %s (%s) scoring %.1f/100, %.2f%% short with %.1f days to cover.",
				out.Count, view, lead.Code, nonEmpty(lead.Name, "name unknown"), score, lead.ShortPercent, lead.DaysToCover)
			summary += " Scores are Shorted's own derived metrics, not investment advice." + asicCaveat
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}
