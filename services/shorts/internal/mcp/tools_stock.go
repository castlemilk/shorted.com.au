package mcp

import (
	"context"
	"fmt"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Single-stock tools. Market-wide rankings and aggregates live in
// tools_market.go; the split is by the shape of the question, because that is
// how a model picks between them.

// ---------------------------------------------------------------------------
// get_stock
// ---------------------------------------------------------------------------

// GetStockInput is the tool's argument schema. The jsonschema tags are what
// the client (and therefore the model) actually reads, so they describe the
// value, not the field.
type GetStockInput struct {
	Code string `json:"code" jsonschema:"ASX ticker code, 3-4 alphanumeric characters, e.g. BHP, CBA, ZIP. Case-insensitive."`
}

// GetStockOutput is the structured result. It is a projection of the Stock
// message rather than the message itself: an agent needs the units spelled
// out, and a hand-written struct keeps the tool's contract from silently
// widening when a field is added to the proto.
type GetStockOutput struct {
	Code                   string  `json:"code" jsonschema:"ASX ticker code."`
	Name                   string  `json:"name,omitempty" jsonschema:"Company or product name."`
	Industry               string  `json:"industry,omitempty" jsonschema:"Industry classification, where known."`
	PercentShorted         float64 `json:"percent_shorted" jsonschema:"Reported short positions as a percentage of total product in issue, 0-100."`
	ReportedShortPositions float64 `json:"reported_short_positions" jsonschema:"Number of shares reported as short positions."`
	TotalProductInIssue    float64 `json:"total_product_in_issue" jsonschema:"Total shares on issue."`
}

const getStockDescription = "Look up a single ASX-listed stock by ticker code and return its latest reported " +
	"short position: percent of total product in issue held short (0-100), the raw number of shares " +
	"shorted, total shares on issue, and the company name and industry. " +
	"Source is ASIC's daily short position report, which is published with a T+4 business-day delay — " +
	"the figure returned is the most recent REPORTED position, not today's, and can be up to a week old. " +
	"This is short interest, not short-sale flow, and it is not a price quote: it returns no price, " +
	"volume or market capitalisation."

// getStockTool returns the registry entry for get_stock.
//
// The RPC field is load-bearing — see Tool and TestToolsOnlyCallPublicMethods.
func getStockTool() Tool {
	tool := Tool{
		Name:        "get_stock",
		Title:       "Get ASX stock short position",
		Description: getStockDescription,
		RPC:         "shorts.v1alpha1.StockService.GetStock",
		Domain:      "stock",
	}
	// Closes over tool so the SDK definition is derived from the registry entry
	// rather than restated beside it.
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getStockHandler(src))
	}
	return tool
}

func getStockHandler(src DataSource) sdk.ToolHandlerFor[GetStockInput, GetStockOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetStockInput) (*sdk.CallToolResult, GetStockOutput, error) {
		code, err := normaliseCode(in.Code)
		if err != nil {
			// Returned as an error, which the SDK packs into an IsError result
			// rather than a protocol fault, so the model can see it and retry
			// with a corrected argument.
			return nil, GetStockOutput{}, err
		}

		res, err := src.GetStock(ctx, connect.NewRequest(&shortsv1alpha1.GetStockRequest{
			ProductCode: code,
		}))
		if err != nil {
			// Distinguish "no such stock" from "we broke", because the remedy
			// differs: one is the model's to fix, the other is not.
			if connect.CodeOf(err) == connect.CodeNotFound {
				return nil, GetStockOutput{}, fmt.Errorf(
					"no ASX stock found with code %s — check the ticker, or use search_stocks to find it by company name", code)
			}
			return nil, GetStockOutput{}, fmt.Errorf("could not look up %s: %w", code, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetStockOutput{}, fmt.Errorf("no data returned for %s", code)
		}

		stock := res.Msg
		out := GetStockOutput{
			Code:                   stock.GetProductCode(),
			Name:                   stock.GetName(),
			Industry:               stock.GetIndustry(),
			PercentShorted:         fromFloat32(stock.GetPercentageShorted()),
			ReportedShortPositions: fromFloat32(stock.GetReportedShortPositions()),
			TotalProductInIssue:    fromFloat32(stock.GetTotalProductInIssue()),
		}

		// A text fallback alongside the structured content: clients that do not
		// consume structuredContent (and humans reading a transcript) otherwise
		// see raw JSON. Setting Content suppresses the SDK's JSON default.
		summary := fmt.Sprintf("%s (%s): %.2f%% of shares on issue reported short (%.0f of %.0f shares).",
			out.Code, nonEmpty(out.Name, "name unknown"), out.PercentShorted,
			out.ReportedShortPositions, out.TotalProductInIssue)
		if out.Industry != "" {
			summary += " Industry: " + out.Industry + "."
		}
		summary += " Source: ASIC short position report, published T+4."

		return &sdk.CallToolResult{
			Content: []sdk.Content{&sdk.TextContent{Text: summary}},
		}, out, nil
	}
}

// ---------------------------------------------------------------------------
// get_stock_history
// ---------------------------------------------------------------------------

type GetStockHistoryInput struct {
	Code   string `json:"code" jsonschema:"ASX ticker code, 3-4 alphanumeric characters, e.g. BHP. Case-insensitive."`
	Period string `json:"period,omitempty" jsonschema:"Lookback window: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX. Defaults to 1M. Ignored when \"from\" is set."`
	From   string `json:"from,omitempty" jsonschema:"Start of an explicit window, YYYY-MM-DD. Use instead of period to pull one specific span without over-fetching."`
	To     string `json:"to,omitempty" jsonschema:"End of an explicit window, YYYY-MM-DD. Defaults to the end of the data."`
	AsOf   string `json:"as_of,omitempty" jsonschema:"Point-in-time filter, YYYY-MM-DD: return only observations already PUBLISHED by this date. ASIC publishes T+4, so without it a historical window includes data nobody could have had at the time."`

	// The MCP was the only surface exposing the deep history, and it thinned
	// that history to 200 points with no way to opt out — so the richest
	// series in the product was reachable only in a shape suitable for
	// conversation.
	FullResolution bool `json:"full_resolution,omitempty" jsonschema:"Return every stored observation instead of a series thinned for reading. Use for quantitative work; the result can be large."`
	MaxPoints      int  `json:"max_points,omitempty" jsonschema:"Cap on returned points, 1-5000. Defaults to 120. Ignored when full_resolution is true."`
}

type StockHistoryPoint struct {
	Date         string  `json:"date" jsonschema:"Observation date, YYYY-MM-DD."`
	ShortPercent float64 `json:"short_percent" jsonschema:"Reported short positions as a percentage of total product in issue on that date, 0-100."`

	// The percent's numerator and denominator. Shares on issue moves with
	// placements and buybacks, so the percent can fall with no change in
	// short positioning at all; without these a caller cannot tell the two
	// apart.
	ShortPositions float64 `json:"short_positions,omitempty" jsonschema:"Shares held short on that date — a COUNT, not a percent."`
	SharesOnIssue  float64 `json:"shares_on_issue,omitempty" jsonschema:"Shares on issue on that date, the denominator of short_percent."`
}

type GetStockHistoryOutput struct {
	Code               string  `json:"code" jsonschema:"ASX ticker code."`
	Name               string  `json:"name,omitempty" jsonschema:"Company or product name."`
	Period             string  `json:"period" jsonschema:"The lookback window actually used."`
	LatestShortPercent float64 `json:"latest_short_percent" jsonschema:"Most recent reported short position in the series, percent of shares on issue."`
	TotalObservations  int     `json:"total_observations" jsonschema:"How many daily observations exist in the window, BEFORE downsampling."`
	Returned           int     `json:"returned" jsonschema:"How many points this result contains."`
	Downsampled        bool    `json:"downsampled" jsonschema:"True when the series was thinned to fit the point cap. The first and last observations are always kept."`
	// Stated once rather than repeated on every point. A model needs the RULE
	// to reason about lookahead; a quantitative caller who needs the resolved
	// date per observation is on the Connect API or the CSV export, where
	// available_from is returned on every row and the payload is not charged
	// to a context window.
	PublicationLagTradingDays int                 `json:"publication_lag_trading_days" jsonschema:"Trading days between an observation's date and the date it became public. ASIC publishes T+4, so an observation dated D was not knowable until about D+4 trading days. Using a value on its own date is lookahead; pass as_of to filter to what was actually published."`
	Points                    []StockHistoryPoint `json:"points" jsonschema:"The series, oldest first. Empty when no history exists for the window."`
}

