package main

// ToolDefinition describes a function-calling tool for the LLM.
type ToolDefinition struct {
	Name        string
	Description string
	Parameters  map[string]ToolParameter
	Required    []string
}

// ToolParameter describes a single parameter for a tool.
type ToolParameter struct {
	Type        string   `json:"type"`
	Description string   `json:"description"`
	Enum        []string `json:"enum,omitempty"`
}

// GetToolDefinitions returns all available function-calling tools.
func GetToolDefinitions() []ToolDefinition {
	return []ToolDefinition{
		{
			Name:        "query_short_positions",
			Description: "Get short position time series data for a specific stock over a time period. Returns short interest percentages over time, at most 40 points, always including the first and the latest.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code (e.g., 'BHP', 'CBA')"},
				"period":     {Type: "string", Description: "Time period for data", Enum: []string{"1m", "3m", "6m", "1y", "2y", "5y", "max"}},
			},
			Required: []string{"stock_code"},
		},
		{
			Name:        "get_top_shorts",
			Description: "Get the top N most shorted stocks on the ASX, ranked by current short interest percentage. Returns each stock's code, name and latest short position, with a sparkline of its short interest over the last 3 months (up to 8 points, the first and the latest always included) for the highest-ranked stocks. When the answer is long, lower-ranked stocks come without a sparkline. Stocks are left out only if even the bare rows do not fit, and omittedStocks says how many. For the full daily history of one stock, use query_short_positions.",
			Parameters: map[string]ToolParameter{
				"limit": {Type: "integer", Description: "Number of stocks to return (default 10, max 50)"},
			},
		},
		{
			Name:        "get_stock_details",
			Description: "Get a stock's profile: company name, industry, market cap, valuation ratios (P/E, EPS, dividend yield, 52-week range), company summary, risk factors and key people. For short-position history use query_short_positions.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code"},
			},
			Required: []string{"stock_code"},
		},
		{
			Name:        "search_stocks",
			Description: "Search for stocks by company name or stock code. Useful when the user mentions a company name and you need to find the stock code.",
			Parameters: map[string]ToolParameter{
				"query": {Type: "string", Description: "Search query (company name or partial stock code)"},
				"limit": {Type: "integer", Description: "Maximum results to return (default 5)"},
			},
			Required: []string{"query"},
		},
		{
			Name:        "get_news",
			Description: "Get recent news articles for a specific stock or the broader market.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code (omit for market-wide news)"},
				"limit":      {Type: "integer", Description: "Number of articles to return (default 5)"},
			},
		},
		{
			Name:        "get_director_trades",
			Description: "Get recent director (insider) trades for a specific stock. Shows buys, sells, and option exercises by company directors.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code"},
				"limit":      {Type: "integer", Description: "Number of trades to return (default 10)"},
			},
			Required: []string{"stock_code"},
		},
		{
			Name:        "get_peer_comparison",
			Description: "Compare a stock with its industry peers. Returns short interest, market cap, P/E ratio, and dividend yield for peer companies.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code"},
				"limit":      {Type: "integer", Description: "Number of peers to return (default 5)"},
			},
			Required: []string{"stock_code"},
		},
		{
			Name:        "get_weekly_report",
			Description: "Get the latest weekly short selling analysis report with market trends, biggest movers, and sector analysis.",
			Parameters: map[string]ToolParameter{
				"week": {Type: "string", Description: "Week slug in YYYY-WNN format (e.g., '2026-W08'). Omit for the latest report."},
			},
		},
		{
			Name:        "get_related_news",
			Description: "Find news articles semantically related to a stock (cross-outlet, by meaning). Uses vector similarity to surface thematically relevant coverage beyond simple keyword matching.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code (e.g., 'BHP', 'CBA')"},
				"article_id": {Type: "string", Description: "Optional id of an article from an earlier get_news or get_related_news result, to find news related to that article instead of the stock's latest one. Omit it to relate to the stock's latest article."},
				"limit":      {Type: "integer", Description: "Number of related articles to return (default 5)"},
			},
			Required: []string{"stock_code"},
		},
		{
			Name:        "get_stock_graph",
			Description: "Get a stock's key people (directors/executives and their OTHER ASX board seats) and narrative-similar companies. Useful for mapping corporate networks and finding structurally similar peers.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code"},
				"limit":      {Type: "integer", Description: "Number of results to return (default 10)"},
			},
			Required: []string{"stock_code"},
		},
		{
			Name:        "get_event_timeline",
			Description: "Get a merged chronological timeline of a stock's events: announcements, director trades, price-sensitive news, and short-position spikes. Good for understanding what drove recent moves.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code"},
				"days_back":  {Type: "integer", Description: "How many calendar days back to include (default 90)"},
				"limit":      {Type: "integer", Description: "Maximum number of events to return (default 20)"},
			},
			Required: []string{"stock_code"},
		},
		{
			Name:        "get_stock_signals",
			Description: "Get a stock's risk and reputation signals — adverse items (court cases, sanctions, regulatory actions, complaints, safety incidents) and positive items (awards, favourable press), each with a severity rating, its date and, where known, the publisher's domain. Use when the user asks about a company's risks, controversies, legal issues, or reputation.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code"},
				"limit":      {Type: "integer", Description: "Max signals per polarity to fetch (default 10, max 50). At most 10 of each polarity reach the answer; omittedAdverse and omittedPositive count the rest."},
			},
			Required: []string{"stock_code"},
		},
		{
			Name: "get_economic_series",
			Description: "Get Australian macroeconomic and market series. Key families: " +
				"rates.cash_rate_target.aus; cpi.annual_change.all_groups.aus; cpi.index.all_groups.aus; " +
				"labour.unemployment_rate.total.{state}.seasadj; labour.job_vacancies.{state}; " +
				"wages.wpi_yoy.{state}; wages.real_wpi_yoy.{state}; " +
				"commodities.price_index.bulk.aus; credit.growth_yoy.housing.aus.seasadj; " +
				"markets.short_interest_wavg.{state}; markets.short_interest_avg.{industry}.aus; " +
				"trade.balance.total.{state}; spending.household.total.{state}.seasadj; " +
				"lending.new_commitments.investor.{state}.seasadj; " +
				"business.gross_operating_profit.{industry}.aus.seasadj; " +
				"construction.work_done.total.{state}.seasadj; " +
				"crime.victims.{offence}.{state}; crime.victims_rate_100k.{offence}.{state}. " +
				"State values: lowercase nsw/vic/qld/sa/wa/tas/nt/act. " +
				"Business industry values (ANZSIC divisions): mining, manufacturing, retail-trade. " +
				"Market industry values (GICS): materials, energy, banks. " +
				"Offence values: homicide, assault, sexual-assault, robbery, unlawful-entry, " +
				"motor-vehicle-theft, other-theft.",
			Parameters: map[string]ToolParameter{
				"series_keys": {Type: "array", Description: "Series keys to fetch (required, max 10)"},
				"limit":       {Type: "integer", Description: "Observations per series (default 12, max 60)"},
			},
			Required: []string{"series_keys"},
		},
	}
}

// answerWithoutDataTool is the tool a model calls when a reply needs no data. It
// is not a data tool: it makes no Shorts API call and is never shown to the
// person as a tool call. It exists so the first model call of a turn can be
// forced to choose a tool without forcing a data lookup for every message.
const answerWithoutDataTool = "answer_without_data"

// answerWithoutDataResult is the fixed result of answer_without_data. Executing
// the tool returns it at once, with no request.
const answerWithoutDataResult = `{"status":"ok","note":"No data was fetched. Answer from general knowledge of the concept or of how Shorted works, and state no figure about a stock, the market, an economic series or a person."}`

// answerWithoutDataDefinition declares answer_without_data to the model. It is
// kept apart from GetToolDefinitions, which lists the data tools that map to API
// calls and are checked against those calls by the contract tests.
func answerWithoutDataDefinition() ToolDefinition {
	return ToolDefinition{
		Name: answerWithoutDataTool,
		Description: "Call this ONLY when the reply needs no data: a greeting, a definition, an explanation of a " +
			"concept, or how to use Shorted. NEVER call it when the reply will contain any figure about a stock, " +
			"the market, an economic series or a person. For those, call the data tool that returns the figure.",
	}
}
