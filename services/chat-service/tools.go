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
			Description: "Get short position time series data for a specific stock over a time period. Returns daily short interest percentages.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code (e.g., 'BHP', 'CBA')"},
				"period":     {Type: "string", Description: "Time period for data", Enum: []string{"1m", "3m", "6m", "1y", "2y", "5y", "max"}},
			},
			Required: []string{"stock_code"},
		},
		{
			Name:        "get_top_shorts",
			Description: "Get the top N most shorted stocks on the ASX, sorted by short interest percentage.",
			Parameters: map[string]ToolParameter{
				"limit":  {Type: "integer", Description: "Number of stocks to return (default 10, max 50)"},
				"period": {Type: "string", Description: "Time period for trend data", Enum: []string{"1m", "3m", "6m", "1y", "max"}},
			},
		},
		{
			Name:        "get_stock_details",
			Description: "Get detailed information about a specific stock including company name, industry, market cap, and current short position.",
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
			Description: "Get a stock's risk and reputation signals — adverse items (court cases, sanctions, regulatory actions, complaints, safety incidents) and positive items (awards, favourable press), each with a severity rating and source citations. Use when the user asks about a company's risks, controversies, legal issues, or reputation.",
			Parameters: map[string]ToolParameter{
				"stock_code": {Type: "string", Description: "ASX stock code"},
				"limit":      {Type: "integer", Description: "Max signals per polarity (default 10, max 50)"},
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
