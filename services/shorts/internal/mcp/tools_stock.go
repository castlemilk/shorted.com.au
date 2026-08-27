package mcp

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
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
	Period string `json:"period,omitempty" jsonschema:"Lookback window: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX. Defaults to 1M."`
}

type StockHistoryPoint struct {
	Date         string  `json:"date" jsonschema:"Observation date, YYYY-MM-DD."`
	ShortPercent float64 `json:"short_percent" jsonschema:"Reported short positions as a percentage of total product in issue on that date, 0-100."`
}

type GetStockHistoryOutput struct {
	Code               string              `json:"code" jsonschema:"ASX ticker code."`
	Name               string              `json:"name,omitempty" jsonschema:"Company or product name."`
	Period             string              `json:"period" jsonschema:"The lookback window actually used."`
	LatestShortPercent float64             `json:"latest_short_percent" jsonschema:"Most recent reported short position in the series, percent of shares on issue."`
	TotalObservations  int                 `json:"total_observations" jsonschema:"How many daily observations exist in the window, BEFORE downsampling."`
	Returned           int                 `json:"returned" jsonschema:"How many points this result contains."`
	Downsampled        bool                `json:"downsampled" jsonschema:"True when the series was thinned to fit the 200-point cap. The first and last observations are always kept."`
	Points             []StockHistoryPoint `json:"points" jsonschema:"The series, oldest first. Empty when no history exists for the window."`
}

const getStockHistoryDescription = "Get the time series of a single ASX stock's reported short position over a lookback " +
	"window (1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y or MAX; default 1M). Each point is a date and the percent of " +
	"total product in issue held short on that date (0-100). Use this for trend questions — is short interest " +
	"rising, when did it peak, how does it compare to a year ago. " +
	"Long windows are DOWNSAMPLED to at most 200 evenly-spaced points, always keeping the first and last " +
	"observation; total_observations reports the true count and downsampled says whether thinning happened, so " +
	"the series is right for trends but should not be treated as a complete daily record. " +
	"This is short interest only — it contains no price, volume or return series. " +
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

		res, err := src.GetStockData(ctx, connect.NewRequest(&shortsv1alpha1.GetStockDataRequest{
			ProductCode: code,
			Period:      period,
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
		sampled := downsample(all, maxHistoryPoints)

		out := GetStockHistoryOutput{
			Code:               nonEmpty(msg.GetProductCode(), code),
			Name:               msg.GetName(),
			Period:             period,
			LatestShortPercent: msg.GetLatestShortPosition(),
			TotalObservations:  len(all),
			Downsampled:        len(sampled) < len(all),
			Points:             []StockHistoryPoint{},
		}
		for _, point := range sampled {
			if point == nil || point.GetTimestamp() == nil {
				continue
			}
			out.Points = append(out.Points, StockHistoryPoint{
				Date:         point.GetTimestamp().AsTime().UTC().Format("2006-01-02"),
				ShortPercent: point.GetShortPosition(),
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
				PricePerShare:   trade.GetPricePerShare(),
				TotalValue:      trade.GetTotalValue(),
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
	Code          string  `json:"code" jsonschema:"ASX ticker code."`
	Name          string  `json:"name,omitempty" jsonschema:"Company name."`
	ShortPercent  float64 `json:"short_percent" jsonschema:"Reported short positions as a percentage of shares on issue, 0-100."`
	MarketCap     float64 `json:"market_cap" jsonschema:"Market capitalisation in AUD. 0 when unknown."`
	PERatio       float64 `json:"pe_ratio" jsonschema:"Price-to-earnings ratio. 0 when unknown or not meaningful."`
	DividendYield float64 `json:"dividend_yield" jsonschema:"Trailing dividend yield, percent. 0 when unknown."`
	PriceChange1M float64 `json:"price_change_1m" jsonschema:"One-month price change, percent."`
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
	"industry — not a curated or analyst-defined comparable set. Metrics are 0 where unknown, which is common " +
	"for P/E and dividend yield on small caps; treat 0 as missing, not as a real value. " +
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
func projectPeer(p *shortsv1alpha1.PeerStock) *PeerStockEntry {
	return &PeerStockEntry{
		Code:          p.GetStockCode(),
		Name:          p.GetCompanyName(),
		ShortPercent:  p.GetShortPositionPercent(),
		MarketCap:     p.GetMarketCap(),
		PERatio:       p.GetPeRatio(),
		DividendYield: p.GetDividendYield(),
		PriceChange1M: p.GetPriceChange_1M(),
	}
}