const getStockHistoryDescription = "Get the time series of a single ASX stock's reported short position over a lookback " +
	"window (1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX; default 1M). Each point is a date and the percent of " +
	"total product in issue held short on that date (0-100). Use this for trend questions — is short interest " +
	"rising, when did it peak, how does it compare to a year ago. " +
	"By default long windows are DOWNSAMPLED to at most 120 evenly-spaced points, always keeping the first and " +
	"last observation, so the default series is right for trends but is not a complete daily record. " +
	"Pass full_resolution=true for every stored observation, or max_points for a different cap; " +
	"total_observations always reports how many observations exist and downsampled says whether thinning " +
	"happened. Use from/to for a specific window instead of over-fetching a long period. " +
	"Each point also carries short_positions (a share COUNT) and shares_on_issue (its denominator) — a capital " +
	"raising moves the percent without any change in short positioning, and only the counts reveal that. " +
	"This is short interest only; use get_stock_prices for price, volume and returns. " +
	"as_of filters to what had actually been PUBLISHED by a given date — use it for anything historical, or " +
	"the series contains data nobody had at the time. " +
	"Source is ASIC's daily short position report, published with a T+4 business-day delay."

func getStockHistoryTool() Tool {
	tool := Tool{
		Name:        "get_stock_history",
		Title:       "Get a stock's short position over time",
		Description: getStockHistoryDescription,
		RPC:         "shorts.v1alpha1.StockService.GetStockData",
		Domain:      "stock",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getStockHistoryHandler(src))
	}
	return tool
}

func getStockHistoryHandler(src DataSource) sdk.ToolHandlerFor[GetStockHistoryInput, GetStockHistoryOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetStockHistoryInput) (*sdk.CallToolResult, GetStockHistoryOutput, error) {
		code, err := normaliseCode(in.Code)
		if err != nil {
			return nil, GetStockHistoryOutput{}, err
		}
		period, err := normalisePeriod(in.Period)
		if err != nil {
			return nil, GetStockHistoryOutput{}, err
		}

		// full_resolution wins over max_points; otherwise a cap of 200 keeps
		// the default response readable, as it always has.
		maxPoints := int32(maxHistoryPoints)
		if in.MaxPoints > 0 {
			if in.MaxPoints > maxRequestableHistoryPoints {
				return nil, GetStockHistoryOutput{}, fmt.Errorf(
					"max_points must be between 1 and %d, got %d", maxRequestableHistoryPoints, in.MaxPoints)
			}
			maxPoints = int32(in.MaxPoints)
		}
		if in.FullResolution {
			maxPoints = 0
		}

		res, err := src.GetStockData(ctx, connect.NewRequest(&shortsv1alpha1.GetStockDataRequest{
			ProductCode:    code,
			Period:         period,
			From:           in.From,
			To:             in.To,
			AsOf:           in.AsOf,
			FullResolution: in.FullResolution,
			MaxPoints:      maxPoints,
		}))
		if err != nil {
			if connect.CodeOf(err) == connect.CodeNotFound {
				return nil, GetStockHistoryOutput{}, fmt.Errorf(
					"no short position history found for %s over %s — check the ticker with get_stock, or try a longer period", code, period)
			}
			return nil, GetStockHistoryOutput{}, fmt.Errorf("could not get history for %s: %w", code, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetStockHistoryOutput{}, fmt.Errorf("no data returned for %s over %s", code, period)
		}

		msg := res.Msg
		all := msg.GetPoints()

		// total_observations and downsampled now come from the server, which
		// counts the raw stored rows. Deriving them here from the points that
		// arrived reported the number of BUCKETS as the number of daily
		// observations — 846 for 16 years of MAX, which is the weekly bucket
		// count, not the several thousand daily rows behind it.
		out := GetStockHistoryOutput{
			Code:                      nonEmpty(msg.GetProductCode(), code),
			Name:                      msg.GetName(),
			Period:                    period,
			LatestShortPercent:        finite(msg.GetLatestShortPosition()),
			TotalObservations:         int(msg.GetTotalObservations()),
			Downsampled:               msg.GetDownsampled(),
			PublicationLagTradingDays: asxcalendar.PublicationLagTradingDays,
			Points:                    []StockHistoryPoint{},
		}
		for _, point := range all {
			if point == nil || point.GetTimestamp() == nil {
				continue
			}
			out.Points = append(out.Points, StockHistoryPoint{
				Date:           point.GetTimestamp().AsTime().UTC().Format("2006-01-02"),
				ShortPercent:   finite(point.GetShortPosition()),
				ShortPositions: finite(point.GetReportedShortPositions()),
				SharesOnIssue:  finite(point.GetTotalProductInIssue()),
			})
		}
		out.Returned = len(out.Points)

		var summary string
		if out.Returned == 0 {
			summary = fmt.Sprintf("No reported short position history for %s over %s.", out.Code, period)
		} else {
			first, last := out.Points[0], out.Points[len(out.Points)-1]
			summary = fmt.Sprintf("%s short position over %s: %.2f%% on %s to %.2f%% on %s (%d observations",
				out.Code, period, first.ShortPercent, first.Date, last.ShortPercent, last.Date, out.TotalObservations)
			if out.Downsampled {
				summary += fmt.Sprintf(", downsampled to %d points", out.Returned)
			}
			summary += ")." + asicCaveat
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// get_stock_details
// ---------------------------------------------------------------------------

type GetStockDetailsInput struct {
	Code string `json:"code" jsonschema:"ASX ticker code, 3-4 alphanumeric characters, e.g. BHP. Case-insensitive."`
}

type StockPerson struct {
	Name string `json:"name" jsonschema:"Person's name."`
	Role string `json:"role,omitempty" jsonschema:"Their role at the company, e.g. CEO, Chair."`
}

// GetStockDetailsOutput is a deliberately narrow projection of StockDetails.
// That message carries five long prose fields, full financial statements, five
// logo URL variants and a list of report links; passing it through would make
// one tool call cost tens of kilobytes of context and would let any future
// proto field join the published contract without review.
type GetStockDetailsOutput struct {
	Code                  string        `json:"code" jsonschema:"ASX ticker code."`
	CompanyName           string        `json:"company_name,omitempty" jsonschema:"Registered company name."`
	Industry              string        `json:"industry,omitempty" jsonschema:"Industry classification, where known."`
	Website               string        `json:"website,omitempty" jsonschema:"Company website."`
	Address               string        `json:"address,omitempty" jsonschema:"Registered address."`
	Summary               string        `json:"summary,omitempty" jsonschema:"What the company does. Truncated to about 1200 characters."`
	CompanyHistory        string        `json:"company_history,omitempty" jsonschema:"Background on the company. Truncated to about 1200 characters."`
	CompetitiveAdvantages string        `json:"competitive_advantages,omitempty" jsonschema:"Stated competitive position. Truncated to about 1200 characters."`
	RecentDevelopments    string        `json:"recent_developments,omitempty" jsonschema:"Recent company events. Truncated to about 1200 characters, and not a live news feed — use get_stock_news for that."`
	RiskFactors           []string      `json:"risk_factors,omitempty" jsonschema:"Identified risk factors, at most 10."`
	KeyPeople             []StockPerson `json:"key_people,omitempty" jsonschema:"Named executives and directors, at most 10."`
	Tags                  []string      `json:"tags,omitempty" jsonschema:"Descriptive tags, at most 10."`
}

const getStockDetailsDescription = "Get the company profile behind an ASX ticker: registered name, industry, website, " +
	"address, a description of what the company does, background, stated competitive advantages, recent " +
	"developments, risk factors and key people. Use this for 'who are they / what do they do' questions. " +
	"Prose fields are AI-enriched from public company sources, are truncated to about 1200 characters each " +
	"(marked when cut), and may be months out of date — they are NOT company statements, filings or advice. " +
	"Lists are capped at 10 items. " +
	"This tool returns NO short position, price, or financial-statement data: use get_stock for short interest, " +
	"get_stock_history for its trend, and get_peer_comparison for valuation metrics alongside industry peers."

func getStockDetailsTool() Tool {
	tool := Tool{
		Name:        "get_stock_details",
		Title:       "Get an ASX company profile",
		Description: getStockDetailsDescription,
		RPC:         "shorts.v1alpha1.StockService.GetStockDetails",
		Domain:      "stock",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getStockDetailsHandler(src))
	}
	return tool
}

func getStockDetailsHandler(src DataSource) sdk.ToolHandlerFor[GetStockDetailsInput, GetStockDetailsOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetStockDetailsInput) (*sdk.CallToolResult, GetStockDetailsOutput, error) {
		code, err := normaliseCode(in.Code)
		if err != nil {
			return nil, GetStockDetailsOutput{}, err
		}

		res, err := src.GetStockDetails(ctx, connect.NewRequest(&shortsv1alpha1.GetStockDetailsRequest{
			ProductCode: code,
		}))
		if err != nil {
			if connect.CodeOf(err) == connect.CodeNotFound {
				return nil, GetStockDetailsOutput{}, fmt.Errorf(
					"no company profile found for %s — check the ticker, or use search_stocks to find it by company name", code)
			}
			return nil, GetStockDetailsOutput{}, fmt.Errorf("could not get details for %s: %w", code, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetStockDetailsOutput{}, fmt.Errorf("no data returned for %s", code)
		}

		msg := res.Msg
		out := GetStockDetailsOutput{
			Code:        nonEmpty(msg.GetProductCode(), code),
			CompanyName: msg.GetCompanyName(),
			Industry:    msg.GetIndustry(),
			Website:     msg.GetWebsite(),
			Address:     msg.GetAddress(),
			// The enriched summary is the better one where it exists; the base
			// summary is the fallback rather than a second field, because two
			// near-identical paragraphs is worse than one.
			Summary:               truncate(firstNonEmpty(msg.GetEnhancedSummary(), msg.GetSummary(), msg.GetDetails()), maxProseChars),
			CompanyHistory:        truncate(msg.GetCompanyHistory(), maxProseChars),
			CompetitiveAdvantages: truncate(msg.GetCompetitiveAdvantages(), maxProseChars),
			RecentDevelopments:    truncate(msg.GetRecentDevelopments(), maxProseChars),
			RiskFactors:           capItems(msg.GetRiskFactors(), maxListItems),
			Tags:                  capItems(msg.GetTags(), maxListItems),
		}
		for _, person := range capItems(msg.GetKeyPeople(), maxListItems) {
			if person == nil {
				continue
			}
			// Name and role only. The proto also carries bios, LinkedIn URLs
			// and hosted images; none of that helps answer a question about a
			// company, and the bios alone would double the payload.
			out.KeyPeople = append(out.KeyPeople, StockPerson{
				Name: person.GetName(),
				Role: person.GetRole(),
			})
		}

		summary := describeStockDetails(out)
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

func describeStockDetails(out GetStockDetailsOutput) string {
	if out.CompanyName == "" && out.Summary == "" {
		return fmt.Sprintf("No company profile is available for %s beyond its ticker code.", out.Code)
	}
	summary := fmt.Sprintf("%s — %s.", out.Code, nonEmpty(out.CompanyName, "name unknown"))
	if out.Industry != "" {
		summary += " Industry: " + out.Industry + "."
	}
	if out.Summary != "" {
		summary += " " + out.Summary
	}
	summary += " Profile text is AI-enriched from public sources and may be out of date."
	return summary
}

// ---------------------------------------------------------------------------
// get_director_trades
// ---------------------------------------------------------------------------

type GetDirectorTradesInput struct {
	Code  string `json:"code" jsonschema:"ASX ticker code, 3-4 alphanumeric characters, e.g. BHP. Case-insensitive."`
	Limit int    `json:"limit,omitempty" jsonschema:"How many trades to return, most recent first, 1-100. Defaults to 20."`
}

type DirectorTradeEntry struct {
	Date            string  `json:"date" jsonschema:"Trade date, YYYY-MM-DD."`
	DirectorName    string  `json:"director_name" jsonschema:"Name of the director as disclosed."`
	TradeType       string  `json:"trade_type" jsonschema:"One of buy, sell or exercise_options."`
	SharesTraded    int64   `json:"shares_traded" jsonschema:"Number of shares involved."`
	PricePerShare   float64 `json:"price_per_share" jsonschema:"Price per share in AUD. 0 when not disclosed."`
	TotalValue      float64 `json:"total_value" jsonschema:"Total consideration in AUD. 0 when not disclosed."`
	AnnouncementURL string  `json:"announcement_url,omitempty" jsonschema:"Link to the source ASX announcement, where known."`
}

type GetDirectorTradesOutput struct {
	Code       string               `json:"code" jsonschema:"ASX ticker code."`
	TotalCount int                  `json:"total_count" jsonschema:"Total recorded trades for this stock, before the limit was applied."`
	Returned   int                  `json:"returned" jsonschema:"How many trades this result contains."`
	Trades     []DirectorTradeEntry `json:"trades" jsonschema:"Trades, most recent first. Empty when none are recorded."`
}

const getDirectorTradesDescription = "List disclosed director (insider) trades for one ASX-listed company: date, director name, " +
	"whether it was a buy, a sell or an option exercise, the number of shares, price per share and total value " +
	"in AUD, plus a link to the source ASX announcement. Most recent first. Default 20 trades, hard maximum 100. " +
	"Extracted from ASX Appendix 3Y announcements, so coverage depends on what was announced and successfully " +
	"parsed — an empty result means nothing is RECORDED, not that no director traded. Price and value are 0 " +
	"where the announcement did not disclose them. " +
	"This is disclosed director dealing, unrelated to the ASIC short position data the other tools return."

func getDirectorTradesTool() Tool {
	tool := Tool{
		Name:        "get_director_trades",
		Title:       "List director trades for a stock",
		Description: getDirectorTradesDescription,
		RPC:         "shorts.v1alpha1.StockService.GetDirectorTrades",
		Domain:      "stock",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getDirectorTradesHandler(src))
	}
	return tool
}

func getDirectorTradesHandler(src DataSource) sdk.ToolHandlerFor[GetDirectorTradesInput, GetDirectorTradesOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetDirectorTradesInput) (*sdk.CallToolResult, GetDirectorTradesOutput, error) {
		code, err := normaliseCode(in.Code)
		if err != nil {
			return nil, GetDirectorTradesOutput{}, err
		}
		limit := clampLimit(in.Limit, defaultTradesLimit, maxListLimit)

		res, err := src.GetDirectorTrades(ctx, connect.NewRequest(&shortsv1alpha1.GetDirectorTradesRequest{
			StockCode: code,
			Limit:     limit,
		}))
		if err != nil {
			return nil, GetDirectorTradesOutput{}, fmt.Errorf("could not get director trades for %s: %w", code, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetDirectorTradesOutput{}, fmt.Errorf("no data returned for %s", code)
		}

		out := GetDirectorTradesOutput{
			Code:       code,
			TotalCount: int(res.Msg.GetTotalCount()),
			Trades:     []DirectorTradeEntry{},
		}
		for _, trade := range res.Msg.GetTrades() {
			if trade == nil {
				continue
			}
			out.Trades = append(out.Trades, DirectorTradeEntry{
				Date:            trade.GetTradeDate(),
				DirectorName:    trade.GetDirectorName(),
				TradeType:       trade.GetTradeType(),
				SharesTraded:    trade.GetSharesTraded(),
				PricePerShare:   finite(trade.GetPricePerShare()),
				TotalValue:      finite(trade.GetTotalValue()),
				AnnouncementURL: trade.GetAnnouncementUrl(),
			})
		}
		out.Returned = len(out.Trades)

		var summary string
		if out.Returned == 0 {
			summary = fmt.Sprintf("No director trades are recorded for %s. That means none were captured from ASX announcements, not necessarily that none occurred.", code)
		} else {
			latest := out.Trades[0]
			summary = fmt.Sprintf("%d of %d recorded director trades for %s. Most recent: %s %s %d shares on %s.",
				out.Returned, out.TotalCount, code, latest.DirectorName, latest.TradeType, latest.SharesTraded, latest.Date)
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// get_peer_comparison
// ---------------------------------------------------------------------------

type GetPeerComparisonInput struct {
	Code  string `json:"code" jsonschema:"ASX ticker code to compare, 3-4 alphanumeric characters, e.g. BHP. Case-insensitive."`
	Limit int    `json:"limit,omitempty" jsonschema:"How many industry peers to return, 1-20. Defaults to 5."`
}

type PeerStockEntry struct {
	Code          string   `json:"code" jsonschema:"ASX ticker code."`
	Name          string   `json:"name,omitempty" jsonschema:"Company name."`
	ShortPercent  float64  `json:"short_percent" jsonschema:"Reported short positions as a percentage of shares on issue, 0-100."`
	MarketCap     *float64 `json:"market_cap,omitempty" jsonschema:"Market capitalisation in AUD."`
	PERatio       *float64 `json:"pe_ratio,omitempty" jsonschema:"Price-to-earnings ratio."`
	DividendYield *float64 `json:"dividend_yield,omitempty" jsonschema:"Trailing dividend yield, percent."`
	PriceChange1M float64  `json:"price_change_1m" jsonschema:"One-month price change, percent."`
}

type GetPeerComparisonOutput struct {
	Code     string           `json:"code" jsonschema:"The stock being compared."`
	Industry string           `json:"industry,omitempty" jsonschema:"The industry the peer set was drawn from."`
	Subject  *PeerStockEntry  `json:"subject" jsonschema:"The stock being compared, with the same metrics as its peers."`
	Peers    []PeerStockEntry `json:"peers" jsonschema:"Industry peers. Empty when the stock has no classified industry neighbours."`
}

const getPeerComparisonDescription = "Compare one ASX stock against other companies in the same industry, on short interest " +
	"(percent of shares on issue), market capitalisation in AUD, P/E ratio, trailing dividend yield and " +
	"one-month price change. Returns the subject stock with the same metrics so the numbers can be read " +
	"side by side. Default 5 peers, hard maximum 20. " +
	"Peers are selected by Shorted's own industry classification, not GICS, and are the nearest neighbours by " +
	"industry — not a curated or analyst-defined comparable set. market_cap, pe_ratio and dividend_yield are " +
	"absent when unknown, never zero; that is common for P/E and dividend yield on small caps. " +
	"Short data is ASIC's, published T+4 business days; prices are end-of-day, not live."

func getPeerComparisonTool() Tool {
	tool := Tool{
		Name:        "get_peer_comparison",
		Title:       "Compare a stock with its industry peers",
		Description: getPeerComparisonDescription,
		RPC:         "shorts.v1alpha1.StockService.GetPeerComparison",
		Domain:      "stock",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getPeerComparisonHandler(src))
	}
	return tool
}

func getPeerComparisonHandler(src DataSource) sdk.ToolHandlerFor[GetPeerComparisonInput, GetPeerComparisonOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetPeerComparisonInput) (*sdk.CallToolResult, GetPeerComparisonOutput, error) {
		code, err := normaliseCode(in.Code)
		if err != nil {
			return nil, GetPeerComparisonOutput{}, err
		}
		limit := clampLimit(in.Limit, defaultPeerLimit, maxPeerLimit)

		res, err := src.GetPeerComparison(ctx, connect.NewRequest(&shortsv1alpha1.GetPeerComparisonRequest{
			StockCode: code,
			Limit:     limit,
		}))
		if err != nil {
			return nil, GetPeerComparisonOutput{}, fmt.Errorf("could not compare %s with its peers: %w", code, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetPeerComparisonOutput{}, fmt.Errorf("no data returned for %s", code)
		}
		subject := res.Msg.GetSubject()
		if subject == nil {
			// Peers without the stock they orbit are not a comparison, and
			// emitting them under this tool's name would invite the model to
			// read peer numbers as the subject's.
			return nil, GetPeerComparisonOutput{}, fmt.Errorf(
				"no ASX stock found with code %s to compare — check the ticker, or use search_stocks to find it by company name", code)
		}

		out := GetPeerComparisonOutput{
			Code:     code,
			Industry: res.Msg.GetIndustry(),
			Subject:  projectPeer(subject),
			Peers:    []PeerStockEntry{},
		}
		for _, peer := range res.Msg.GetPeers() {
			if peer == nil {
				continue
			}
			out.Peers = append(out.Peers, *projectPeer(peer))
		}

		var summary string
		if len(out.Peers) == 0 {
			summary = fmt.Sprintf("%s is %.2f%% short, but no industry peers are available to compare it against.",
				code, out.Subject.ShortPercent)
		} else {
			summary = fmt.Sprintf("%s (%.2f%% short) compared with %d peers in %s.",
				code, out.Subject.ShortPercent, len(out.Peers), nonEmpty(out.Industry, "its industry"))
			summary += asicCaveat
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// projectPeer narrows a PeerStock to the published fields. The proto also
// carries a logo URL, which is a rendering concern with no place in a tool
// result.
//
// Peers are read from mv_screener_data, which COALESCEs a missing market cap,
// P/E or dividend yield to 0, so 0 is the unknown sentinel on those three and
// knownFloat makes it an absent field rather than a real-looking zero.
func projectPeer(p *shortsv1alpha1.PeerStock) *PeerStockEntry {
	return &PeerStockEntry{
		Code:          p.GetStockCode(),
		Name:          p.GetCompanyName(),
		ShortPercent:  finite(p.GetShortPositionPercent()),
		MarketCap:     knownFloat(p.GetMarketCap()),
		PERatio:       knownFloat(p.GetPeRatio()),
		DividendYield: knownFloat(p.GetDividendYield()),
		PriceChange1M: finite(p.GetPriceChange_1M()),
	}
}

// ---------------------------------------------------------------------------
// get_stock_prices
// ---------------------------------------------------------------------------

type GetStockPricesInput struct {
	Code      string `json:"code" jsonschema:"ASX ticker code, 3-4 alphanumeric characters, e.g. BHP. Case-insensitive."`
	Period    string `json:"period,omitempty" jsonschema:"Lookback window: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX. Defaults to 1Y. Ignored when \"from\" is set."`
	From      string `json:"from,omitempty" jsonschema:"Start of an explicit window, YYYY-MM-DD."`
	To        string `json:"to,omitempty" jsonschema:"End of an explicit window, YYYY-MM-DD."`
	MaxPoints int    `json:"max_points,omitempty" jsonschema:"Cap on returned sessions, 1-5000. Defaults to 150."`
}

type StockPriceEntry struct {
	Date          string  `json:"date" jsonschema:"Trading date, YYYY-MM-DD."`
	Close         float64 `json:"close" jsonschema:"Closing price in AUD, as printed."`
	AdjustedClose float64 `json:"adjusted_close" jsonschema:"Close adjusted for splits and dividends. Compute returns from this, not from close."`
	Volume        int64   `json:"volume,omitempty" jsonschema:"Shares traded."`
}

type GetStockPricesOutput struct {
	Code              string            `json:"code" jsonschema:"ASX ticker code."`
	Currency          string            `json:"currency" jsonschema:"Currency of the prices, always AUD."`
	TotalObservations int               `json:"total_observations" jsonschema:"Trading sessions in the window before any thinning."`
	Returned          int               `json:"returned" jsonschema:"How many sessions this result contains."`
	Downsampled       bool              `json:"downsampled" jsonschema:"True when sessions were dropped to fit the cap. The first and last are always kept."`
	Points            []StockPriceEntry `json:"points" jsonschema:"Sessions, oldest first."`
}

const getStockPricesDescription = "Get adjusted daily prices and volume for one ASX-listed company over a window " +
	"(1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX; default 1Y), or an explicit from/to range. Each session " +
	"carries the close as printed, the close adjusted for splits and dividends, and the traded volume. " +
	"Use adjusted_close to compute returns; use close only to reconcile against another source. " +
	"These are the SAME ticker codes and the same dates as get_stock_history, so short interest and price can " +
	"be joined directly — no ticker mapping and no second adjustment methodology. " +
	"Combine the two to answer whether a heavily shorted name underperformed, or what price did after a squeeze. " +
	"Long windows are thinned to at most 150 sessions by default, always keeping the first and last; " +
	"total_observations reports the true count and downsampled says whether thinning happened."

func getStockPricesTool() Tool {
	tool := Tool{
		Name:        "get_stock_prices",
		Title:       "Get a stock's price and volume history",
		Description: getStockPricesDescription,
		RPC:         "shorts.v1alpha1.StockService.GetStockPrices",
		Domain:      "stock",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getStockPricesHandler(src))
	}
	return tool
}

func getStockPricesHandler(src DataSource) sdk.ToolHandlerFor[GetStockPricesInput, GetStockPricesOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetStockPricesInput) (*sdk.CallToolResult, GetStockPricesOutput, error) {
		code, err := normaliseCode(in.Code)
		if err != nil {
			return nil, GetStockPricesOutput{}, err
		}

		period := ""
		if in.Period != "" {
			period, err = normalisePeriod(in.Period)
			if err != nil {
				return nil, GetStockPricesOutput{}, err
			}
		}

		maxPoints := int32(maxPricePoints)
		if in.MaxPoints > 0 {
			if in.MaxPoints > maxRequestableHistoryPoints {
				return nil, GetStockPricesOutput{}, fmt.Errorf(
					"max_points must be between 1 and %d, got %d", maxRequestableHistoryPoints, in.MaxPoints)
			}
			maxPoints = int32(in.MaxPoints)
		}

		res, err := src.GetStockPrices(ctx, connect.NewRequest(&shortsv1alpha1.GetStockPricesRequest{
			ProductCode: code,
			Period:      period,
			From:        in.From,
			To:          in.To,
			MaxPoints:   maxPoints,
		}))
		if err != nil {
			if connect.CodeOf(err) == connect.CodeNotFound {
				return nil, GetStockPricesOutput{}, fmt.Errorf(
					"no price history held for %s — check the ticker with search_stocks", code)
			}
			return nil, GetStockPricesOutput{}, fmt.Errorf("could not get prices for %s: %w", code, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetStockPricesOutput{}, fmt.Errorf("no data returned for %s", code)
		}

		msg := res.Msg
		out := GetStockPricesOutput{
			Code:              nonEmpty(msg.GetProductCode(), code),
			Currency:          nonEmpty(msg.GetCurrency(), "AUD"),
			TotalObservations: int(msg.GetTotalObservations()),
			Downsampled:       msg.GetDownsampled(),
			Points:            []StockPriceEntry{},
		}
		for _, p := range msg.GetPoints() {
			if p == nil {
				continue
			}
			out.Points = append(out.Points, StockPriceEntry{
				Date:          p.GetDate(),
				Close:         finite(p.GetClose()),
				AdjustedClose: finite(p.GetAdjustedClose()),
				Volume:        p.GetVolume(),
			})
		}
		out.Returned = len(out.Points)

		var summary string
		if out.Returned == 0 {
			summary = fmt.Sprintf("No price history for %s in that window.", out.Code)
		} else {
			first, last := out.Points[0], out.Points[len(out.Points)-1]
			summary = fmt.Sprintf("%s: %.3f on %s to %.3f on %s (%d sessions",
				out.Code, first.AdjustedClose, first.Date, last.AdjustedClose, last.Date, out.TotalObservations)
			if out.Downsampled {
				summary += fmt.Sprintf(", thinned to %d", out.Returned)
			}
			summary += "; adjusted for splits and dividends)."
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// get_stock_fundamentals
// ---------------------------------------------------------------------------

const (
	defaultFundamentalsLimit = 8
	// maxFundamentalsLimit is inside the handler's own ceiling of 40
	// (validated in fundamentals.go), so a clamp is never an InvalidArgument
	// round trip. It came down from 40 when a period gained its statement
	// lines and per-field provenance and the result gained the quality block:
	// 24 fully reported periods with every provenance key and a full quality
	// block is the worst case payload_budget_test.go measures against the
	// 16KB per-call budget. Twenty-four is six years of annual, half and TTM
	// rows together, or a single period type over a longer run.
	maxFundamentalsLimit = 24
	// fundamentalsHandlerCeiling is the handler's own limit. With no period
	// type the tool reads this many rows and drops the quarter balance
	// snapshots, so they never crowd the statement periods out of the
	// result; the quality block already carries the latest balance sheet.
	fundamentalsHandlerCeiling = 40
)

// validFundamentalsPeriodTypes mirrors shortsstore.FundamentalsPeriodTypes.
// Validated here so a typo is a message the model can act on rather than an
// InvalidArgument it has to decode.
var validFundamentalsPeriodTypes = []string{"annual", "ttm", "half", "quarter"}

type GetStockFundamentalsInput struct {
	Code       string `json:"code" jsonschema:"ASX ticker code, e.g. BHP."`
	PeriodType string `json:"period_type,omitempty" jsonschema:"annual, ttm, half or quarter. Omit for all but quarter."`
	Limit      int    `json:"limit,omitempty" jsonschema:"1-24, default 8."`
}

// FundamentalsPeriodRow is one reported period. Every figure is a pointer that
// is absent when the filing did not report it: proto3 cannot tell 0 from
// missing, which is why the RPC carries has_* flags, and this is where they
// are honoured.
//
// Four of the twenty-one statement lines migration 000132 added are published
// per period, the ones the quality block's ratios cannot be checked without
// (operating income, capex, equity and net debt); the ratios themselves
// arrive computed in the quality block, and the full statements are on the
// stock page. field_sources is the RPC's per-field provenance map,
// passed through: it lists only the fields that did NOT come from the row's
// source, so it is absent on most rows.
type FundamentalsPeriodRow struct {
	PeriodType         string            `json:"period_type"`
	PeriodEnd          string            `json:"period_end"`
	FiscalYear         int               `json:"fiscal_year,omitempty"`
	Currency           string            `json:"currency,omitempty" jsonschema:"Only where it differs from the result's."`
	Revenue            *float64          `json:"revenue,omitempty"`
	OperatingIncome    *float64          `json:"operating_income,omitempty"`
	NetIncome          *float64          `json:"net_income,omitempty"`
	EPSDiluted         *float64          `json:"eps_diluted,omitempty"`
	EPSBasic           *float64          `json:"eps_basic,omitempty"`
	OperatingCashFlow  *float64          `json:"operating_cash_flow,omitempty"`
	CapitalExpenditure *float64          `json:"capital_expenditure,omitempty"`
	FreeCashFlow       *float64          `json:"free_cash_flow,omitempty"`
	TotalEquity        *float64          `json:"total_equity,omitempty"`
	NetDebt            *float64          `json:"net_debt,omitempty"`
	SharesOutstanding  *float64          `json:"shares_outstanding,omitempty"`
	Source             string            `json:"source,omitempty"`
	FieldSources       map[string]string `json:"field_sources,omitempty" jsonschema:"Where fields not from source came from."`
}

type FundamentalsGrowthSummary struct {
	BasisPeriodType        string   `json:"basis_period_type,omitempty" jsonschema:"Series EPS growth uses: ttm, annual or half."`
	RevenueBasisPeriodType string   `json:"revenue_basis_period_type,omitempty" jsonschema:"Series revenue growth uses: annual, ttm or half."`
	LatestPeriodEnd        string   `json:"latest_period_end,omitempty"`
	RevenueYoYPct          *float64 `json:"revenue_yoy_pct,omitempty"`
	EPSYoYPct              *float64 `json:"eps_yoy_pct,omitempty"`
	RevenueYoYPriorPct     *float64 `json:"revenue_yoy_prior_pct,omitempty" jsonschema:"The same growth a period earlier, for acceleration."`
	EPSYoYPriorPct         *float64 `json:"eps_yoy_prior_pct,omitempty"`
	RevenueHalfYoYPct      *float64 `json:"revenue_half_yoy_pct,omitempty" jsonschema:"Latest filed half vs the same half a year earlier."`
	EPSHalfYoYPct          *float64 `json:"eps_half_yoy_pct,omitempty"`
	HalfLatestPeriodEnd    string   `json:"half_latest_period_end,omitempty"`
	NetIncomePositive      bool     `json:"net_income_positive" jsonschema:"Latest annual. False also when unknown."`
	PeriodsAvailable       int      `json:"periods_available"`
	RevenueTTM             *float64 `json:"revenue_ttm,omitempty"`
	NetIncomeTTM           *float64 `json:"net_income_ttm,omitempty"`
	EPSTTM                 *float64 `json:"eps_ttm,omitempty"`
}

// FundamentalsQualitySummary is the ratios and valuation the API computed for
// one stock (plan docs/plans/fundamentals-coverage.md §2.7 and §5.3). Nothing
// here is recomputed: the API has already decided which ratios are not
// meaningful for a financial (and nulled them), and which valuation figures a
// non-AUD statement, an FX-converted vendor series or a listed unit that is
// not one ordinary share (a CDI) forbids. The projection only honours the
// has_* flags, so a withheld figure stays absent here too, and says why
// (not_meaningful, valuation_note).
//
// Flow ratios use ONE period (basis_period_*); balance ratios use the balance
// sheet aligned to it (balance_period_end, never after the flow period).
type FundamentalsQualitySummary struct {
	BasisPeriodType    string   `json:"basis_period_type,omitempty" jsonschema:"ttm or annual: every flow ratio uses this one period."`
	BasisPeriodEnd     string   `json:"basis_period_end,omitempty"`
	BalancePeriodEnd   string   `json:"balance_period_end,omitempty"`
	BalanceCurrency    string   `json:"balance_currency,omitempty"`
	GrossMarginPct     *float64 `json:"gross_margin_pct,omitempty"`
	OperatingMarginPct *float64 `json:"operating_margin_pct,omitempty"`
	NetMarginPct       *float64 `json:"net_margin_pct,omitempty"`
	FCFMarginPct       *float64 `json:"fcf_margin_pct,omitempty"`
	FCFConversion      *float64 `json:"fcf_conversion,omitempty" jsonschema:"FCF / net profit."`
	ROEPct             *float64 `json:"roe_pct,omitempty"`
	ROAPct             *float64 `json:"roa_pct,omitempty"`
	NetDebt            *float64 `json:"net_debt,omitempty" jsonschema:"Excluding leases; negative is net cash."`
	NetDebtToEBITDA    *float64 `json:"net_debt_to_ebitda,omitempty"`
	NetDebtToEquity    *float64 `json:"net_debt_to_equity,omitempty"`
	CurrentRatio       *float64 `json:"current_ratio,omitempty"`
	InterestCover      *float64 `json:"interest_cover,omitempty"`
	PayoutRatioPct     *float64 `json:"payout_ratio_pct,omitempty" jsonschema:"Cash dividends paid / net profit."`
	MarketCap          *float64 `json:"market_cap,omitempty" jsonschema:"AUD."`
	PERatio            *float64 `json:"pe_ratio,omitempty"`
	PriceToBook        *float64 `json:"price_to_book,omitempty"`
	PriceAsOf          string   `json:"price_as_of,omitempty"`
	ValuationNote      string   `json:"valuation_note,omitempty" jsonschema:"Why valuation is absent: non-aud (or FX-converted), listed-unit (e.g. a CDI), no-shares or no-price."`
	IsFinancial        bool     `json:"is_financial,omitempty"`
	IsProperty         bool     `json:"is_property,omitempty" jsonschema:"Profit includes revaluations."`
	NotMeaningful      []string `json:"not_meaningful,omitempty" jsonschema:"Withheld: not meaningful for a financial."`
}

// FundamentalsCoverageSummary says whether the collector has tried this stock
// and what it found, so an empty result reads as "not collected yet" or "our
// providers hold nothing" rather than "the company reports nothing". Absent is
// not a status: an API without the sync facts sends no status, and neither
// does this.
type FundamentalsCoverageSummary struct {
	Status        string   `json:"status,omitempty" jsonschema:"covered, empty (providers hold none), pending (not yet collected) or failed."`
	LastAttemptAt string   `json:"last_attempt_at,omitempty"`
	LastSuccessAt string   `json:"last_success_at,omitempty"`
	Sources       []string `json:"sources,omitempty"`
}

type GetStockFundamentalsOutput struct {
	Code     string                       `json:"code"`
	Currency string                       `json:"currency,omitempty" jsonschema:"Reporting currency of every figure. Not always AUD."`
	Count    int                          `json:"count"`
	Periods  []FundamentalsPeriodRow      `json:"periods" jsonschema:"Newest first."`
	Growth   *FundamentalsGrowthSummary   `json:"growth,omitempty"`
	Quality  *FundamentalsQualitySummary  `json:"quality,omitempty"`
	Coverage *FundamentalsCoverageSummary `json:"coverage,omitempty"`
}

const getStockFundamentalsDescription = "Reported financial statements for one ASX-listed company, newest first: " +
	"revenue, operating income, net income, EPS, cash flow, capex, equity, net debt and shares per annual, half-year " +
	"and trailing-twelve-month (ttm) period (quarter rows are balance snapshots); revenue and EPS growth year on year " +
	"and a period earlier (acceleration); quality ratios (margins, ROE, cash conversion, leverage, liquidity, payout) " +
	"and market cap, P/E and P/B. Figures are in the company's REPORTING currency (whole units, EPS per share), not " +
	"always AUD: BHP reports in USD. Growth compares the same series a year apart (annual on annual, ttm on ttm, or a " +
	"fresher filed half on the same half a year earlier). A figure not reported is absent, never zero; ratios not " +
	"meaningful for banks and insurers, and P/E and P/B for non-AUD statements or CDIs, are withheld with the reason. " +
	"Company-filed data via a market data provider and parsed ASX filings, not estimates or financial advice; small " +
	"caps can lag their filing by weeks. Valuation ratios use the latest close; no short data."

func getStockFundamentalsTool() Tool {
	tool := Tool{
		Name:        "get_stock_fundamentals",
		Title:       "Get a company's reported fundamentals",
		Description: getStockFundamentalsDescription,
		RPC:         "shorts.v1alpha1.StockService.GetStockFundamentals",
		Domain:      "stock",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getStockFundamentalsHandler(src))
	}
	return tool
}

func getStockFundamentalsHandler(src DataSource) sdk.ToolHandlerFor[GetStockFundamentalsInput, GetStockFundamentalsOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetStockFundamentalsInput) (*sdk.CallToolResult, GetStockFundamentalsOutput, error) {
		code, err := normaliseCode(in.Code)
		if err != nil {
			return nil, GetStockFundamentalsOutput{}, err
		}
		periodType := strings.ToLower(strings.TrimSpace(in.PeriodType))
		if periodType != "" && !contains(validFundamentalsPeriodTypes, periodType) {
			return nil, GetStockFundamentalsOutput{}, fmt.Errorf(
				"%q is not a period type: use one of %s, or omit it for every type but the quarter balance snapshots",
				in.PeriodType, strings.Join(validFundamentalsPeriodTypes, ", "))
		}
		limit := clampLimit(in.Limit, defaultFundamentalsLimit, maxFundamentalsLimit)
		readLimit := limit
		if periodType == "" {
			readLimit = fundamentalsHandlerCeiling
		}

		res, err := src.GetStockFundamentals(ctx, connect.NewRequest(&shortsv1alpha1.GetStockFundamentalsRequest{
			StockCode:  code,
			PeriodType: periodType,
			Limit:      readLimit,
		}))
		if err != nil {
			if connect.CodeOf(err) == connect.CodeNotFound {
				return nil, GetStockFundamentalsOutput{}, fmt.Errorf(
					"no ASX stock found with code %s — check the ticker, or use search_stocks to find it by company name", code)
			}
			return nil, GetStockFundamentalsOutput{}, fmt.Errorf("could not get fundamentals for %s: %w", code, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetStockFundamentalsOutput{}, fmt.Errorf("no data returned for %s", code)
		}

		msg := res.Msg
		out := GetStockFundamentalsOutput{
			Code:    nonEmpty(msg.GetStockCode(), code),
			Periods: []FundamentalsPeriodRow{},
		}
		// One currency for the whole result, taken from the newest period
		// that states one. A company that changed reporting currency keeps a
		// per-row currency on the periods that differ, so an old USD year can
		// never be read as AUD.
		for _, p := range msg.GetPeriods() {
			if c := strings.TrimSpace(p.GetCurrency()); c != "" {
				out.Currency = c
				break
			}
		}
		for _, p := range msg.GetPeriods() {
			if p == nil || (periodType == "" && p.GetPeriodType() == "quarter") {
				continue
			}
			if len(out.Periods) >= int(limit) {
				break
			}
			row := FundamentalsPeriodRow{
				PeriodType:         p.GetPeriodType(),
				PeriodEnd:          p.GetPeriodEnd(),
				FiscalYear:         int(p.GetFiscalYear()),
				Revenue:            optionalFloat(p.GetRevenue(), p.GetHasRevenue()),
				OperatingIncome:    optionalFloat(p.GetOperatingIncome(), p.GetHasOperatingIncome()),
				NetIncome:          optionalFloat(p.GetNetIncome(), p.GetHasNetIncome()),
				EPSDiluted:         optionalFloat(p.GetEpsDiluted(), p.GetHasEpsDiluted()),
				EPSBasic:           optionalFloat(p.GetEpsBasic(), p.GetHasEpsBasic()),
				OperatingCashFlow:  optionalFloat(p.GetOperatingCashFlow(), p.GetHasOperatingCashFlow()),
				CapitalExpenditure: optionalFloat(p.GetCapitalExpenditure(), p.GetHasCapitalExpenditure()),
				FreeCashFlow:       optionalFloat(p.GetFreeCashFlow(), p.GetHasFreeCashFlow()),
				TotalEquity:        optionalFloat(p.GetTotalEquity(), p.GetHasTotalEquity()),
				NetDebt:            optionalFloat(p.GetNetDebt(), p.GetHasNetDebt()),
				SharesOutstanding:  optionalFloat(p.GetSharesOutstanding(), p.GetHasSharesOutstanding()),
				Source:             p.GetSource(),
				FieldSources:       fieldSources(p.GetFieldSources()),
			}
			if c := strings.TrimSpace(p.GetCurrency()); c != "" && c != out.Currency {
				row.Currency = c
			}
			out.Periods = append(out.Periods, row)
			if len(out.Periods) == int(limit) {
				break
			}
		}
		out.Count = len(out.Periods)

		if g := msg.GetGrowth(); msg.GetHasGrowth() && g != nil {
			out.Growth = &FundamentalsGrowthSummary{
				BasisPeriodType:        g.GetBasisPeriodType(),
				RevenueBasisPeriodType: g.GetRevenueBasisPeriodType(),
				LatestPeriodEnd:        g.GetLatestPeriodEnd(),
				RevenueYoYPct:          roundedOptional(g.GetRevenueYoyPct(), g.GetHasRevenueYoy()),
				EPSYoYPct:              roundedOptional(g.GetEpsYoyPct(), g.GetHasEpsYoy()),
				RevenueYoYPriorPct:     roundedOptional(g.GetRevenueYoyPriorPct(), g.GetHasRevenueYoyPrior()),
				EPSYoYPriorPct:         roundedOptional(g.GetEpsYoyPriorPct(), g.GetHasEpsYoyPrior()),
				RevenueHalfYoYPct:      roundedOptional(g.GetRevenueHalfYoyPct(), g.GetHasRevenueHalfYoy()),
				EPSHalfYoYPct:          roundedOptional(g.GetEpsHalfYoyPct(), g.GetHasEpsHalfYoy()),
				HalfLatestPeriodEnd:    g.GetHalfLatestPeriodEnd(),
				NetIncomePositive:      g.GetNetIncomePositive(),
				PeriodsAvailable:       int(g.GetPeriodsAvailable()),
				RevenueTTM:             optionalFloat(g.GetRevenueTtm(), g.GetHasRevenueTtm()),
				NetIncomeTTM:           optionalFloat(g.GetNetIncomeTtm(), g.GetHasNetIncomeTtm()),
				EPSTTM:                 optionalFloat(g.GetEpsTtm(), g.GetHasEpsTtm()),
			}
		}
		if q := msg.GetQuality(); msg.GetHasQuality() && q != nil {
			out.Quality = projectQuality(q)
		}
		out.Coverage = projectCoverage(msg.GetCoverage())

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: describeFundamentals(out, periodType)}}}, out, nil
	}
}

// fieldSources copies the per-field provenance map, dropping empty keys and
// values; nil (and so absent) when nothing is left.
func fieldSources(in map[string]string) map[string]string {
	var out map[string]string
	for k, v := range in {
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if k == "" || v == "" {
			continue
		}
		if out == nil {
			out = make(map[string]string, len(in))
		}
		out[k] = v
	}
	return out
}

// projectQuality narrows FundamentalsQuality to the published fields. The
// proto also carries the dates and basis behind the share count and the P/E
// (shares_as_of, pe_eps_*), the balance lag, the flow row's source and the
// derived-cash-flow flag; the periods and their field_sources already carry
// that provenance.
func projectQuality(q *shortsv1alpha1.FundamentalsQuality) *FundamentalsQualitySummary {
	out := &FundamentalsQualitySummary{
		BasisPeriodType:    q.GetBasisPeriodType(),
		BasisPeriodEnd:     q.GetBasisPeriodEnd(),
		BalancePeriodEnd:   q.GetBalancePeriodEnd(),
		BalanceCurrency:    strings.TrimSpace(q.GetBalanceCurrency()),
		GrossMarginPct:     roundedOptional(q.GetGrossMarginPct(), q.GetHasGrossMarginPct()),
		OperatingMarginPct: roundedOptional(q.GetOperatingMarginPct(), q.GetHasOperatingMarginPct()),
		NetMarginPct:       roundedOptional(q.GetNetMarginPct(), q.GetHasNetMarginPct()),
		FCFMarginPct:       roundedOptional(q.GetFcfMarginPct(), q.GetHasFcfMarginPct()),
		FCFConversion:      roundedOptional(q.GetFcfConversion(), q.GetHasFcfConversion()),
		ROEPct:             roundedOptional(q.GetRoePct(), q.GetHasRoePct()),
		ROAPct:             roundedOptional(q.GetRoaPct(), q.GetHasRoaPct()),
		NetDebt:            optionalFloat(q.GetNetDebt(), q.GetHasNetDebt()),
		NetDebtToEBITDA:    roundedOptional(q.GetNetDebtToEbitda(), q.GetHasNetDebtToEbitda()),
		NetDebtToEquity:    roundedOptional(q.GetNetDebtToEquity(), q.GetHasNetDebtToEquity()),
		CurrentRatio:       roundedOptional(q.GetCurrentRatio(), q.GetHasCurrentRatio()),
		InterestCover:      roundedOptional(q.GetInterestCover(), q.GetHasInterestCover()),
		PayoutRatioPct:     roundedOptional(q.GetPayoutRatioPct(), q.GetHasPayoutRatioPct()),
		MarketCap:          optionalFloat(q.GetMarketCap(), q.GetHasMarketCap()),
		PERatio:            roundedOptional(q.GetPeRatio(), q.GetHasPeRatio()),
		PriceToBook:        roundedOptional(q.GetPriceToBook(), q.GetHasPriceToBook()),
		PriceAsOf:          q.GetPriceAsOf(),
		ValuationNote:      q.GetValuationNote(),
		IsFinancial:        q.GetIsFinancial(),
		IsProperty:         q.GetIsProperty(),
	}
	for _, name := range q.GetNotMeaningful() {
		if name = strings.TrimSpace(name); name != "" {
			out.NotMeaningful = append(out.NotMeaningful, name)
		}
	}
	return out
}

// projectCoverage passes the collector's coverage facts through, nil when
// there are none: an older API sends no coverage, and a status it could not
// determine is sent as "", which is not a status either.
func projectCoverage(c *shortsv1alpha1.FundamentalsCoverage) *FundamentalsCoverageSummary {
	if c == nil {
		return nil
	}
	out := &FundamentalsCoverageSummary{
		Status:        strings.TrimSpace(c.GetStatus()),
		LastAttemptAt: c.GetLastAttemptAt(),
		LastSuccessAt: c.GetLastSuccessAt(),
	}
	for _, src := range c.GetSources() {
		if src = strings.TrimSpace(src); src != "" {
			out.Sources = append(out.Sources, src)
		}
	}
	if out.Status == "" && out.LastAttemptAt == "" && out.LastSuccessAt == "" && len(out.Sources) == 0 {
		return nil
	}
	return out
}

func describeFundamentals(out GetStockFundamentalsOutput, periodType string) string {
	if out.Count == 0 && out.Growth == nil {
		if periodType == "" {
			if s := describeCoverageGap(out.Code, out.Coverage); s != "" {
				return s
			}
		}
		s := "No reported fundamentals are held for " + out.Code
		if periodType != "" {
			s += " with period type " + periodType
			if periodType == "quarter" {
				s += " (quarter rows are balance-sheet snapshots only; try annual, half or ttm)"
			}
		}
		return s + " yet. Coverage is still being filled in; this does not mean the company reported nothing."
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s: %d reported periods", out.Code, out.Count)
	if out.Count > 0 {
		fmt.Fprintf(&b, ", latest %s", latestPeriodLabel(out.Periods))
	}
	if out.Currency != "" {
		b.WriteString(", in " + out.Currency)
	}
	b.WriteString(".")
	if g := out.Growth; g != nil {
		if g.RevenueYoYPct != nil {
			fmt.Fprintf(&b, " Revenue %+.1f%% year on year (%s).", *g.RevenueYoYPct, nonEmpty(g.RevenueBasisPeriodType, "annual"))
		}
		if g.EPSYoYPct != nil {
			fmt.Fprintf(&b, " EPS %+.1f%% year on year (%s).", *g.EPSYoYPct, nonEmpty(g.BasisPeriodType, "annual"))
		}
		if g.RevenueYoYPct == nil && g.EPSYoYPct == nil {
			b.WriteString(" Not enough comparable periods for year-on-year growth.")
		}
	}
	b.WriteString(describeQuality(out.Quality))
	b.WriteString(" Company-filed figures in the reporting currency; absent means not reported. Not financial advice.")
	return b.String()
}

// latestPeriodLabel names the newest period with a statement behind it. A
// quarter row is only a balance-sheet snapshot, so it heads the label only
// when nothing else was returned.
func latestPeriodLabel(periods []FundamentalsPeriodRow) string {
	for _, p := range periods {
		if p.PeriodType != "quarter" {
			return p.PeriodType + " to " + p.PeriodEnd
		}
	}
	return "balance snapshot at " + periods[0].PeriodEnd
}

// describeCoverageGap explains an empty result from the collector's own
// record, in the stock page's words (plan §7.1). It never states or implies
// that a listed company publishes no statements. "" when coverage says
// nothing more specific than "not held yet".
func describeCoverageGap(code string, c *FundamentalsCoverageSummary) string {
	if c == nil {
		return ""
	}
	switch c.Status {
	case "empty":
		s := "Our data providers hold no financial statements for " + code
		if d := datePart(c.LastAttemptAt); d != "" {
			s += " (last checked " + d + ")"
		}
		return s + ". This does not mean the company reported nothing: its own filings are on the ASX announcements platform."
	case "pending":
		return "Fundamentals not yet collected for " + code + "."
	case "failed":
		s := "Fundamentals for " + code + " could not be collected"
		if d := datePart(c.LastAttemptAt); d != "" {
			s += " on " + d
		}
		return s + "; the next run retries."
	}
	return ""
}

// datePart is the YYYY-MM-DD prefix of an RFC 3339 timestamp.
func datePart(ts string) string {
	if len(ts) >= 10 {
		return ts[:10]
	}
	return ts
}

// describeQuality is one sentence of headline ratios and valuation, naming the
// basis, and what was withheld.
func describeQuality(q *FundamentalsQualitySummary) string {
	if q == nil {
		return ""
	}
	var parts []string
	if q.ROEPct != nil {
		parts = append(parts, fmt.Sprintf("ROE %.1f%%", *q.ROEPct))
	}
	if q.NetMarginPct != nil {
		parts = append(parts, fmt.Sprintf("net margin %.1f%%", *q.NetMarginPct))
	}
	if q.NetDebtToEBITDA != nil {
		parts = append(parts, fmt.Sprintf("net debt/EBITDA %.1fx", *q.NetDebtToEBITDA))
	}
	if q.PERatio != nil {
		parts = append(parts, fmt.Sprintf("P/E %.1f", *q.PERatio))
	}
	var b strings.Builder
	if len(parts) > 0 {
		b.WriteString(" " + strings.ToUpper(parts[0][:1]) + parts[0][1:])
		if len(parts) > 1 {
			b.WriteString(", " + strings.Join(parts[1:], ", "))
		}
		if q.BasisPeriodType != "" && q.BasisPeriodEnd != "" {
			fmt.Fprintf(&b, " (%s to %s)", q.BasisPeriodType, q.BasisPeriodEnd)
		}
		b.WriteString(".")
	}
	if q.IsFinancial && len(q.NotMeaningful) > 0 {
		b.WriteString(" Treated as a financial: " + strings.Join(q.NotMeaningful, ", ") + " are not meaningful and withheld.")
	}
	switch q.ValuationNote {
	case strategies.ValuationNoteNonAUD:
		b.WriteString(" P/E and P/B withheld: the statements are not in AUD (or are currency-converted).")
	case strategies.ValuationNoteListedUnit:
		b.WriteString(" Valuation withheld: the listed unit is not one ordinary share (for example a CDI).")
	}
	return b.String()
}
