package mcp

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Discovery, news and reports.
//
// The three "which stocks?" tools are deliberately distinct shapes, because
// that is the axis a model has to choose on:
//
//	list_top_shorts        rank by short interest, no filters
//	list_squeeze_candidates rank by a computed squeeze/divergence score
//	screen_stocks          filter by criteria the caller supplies
//
// Each of the three names the other two in its description and says what it is
// NOT, so the choice is made from the descriptions rather than from the names.

// ---------------------------------------------------------------------------
// search_stocks
// ---------------------------------------------------------------------------

type SearchStocksInput struct {
	Query string `json:"query" jsonschema:"Free-text search over ASX ticker codes and company names, e.g. \"pilbara\", \"commonwealth bank\", \"BHP\". Required."`
	Limit int    `json:"limit,omitempty" jsonschema:"How many matches to return, 1-25. Defaults to 10. Values above 25 are clamped, not rejected."`
}

type StockMatch struct {
	Code           string  `json:"code" jsonschema:"ASX ticker code."`
	Name           string  `json:"name,omitempty" jsonschema:"Company or product name."`
	Industry       string  `json:"industry,omitempty" jsonschema:"Industry classification, where known."`
	PercentShorted float64 `json:"percent_shorted" jsonschema:"Latest reported short positions as a percentage of shares on issue, 0-100. 0 when not reported."`
}

type SearchStocksOutput struct {
	Query   string       `json:"query" jsonschema:"The query actually searched."`
	Count   int          `json:"count" jsonschema:"How many matches this result contains."`
	Matches []StockMatch `json:"matches" jsonschema:"Matching stocks, best match first. Empty when nothing matched."`
}

const searchStocksDescription = "Find ASX-listed stocks by company name or ticker code when you do not already know the code. " +
	"Free-text search over names and codes; returns ticker, company name, industry and the latest reported " +
	"short position as a percentage of shares on issue. Default 10 matches, hard maximum 25. " +
	"Use this FIRST whenever a question names a company rather than a ticker, then pass the code it returns to " +
	"get_stock, get_stock_details, get_stock_news or get_director_trades. " +
	"Ranking is by search relevance, NOT by short interest or size — it is a lookup, not a ranking; use " +
	"list_top_shorts or screen_stocks for those. An empty result means nothing matched the query, not that the " +
	"company is unlisted; try a shorter or differently spelled query."

func searchStocksTool() Tool {
	tool := Tool{
		Name:        "search_stocks",
		Title:       "Find an ASX stock by name or code",
		Description: searchStocksDescription,
		RPC:         "shorts.v1alpha1.SearchService.SearchStocks",
		Domain:      "discovery",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), searchStocksHandler(src))
	}
	return tool
}

func searchStocksHandler(src DataSource) sdk.ToolHandlerFor[SearchStocksInput, SearchStocksOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in SearchStocksInput) (*sdk.CallToolResult, SearchStocksOutput, error) {
		query := strings.TrimSpace(in.Query)
		if query == "" {
			// Checked here so a blank query is a message the model can act on
			// rather than an InvalidArgument it has to decode.
			return nil, SearchStocksOutput{}, fmt.Errorf(
				"query is required: pass a company name or ASX ticker code to search for, e.g. \"pilbara\" or \"BHP\"")
		}
		limit := clampLimit(in.Limit, defaultSearchLimit, maxSearchLimit)

		res, err := src.SearchStocks(ctx, connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
			Query: query,
			Limit: limit,
		}))
		if err != nil {
			return nil, SearchStocksOutput{}, fmt.Errorf("could not search for %q: %w", query, err)
		}
		if res == nil || res.Msg == nil {
			return nil, SearchStocksOutput{}, fmt.Errorf("no data returned for the search %q", query)
		}

		out := SearchStocksOutput{Query: query, Matches: []StockMatch{}}
		for _, stock := range res.Msg.GetStocks() {
			if stock == nil {
				continue
			}
			out.Matches = append(out.Matches, StockMatch{
				Code:           stock.GetProductCode(),
				Name:           stock.GetName(),
				Industry:       stock.GetIndustry(),
				PercentShorted: fromFloat32(stock.GetPercentageShorted()),
			})
		}
		out.Count = len(out.Matches)

		var summary string
		if out.Count == 0 {
			summary = fmt.Sprintf("No ASX-listed stocks matched %q. Try a shorter query, or a different spelling.", query)
		} else {
			best := out.Matches[0]
			summary = fmt.Sprintf("%d ASX stocks matched %q. Best match: %s (%s).",
				out.Count, query, best.Code, nonEmpty(best.Name, "name unknown"))
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// screen_stocks
// ---------------------------------------------------------------------------

// ScreenStocksInput is a flattened view of ScreenerFilters.
//
// Flattened, and not the proto's nested RangeFilter-per-dimension shape,
// because a model fills a schema far more reliably from named scalars than
// from twelve identical {min,max,has_min,has_max} objects. Every numeric bound
// is a POINTER: the proto gates each bound on a has_min/has_max flag, so
// "unset" and "zero" are genuinely different requests — max_pe_ratio=0 would
// screen for companies with a P/E of at most zero.
//
// The surface is deliberately a subset of ScreenerFilters. It covers the
// dimensions a question is actually phrased in; net_director_buy and
// avg_sentiment remain available as SORTS rather than as filters, and
// product_codes is omitted because filtering a screen to codes you already
// have is get_stock's job.
type ScreenStocksInput struct {
	MinShortPct         *float64 `json:"min_short_pct,omitempty" jsonschema:"Minimum short interest, percent of shares on issue (0-100)."`
	MaxShortPct         *float64 `json:"max_short_pct,omitempty" jsonschema:"Maximum short interest, percent of shares on issue (0-100)."`
	MinShortPctChange4W *float64 `json:"min_short_pct_change_4w,omitempty" jsonschema:"Minimum four-week change in short interest, in percentage points. Positive values find stocks where shorts are building."`
	MaxShortPctChange4W *float64 `json:"max_short_pct_change_4w,omitempty" jsonschema:"Maximum four-week change in short interest, in percentage points. Negative values find stocks where shorts are covering."`
	MinDaysToCover      *float64 `json:"min_days_to_cover,omitempty" jsonschema:"Minimum days-to-cover: short position divided by 20-day average volume."`
	MaxDaysToCover      *float64 `json:"max_days_to_cover,omitempty" jsonschema:"Maximum days-to-cover."`
	MinMarketCap        *float64 `json:"min_market_cap,omitempty" jsonschema:"Minimum market capitalisation in AUD, e.g. 1000000000 for one billion."`
	MaxMarketCap        *float64 `json:"max_market_cap,omitempty" jsonschema:"Maximum market capitalisation in AUD."`
	MinPriceChange1M    *float64 `json:"min_price_change_1m,omitempty" jsonschema:"Minimum one-month price change, percent."`
	MaxPriceChange1M    *float64 `json:"max_price_change_1m,omitempty" jsonschema:"Maximum one-month price change, percent."`
	MinPERatio          *float64 `json:"min_pe_ratio,omitempty" jsonschema:"Minimum price-to-earnings ratio."`
	MaxPERatio          *float64 `json:"max_pe_ratio,omitempty" jsonschema:"Maximum price-to-earnings ratio."`
	MinDividendYield    *float64 `json:"min_dividend_yield,omitempty" jsonschema:"Minimum trailing dividend yield, percent."`
	Industries          []string `json:"industries,omitempty" jsonschema:"Restrict to these industries. Names must match Shorted's own classification exactly, e.g. \"Metals & Mining\", \"Energy\", \"Financials\" — the industry values returned by get_industry_treemap or get_stock."`
	HasDirectorBuys     bool     `json:"has_director_buys,omitempty" jsonschema:"When true, only stocks with recent disclosed director purchases."`
	SortBy              string   `json:"sort_by,omitempty" jsonschema:"Sort by one of: short_pct (default), short_pct_change, market_cap, price_change_1m, pe_ratio, dividend_yield, net_director_buy, news_sentiment, days_to_cover."`
	SortDirection       string   `json:"sort_direction,omitempty" jsonschema:"\"desc\" (default, highest first) or \"asc\"."`
	Limit               int      `json:"limit,omitempty" jsonschema:"How many stocks to return, 1-50. Defaults to 20. Values above 50 are clamped, not rejected."`
}

type ScreenedStock struct {
	Rank                 int     `json:"rank" jsonschema:"Position in the sorted result, 1 = first."`
	Code                 string  `json:"code" jsonschema:"ASX ticker code."`
	Name                 string  `json:"name,omitempty" jsonschema:"Company name."`
	Industry             string  `json:"industry,omitempty" jsonschema:"Industry classification, where known."`
	ShortPercent         float64 `json:"short_percent" jsonschema:"Reported short positions as a percentage of shares on issue, 0-100."`
	ShortPercentChange4W float64 `json:"short_percent_change_4w" jsonschema:"Four-week change in that percentage, in percentage points."`
	DaysToCover          float64 `json:"days_to_cover" jsonschema:"Short position divided by 20-day average volume. 0 when volume is unknown."`
	LatestPrice          float64 `json:"latest_price" jsonschema:"Most recent close in AUD. 0 when unknown."`
	PriceChange1M        float64 `json:"price_change_1m" jsonschema:"One-month price change, percent."`
	MarketCap            float64 `json:"market_cap" jsonschema:"Market capitalisation in AUD. 0 when unknown."`
	PERatio              float64 `json:"pe_ratio" jsonschema:"Price-to-earnings ratio. 0 when unknown or not meaningful."`
	DividendYield        float64 `json:"dividend_yield" jsonschema:"Trailing dividend yield, percent. 0 when unknown."`
	NetDirectorBuyValue  float64 `json:"net_director_buy_value" jsonschema:"Disclosed director buys minus sells, AUD, recent window."`
	NewsCount30D         int     `json:"news_count_30d" jsonschema:"Articles matched to this stock in the last 30 days."`
	AvgSentiment         float64 `json:"avg_sentiment" jsonschema:"Mean model-classified sentiment of those articles, -1 (negative) to 1 (positive). 0 when there is no news."`
}

type ScreenStocksOutput struct {
	TotalCount int             `json:"total_count" jsonschema:"How many stocks matched the criteria in total, before the limit was applied."`
	Count      int             `json:"count" jsonschema:"How many stocks this result contains."`
	SortedBy   string          `json:"sorted_by" jsonschema:"The sort field actually used."`
	Direction  string          `json:"direction" jsonschema:"The sort direction actually used."`
	Stocks     []ScreenedStock `json:"stocks" jsonschema:"Matching stocks in sorted order. Empty when nothing met the criteria."`
}

const screenStocksDescription = "Filter ASX-listed stocks by CRITERIA and return the matches, sorted. This is the tool for any " +
	"question with conditions in it — \"heavily shorted miners under $1bn\", \"stocks where shorts are building " +
	"but the price is falling\", \"high days-to-cover with recent director buying\". " +
	"Filterable: short interest percent, four-week change in short interest (percentage points), days-to-cover, " +
	"market cap in AUD, one-month price change percent, P/E, dividend yield, industry, and whether directors " +
	"have recently bought. Sortable by any of short_pct, short_pct_change, market_cap, price_change_1m, " +
	"pe_ratio, dividend_yield, net_director_buy, news_sentiment or days_to_cover, ascending or descending. " +
	"Every bound is optional and omitting one means no bound — it does NOT mean zero. " +
	"Default 20 stocks, hard maximum 50; total_count reports how many actually matched, so a full result means " +
	"there are more. " +
	"Use list_top_shorts instead for a plain \"what is most shorted\" ranking with no criteria, and " +
	"list_squeeze_candidates instead when the question is about squeeze RISK, which is a composite score this " +
	"tool cannot filter on. Industry names must match Shorted's own classification (not GICS) exactly. " +
	"Short data is ASIC's, published T+4 business days; prices are end-of-day, not live. " +
	"Coverage is the screener dataset (~3,300 listed stocks), so a stock with no price or fundamentals data " +
	"can be absent from a screen that its short position would otherwise satisfy."

// screenerSortFields maps the tool's stable, readable sort names to the proto
// enum. Readable names rather than the enum's own SCREENER_SORT_FIELD_ prefix,
// because the model has to type them.
var screenerSortFields = map[string]shortsv1alpha1.ScreenerSortField{
	"short_pct":        shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_SHORT_PCT,
	"short_pct_change": shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_SHORT_PCT_CHANGE,
	"market_cap":       shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_MARKET_CAP,
	"price_change_1m":  shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_PRICE_CHANGE_1M,
	"pe_ratio":         shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_PE_RATIO,
	"dividend_yield":   shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_DIVIDEND_YIELD,
	"net_director_buy": shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_NET_DIRECTOR_BUY,
	"news_sentiment":   shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_NEWS_SENTIMENT,
	"days_to_cover":    shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_DAYS_TO_COVER,
}

// screenerSortList is the human-readable form used in the error message, sorted
// so the message is stable rather than map-iteration order.
var screenerSortList = sortedKeys(screenerSortFields)

func screenStocksTool() Tool {
	tool := Tool{
		Name:        "screen_stocks",
		Title:       "Filter ASX stocks by criteria",
		Description: screenStocksDescription,
		RPC:         "shorts.v1alpha1.ScreenerService.ScreenStocks",
		Domain:      "discovery",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), screenStocksHandler(src))
	}
	return tool
}

func screenStocksHandler(src DataSource) sdk.ToolHandlerFor[ScreenStocksInput, ScreenStocksOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in ScreenStocksInput) (*sdk.CallToolResult, ScreenStocksOutput, error) {
		sortName := strings.ToLower(strings.TrimSpace(in.SortBy))
		if sortName == "" {
			sortName = "short_pct"
		}
		sortField, ok := screenerSortFields[sortName]
		if !ok {
			return nil, ScreenStocksOutput{}, fmt.Errorf(
				"%q is not a sortable field: use one of %s", in.SortBy, strings.Join(screenerSortList, ", "))
		}

		direction := strings.ToLower(strings.TrimSpace(in.SortDirection))
		var pbDirection shortsv1alpha1.SortDirection
		switch direction {
		case "", "desc":
			direction, pbDirection = "desc", shortsv1alpha1.SortDirection_SORT_DIRECTION_DESC
		case "asc":
			pbDirection = shortsv1alpha1.SortDirection_SORT_DIRECTION_ASC
		default:
			return nil, ScreenStocksOutput{}, fmt.Errorf(
				"%q is not a valid sort direction: use \"desc\" or \"asc\"", in.SortDirection)
		}

		limit := clampLimit(in.Limit, defaultScreenerLimit, maxScreenerLimit)
		filters := buildScreenerFilters(in)

		res, err := src.ScreenStocks(ctx, connect.NewRequest(&shortsv1alpha1.ScreenStocksRequest{
			Filters:       filters,
			SortField:     sortField,
			SortDirection: pbDirection,
			Limit:         limit,
		}))
		if err != nil {
			return nil, ScreenStocksOutput{}, fmt.Errorf("could not screen stocks: %w", err)
		}
		if res == nil || res.Msg == nil {
			return nil, ScreenStocksOutput{}, fmt.Errorf("no data returned for the screen")
		}

		out := ScreenStocksOutput{
			TotalCount: int(res.Msg.GetTotalCount()),
			SortedBy:   sortName,
			Direction:  direction,
			Stocks:     []ScreenedStock{},
		}
		for i, stock := range res.Msg.GetStocks() {
			if stock == nil {
				continue
			}
			// Projected, not passed through: the proto also carries a logo URL,
			// raw volumes, franking percentages and price-sensitive counts, none
			// of which answer a screening question and all of which would join
			// the published contract by default.
			out.Stocks = append(out.Stocks, ScreenedStock{
				Rank:                 i + 1,
				Code:                 stock.GetStockCode(),
				Name:                 stock.GetCompanyName(),
				Industry:             stock.GetIndustry(),
				ShortPercent:         stock.GetShortPct(),
				ShortPercentChange4W: stock.GetShortPctChange_4W(),
				DaysToCover:          stock.GetDaysToCover(),
				LatestPrice:          stock.GetLatestPrice(),
				PriceChange1M:        stock.GetPriceChange_1M(),
				MarketCap:            stock.GetMarketCap(),
				PERatio:              stock.GetPeRatio(),
				DividendYield:        stock.GetDividendYield(),
				NetDirectorBuyValue:  stock.GetNetDirectorBuyValue(),
				NewsCount30D:         int(stock.GetNewsCount_30D()),
				AvgSentiment:         stock.GetAvgSentiment(),
			})
		}
		out.Count = len(out.Stocks)

		var summary string
		if out.Count == 0 {
			// Say it plainly: an empty list is otherwise easy to read as "no such
			// stocks exist" rather than "these criteria matched nothing".
			summary = "No ASX stocks matched those criteria. Try loosening a bound, or dropping the industry filter."
		} else {
			lead := out.Stocks[0]
			summary = fmt.Sprintf("%d of %d matching ASX stocks, sorted by %s %s. First: %s (%s) at %.2f%% short, %.1f days to cover.",
				out.Count, out.TotalCount, sortName, direction, lead.Code,
				nonEmpty(lead.Name, "name unknown"), lead.ShortPercent, lead.DaysToCover)
			summary += asicCaveat
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// buildScreenerFilters translates the flat input into the proto's filter
// message, returning nil when the caller supplied no criteria at all — an empty
// ScreenerFilters and no ScreenerFilters are the same screen, and sending nil
// keeps the handler's cache key identical to an unfiltered call from the site.
func buildScreenerFilters(in ScreenStocksInput) *shortsv1alpha1.ScreenerFilters {
	filters := &shortsv1alpha1.ScreenerFilters{
		ShortPct:        rangeFilter(in.MinShortPct, in.MaxShortPct),
		ShortPctChange:  rangeFilter(in.MinShortPctChange4W, in.MaxShortPctChange4W),
		DaysToCover:     rangeFilter(in.MinDaysToCover, in.MaxDaysToCover),
		MarketCap:       rangeFilter(in.MinMarketCap, in.MaxMarketCap),
		PriceChange_1M:  rangeFilter(in.MinPriceChange1M, in.MaxPriceChange1M),
		PeRatio:         rangeFilter(in.MinPERatio, in.MaxPERatio),
		DividendYield:   rangeFilter(in.MinDividendYield, nil),
		Industries:      trimmedNonEmpty(in.Industries),
		HasDirectorBuys: in.HasDirectorBuys,
	}
	if filters.ShortPct == nil && filters.ShortPctChange == nil && filters.DaysToCover == nil &&
		filters.MarketCap == nil && filters.PriceChange_1M == nil && filters.PeRatio == nil &&
		filters.DividendYield == nil && len(filters.Industries) == 0 && !filters.HasDirectorBuys {
		return nil
	}
	return filters
}

// rangeFilter builds a bound only where one was supplied. The has_min/has_max
// flags are what the store gates on (postgres_screener.go), so a bound sent
// without its flag is silently ignored — a filter that appears to do nothing.
func rangeFilter(min, max *float64) *shortsv1alpha1.RangeFilter {
	if min == nil && max == nil {
		return nil
	}
	out := &shortsv1alpha1.RangeFilter{}
	if min != nil {
		out.Min, out.HasMin = *min, true
	}
	if max != nil {
		out.Max, out.HasMax = *max, true
	}
	return out
}

// ---------------------------------------------------------------------------
// get_stock_news
// ---------------------------------------------------------------------------

type GetStockNewsInput struct {
	Code      string `json:"code" jsonschema:"ASX ticker code, 3-4 alphanumeric characters, e.g. BHP. Case-insensitive."`
	Limit     int    `json:"limit,omitempty" jsonschema:"How many articles to return, most recent first, 1-30. Defaults to 10."`
	Sentiment string `json:"sentiment,omitempty" jsonschema:"Optional filter: \"positive\", \"negative\" or \"neutral\". Omit for all."`
	Source    string `json:"source,omitempty" jsonschema:"Optional filter by publisher, e.g. \"asx\", \"stockhead\", \"livewire\", \"afr\". Omit for all."`
}

type NewsArticleEntry struct {
	Headline         string  `json:"headline" jsonschema:"Article headline as published."`
	URL              string  `json:"url" jsonschema:"Link to the article at its publisher. Cite this, not Shorted."`
	Source           string  `json:"source,omitempty" jsonschema:"Publisher, e.g. asx, stockhead, livewire, afr."`
	PublishedAt      string  `json:"published_at,omitempty" jsonschema:"Publication date, YYYY-MM-DD. Empty when the feed gave no date."`
	Sentiment        string  `json:"sentiment,omitempty" jsonschema:"positive, negative or neutral, assigned by a language model — not the publisher's or the market's view."`
	IsPriceSensitive bool    `json:"is_price_sensitive" jsonschema:"True for ASX announcements flagged price-sensitive by the exchange. False for ordinary media coverage."`
	RelevanceScore   float64 `json:"relevance_score" jsonschema:"How strongly the article was matched to this stock, 0-1. Low scores mean a passing mention."`
	SyndicationCount int     `json:"syndication_count" jsonschema:"How many mastheads carried this story, including this one. 1 means unsyndicated."`
	Summary          string  `json:"summary,omitempty" jsonschema:"Short summary where one exists, truncated to about 400 characters."`
}

type GetStockNewsOutput struct {
	Code string `json:"code" jsonschema:"ASX ticker code."`
	// NOT a total. The news store returns len(articles) AFTER applying the
	// limit (postgres_news.go:75), so this always equals Returned. Naming it
	// total_count promised a number the backend does not compute, and the test
	// fake supplied one independently — so the tests passed against behaviour
	// that does not exist. Renamed rather than deleted so the shape stays
	// legible next to screen_stocks, whose total_count IS a real COUNT(*) OVER().
	MatchedCount int                `json:"matched_count" jsonschema:"Articles in this result. The news backend does not report a total held count, so this equals returned."`
	Returned     int                `json:"returned" jsonschema:"How many articles this result contains."`
	Articles     []NewsArticleEntry `json:"articles" jsonschema:"Articles, most recent first. Empty when none are held."`
}

const getStockNewsDescription = "List recent news and ASX announcements matched to one ASX-listed company: headline, publisher, " +
	"publication date, a link to the original article, a short summary where one exists, and whether the ASX " +
	"flagged the announcement price-sensitive. Most recent first. Default 10 articles, hard maximum 30. " +
	"Optionally filter by sentiment or by publisher. " +
	"SENTIMENT IS ASSIGNED BY A LANGUAGE MODEL from the headline and summary. It is a classification, not the " +
	"publisher's position, an analyst view, or a measured market reaction — report it as such, and prefer the " +
	"article itself. Articles are aggregated from public RSS feeds and ASX announcements and are retained for 90 " +
	"days, so this is not a complete archive and an empty result means nothing was CAPTURED, not that nothing " +
	"was published. Link to the publisher's URL when citing. " +
	"This returns coverage only — no short position, price or valuation data."

var validNewsSentiments = []string{"positive", "negative", "neutral"}

func getStockNewsTool() Tool {
	tool := Tool{
		Name:        "get_stock_news",
		Title:       "List recent news for a stock",
		Description: getStockNewsDescription,
		RPC:         "shorts.v1alpha1.NewsService.GetStockNews",
		Domain:      "news",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getStockNewsHandler(src))
	}
	return tool
}

func getStockNewsHandler(src DataSource) sdk.ToolHandlerFor[GetStockNewsInput, GetStockNewsOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetStockNewsInput) (*sdk.CallToolResult, GetStockNewsOutput, error) {
		code, err := normaliseCode(in.Code)
		if err != nil {
			return nil, GetStockNewsOutput{}, err
		}

		sentiment := strings.ToLower(strings.TrimSpace(in.Sentiment))
		if sentiment != "" && !contains(validNewsSentiments, sentiment) {
			// The store passes an unrecognised sentiment straight into the query
			// and returns nothing, which reads as "no news" rather than "bad
			// filter". Reject it here instead.
			return nil, GetStockNewsOutput{}, fmt.Errorf(
				"%q is not a valid sentiment filter: use one of %s, or omit it",
				in.Sentiment, strings.Join(validNewsSentiments, ", "))
		}
		limit := clampLimit(in.Limit, defaultNewsLimit, maxNewsLimit)

		source := strings.ToLower(strings.TrimSpace(in.Source))

		res, err := src.GetStockNews(ctx, connect.NewRequest(&shortsv1alpha1.GetStockNewsRequest{
			StockCode: code,
			Limit:     limit,
			Sentiment: sentiment,
			Source:    source,
		}))
		if err != nil {
			return nil, GetStockNewsOutput{}, fmt.Errorf("could not get news for %s: %w", code, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetStockNewsOutput{}, fmt.Errorf("no data returned for %s", code)
		}

		out := GetStockNewsOutput{
			Code:         code,
			MatchedCount: int(res.Msg.GetTotalCount()),
			Articles:     []NewsArticleEntry{},
		}
		for _, article := range res.Msg.GetArticles() {
			if article == nil {
				continue
			}
			entry := NewsArticleEntry{
				Headline:         article.GetHeadline(),
				URL:              article.GetUrl(),
				Source:           article.GetSource(),
				Sentiment:        article.GetSentiment(),
				IsPriceSensitive: article.GetIsPriceSensitive(),
				RelevanceScore:   article.GetRelevanceScore(),
				SyndicationCount: int(article.GetSyndicationCount()),
				Summary:          truncate(article.GetSummary(), maxNewsSummaryChars),
			}
			// The proto also carries an internal id, a hero image URL, tags and
			// the list of syndicating mastheads. None of those answer a question
			// about a company, and the images are a rendering concern.
			if ts := article.GetPublishedAt(); ts != nil {
				entry.PublishedAt = ts.AsTime().UTC().Format("2006-01-02")
			}
			out.Articles = append(out.Articles, entry)
		}
		out.Returned = len(out.Articles)

		var summary string
		if out.Returned == 0 {
			summary = fmt.Sprintf("No news articles are held for %s", code)
			if sentiment != "" || source != "" {
				summary += " matching those filters"
			}
			summary += ". That means none were captured, not that none were published."
		} else {
			latest := out.Articles[0]
			summary = fmt.Sprintf("%d articles for %s. Most recent: %q (%s, %s).",
				out.Returned, code, latest.Headline,
				nonEmpty(latest.Source, "source unknown"), nonEmpty(latest.PublishedAt, "date unknown"))
			summary += " Sentiment labels are classified by a language model, not stated by the publisher."
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// list_reports
// ---------------------------------------------------------------------------

type ListReportsInput struct {
	ReportType string `json:"report_type,omitempty" jsonschema:"Filter to \"weekly\", \"monthly\" or \"yearly\". Omit or pass \"all\" for every type."`
	Limit      int    `json:"limit,omitempty" jsonschema:"How many reports to return, most recent first, 1-50. Defaults to 12."`
}

type ReportSummary struct {
	Slug               string   `json:"slug" jsonschema:"Identifier to pass to get_report. \"2026-W23\" is an ISO week, \"2026-05\" a month, \"2025\" a year."`
	ReportType         string   `json:"report_type" jsonschema:"weekly, monthly or yearly."`
	Headline           string   `json:"headline,omitempty" jsonschema:"The report's headline. Machine-generated."`
	Summary            string   `json:"summary,omitempty" jsonschema:"One-paragraph standfirst, truncated to about 320 characters. Machine-generated."`
	ReportDate         string   `json:"report_date,omitempty" jsonschema:"Latest trading day covered, YYYY-MM-DD."`
	MaxShortPercent    float64  `json:"max_short_percent" jsonschema:"Highest short interest in the period, percent of shares on issue."`
	MaxShortCode       string   `json:"max_short_code,omitempty" jsonschema:"The stock holding that position."`
	TotalStocksShorted int      `json:"total_stocks_shorted" jsonschema:"How many stocks had a reported short position in the period."`
	TopCodes           []string `json:"top_codes,omitempty" jsonschema:"Up to five most shorted tickers in the period."`
}

type ListReportsOutput struct {
	ReportType string          `json:"report_type" jsonschema:"The filter actually applied, or \"all\"."`
	Count      int             `json:"count" jsonschema:"How many reports this result contains."`
	Reports    []ReportSummary `json:"reports" jsonschema:"Reports, most recent first. Empty when none are published."`
}

const listReportsDescription = "List published Shorted short-selling reports, most recent first, with each one's slug, headline, " +
	"standfirst, period end date and headline statistics (the most shorted stock and its percentage, how many " +
	"stocks were shorted, the top five tickers). " +
	"This is the DISCOVERY path for reports: pass a slug from here to get_report to read one. Never guess a slug. " +
	"Reports come in three periods and the SLUG SHAPE says which: \"2026-W23\" is ISO week 23 of 2026, " +
	"\"2026-05\" is May 2026, \"2025\" is the 2025 calendar year. Filter with report_type if you want only one " +
	"kind. Default 12 reports, hard maximum 50. " +
	"Headlines and summaries are GENERATED by a language model from the underlying ASIC data — they are " +
	"Shorted's own commentary, not journalism, analyst research or investment advice. The statistics are " +
	"computed from ASIC's short position report, published T+4 business days."

var validReportTypeFilters = []string{"all", "weekly", "monthly", "yearly"}

func listReportsTool() Tool {
	tool := Tool{
		Name:        "list_reports",
		Title:       "List published short-selling reports",
		Description: listReportsDescription,
		RPC:         "shorts.v1alpha1.ReportsService.ListReports",
		Domain:      "reports",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), listReportsHandler(src))
	}
	return tool
}

func listReportsHandler(src DataSource) sdk.ToolHandlerFor[ListReportsInput, ListReportsOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in ListReportsInput) (*sdk.CallToolResult, ListReportsOutput, error) {
		reportType := strings.ToLower(strings.TrimSpace(in.ReportType))
		if reportType != "" && !contains(validReportTypeFilters, reportType) {
			return nil, ListReportsOutput{}, fmt.Errorf(
				"%q is not a report type: use one of %s, or omit it for all",
				in.ReportType, strings.Join(validReportTypeFilters, ", "))
		}
		limit := clampLimit(in.Limit, defaultReportsLimit, maxReportsLimit)

		res, err := src.ListReports(ctx, connect.NewRequest(&shortsv1alpha1.ListReportsRequest{
			ReportType: reportType,
			Limit:      limit,
		}))
		if err != nil {
			return nil, ListReportsOutput{}, fmt.Errorf("could not list reports: %w", err)
		}
		if res == nil || res.Msg == nil {
			return nil, ListReportsOutput{}, fmt.Errorf("no data returned when listing reports")
		}

		out := ListReportsOutput{
			ReportType: nonEmpty(reportType, "all"),
			Reports:    []ReportSummary{},
		}
		for _, item := range res.Msg.GetReports() {
			if item == nil {
				continue
			}
			// report_type is re-derived from the slug rather than trusted from the
			// row: the slug shape is what actually disambiguates the period, and
			// the stored column has been empty on older rows.
			out.Reports = append(out.Reports, ReportSummary{
				Slug:               item.GetSlug(),
				ReportType:         nonEmpty(reportTypeForSlug(item.GetSlug()), item.GetReportType()),
				Headline:           item.GetHeadline(),
				Summary:            truncate(item.GetSummary(), maxReportSummaryChars),
				ReportDate:         item.GetReportDate(),
				MaxShortPercent:    item.GetMaxShortPct(),
				MaxShortCode:       item.GetMaxShortCode(),
				TotalStocksShorted: int(item.GetTotalStocksShorted()),
				TopCodes:           item.GetTopCodes(),
				// quality_score and top_logo_urls are deliberately dropped: the
				// first is an internal publication gate an agent would misread as
				// a confidence score, the second is a rendering concern.
			})
		}
		out.Count = len(out.Reports)

		var summary string
		if out.Count == 0 {
			summary = fmt.Sprintf("No %s reports are published.", out.ReportType)
		} else {
			latest := out.Reports[0]
			summary = fmt.Sprintf("%d published %s reports. Most recent: %s (%s) — %q. Pass a slug to get_report to read one.",
				out.Count, out.ReportType, latest.Slug, nonEmpty(latest.ReportDate, "date unknown"),
				nonEmpty(latest.Headline, "no headline"))
			summary += " Report headlines and narrative are generated by a language model from ASIC data."
		}

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// get_report
// ---------------------------------------------------------------------------

// Report slug shapes. One weekly_reports table holds all three periods and the
// SLUG SHAPE is what disambiguates them (see reportTypeFromSlug in
// list_reports.go). These are tighter than the handler's own
// `^\d{4}(-W\d{2}|-\d{2})?$`, which accepts "2026-13" and "2026-W99" and turns
// them into a NotFound the model will read as "no report was published".
var (
	weeklySlugRe  = regexp.MustCompile(`^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$`)
	monthlySlugRe = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)
	yearlySlugRe  = regexp.MustCompile(`^\d{4}$`)
)

// reportTypeForSlug mirrors reportTypeFromSlug in the shorts service. It is
// duplicated rather than imported because that package imports this one's
// consumer; the shapes are asserted by TestGetReportAcceptsAllThreeSlugShapes.
func reportTypeForSlug(slug string) string {
	switch {
	case weeklySlugRe.MatchString(slug):
		return "weekly"
	case monthlySlugRe.MatchString(slug):
		return "monthly"
	case yearlySlugRe.MatchString(slug):
		return "yearly"
	default:
		return ""
	}
}

type GetReportInput struct {
	Slug string `json:"slug" jsonschema:"Report identifier from list_reports. The shape sets the period: \"2026-W23\" is ISO week 23 of 2026, \"2026-05\" is May 2026, \"2025\" is the 2025 calendar year. Use list_reports to find valid slugs rather than constructing one."`
}

type ReportNarrative struct {
	OpeningHook      string `json:"opening_hook,omitempty" jsonschema:"Opening. Generated; truncated to ~800 chars."`
	TopAnalysis      string `json:"top_analysis,omitempty" jsonschema:"On the most shorted stocks. Generated; truncated to ~800 chars."`
	MoversAnalysis   string `json:"movers_analysis,omitempty" jsonschema:"On the biggest movers. Generated; truncated to ~800 chars."`
	IndustryAnalysis string `json:"industry_analysis,omitempty" jsonschema:"By industry. Generated; truncated to ~800 chars."`
	Outlook          string `json:"outlook,omitempty" jsonschema:"Closing outlook. Generated; truncated to ~800 chars."`
}

type ReportMarketStats struct {
	TotalStocksShorted int     `json:"total_stocks_shorted" jsonschema:"Stocks with a reported short position."`
	AvgShortPercent    float64 `json:"avg_short_percent" jsonschema:"Mean short interest, percent."`
	MedianShortPercent float64 `json:"median_short_percent" jsonschema:"Median, percent."`
	MaxShortPercent    float64 `json:"max_short_percent" jsonschema:"Highest, percent."`
	MaxShortCode       string  `json:"max_short_code,omitempty" jsonschema:"Ticker holding it."`
	AvgChange          float64 `json:"avg_change" jsonschema:"Change in the average vs the prior period, percentage points."`
	StocksAbove10Pct   int     `json:"stocks_above_10pct" jsonschema:"Stocks at or above 10% short."`
	StocksAbove5Pct    int     `json:"stocks_above_5pct" jsonschema:"Stocks at or above 5% short."`
	RiserCount         int     `json:"riser_count" jsonschema:"Stocks whose short interest rose."`
	FallerCount        int     `json:"faller_count" jsonschema:"Stocks whose short interest fell."`
}

type ReportStock struct {
	Rank         int     `json:"rank" jsonschema:"Position in the most-shorted list."`
	Code         string  `json:"code" jsonschema:"ASX ticker code."`
	Name         string  `json:"name,omitempty" jsonschema:"Company name."`
	Industry     string  `json:"industry,omitempty" jsonschema:"Industry classification, where known."`
	ShortPercent float64 `json:"short_percent" jsonschema:"Short interest at period end, percent of shares on issue."`
	Change       float64 `json:"change" jsonschema:"Change over the period, percentage points."`
	DaysToCover  float64 `json:"days_to_cover" jsonschema:"Short position divided by 20-day average volume. 0 when unknown."`
	IsNewEntrant bool    `json:"is_new_entrant" jsonschema:"Not in the previous period's top list."`
}

type ReportMover struct {
	Code           string  `json:"code" jsonschema:"ASX ticker code."`
	Name           string  `json:"name,omitempty" jsonschema:"Company name."`
	Industry       string  `json:"industry,omitempty" jsonschema:"Industry classification, where known."`
	CurrentPercent float64 `json:"current_percent" jsonschema:"Short interest at period end, percent."`
	PreviousPct    float64 `json:"previous_percent" jsonschema:"At the start of the period, percent."`
	Change         float64 `json:"change" jsonschema:"Change over the period, percentage points."`
	ZScore         float64 `json:"z_score" jsonschema:"How unusual the move is vs this stock's own history. Shorted's derived metric."`
	StreakPeriods  int     `json:"streak_periods" jsonschema:"Consecutive periods moving in the same direction."`
}

type ReportIndustryStat struct {
	Industry        string  `json:"industry" jsonschema:"Industry name, Shorted's classification."`
	AvgShortPercent float64 `json:"avg_short_percent" jsonschema:"Industry mean, percent."`
	Change          float64 `json:"change" jsonschema:"Change over the period, percentage points."`
	StockCount      int     `json:"stock_count" jsonschema:"Shorted stocks in it."`
	TopStockCode    string  `json:"top_stock_code,omitempty" jsonschema:"Its most shorted stock."`
	TopStockPercent float64 `json:"top_stock_percent" jsonschema:"Its short interest, percent."`
}

type ReportCitation struct {
	Source string `json:"source,omitempty" jsonschema:"What was cited, e.g. \"BHP H1 FY2026 Results\"."`
	Date   string `json:"date,omitempty" jsonschema:"Date of the cited item."`
	URL    string `json:"url,omitempty" jsonschema:"Link to it."`
	Type   string `json:"type,omitempty" jsonschema:"financial_report, announcement, asic_data or price_data."`
}

type GetReportOutput struct {
	Slug              string               `json:"slug" jsonschema:"The report's slug."`
	ReportType        string               `json:"report_type" jsonschema:"weekly, monthly or yearly, derived from the slug shape."`
	Headline          string               `json:"headline,omitempty" jsonschema:"The report's headline. Machine-generated."`
	Summary           string               `json:"summary,omitempty" jsonschema:"One-paragraph standfirst. Machine-generated."`
	ReportDate        string               `json:"report_date,omitempty" jsonschema:"Latest trading day covered, YYYY-MM-DD."`
	PreviousDate      string               `json:"previous_date,omitempty" jsonschema:"Comparison date the changes are measured against, YYYY-MM-DD."`
	Narrative         *ReportNarrative     `json:"narrative,omitempty" jsonschema:"Five machine-generated prose sections."`
	MarketStats       *ReportMarketStats   `json:"market_stats,omitempty" jsonschema:"Market-wide statistics computed from ASIC data, not generated."`
	TopShorted        []ReportStock        `json:"top_shorted,omitempty" jsonschema:"Most shorted stocks, at most 10."`
	Risers            []ReportMover        `json:"risers,omitempty" jsonschema:"Largest increases, at most 5."`
	Fallers           []ReportMover        `json:"fallers,omitempty" jsonschema:"Largest decreases, at most 5."`
	IndustryBreakdown []ReportIndustryStat `json:"industry_breakdown,omitempty" jsonschema:"By industry, at most 10."`
	Citations         []ReportCitation     `json:"citations,omitempty" jsonschema:"Sources cited, at most 10."`
}

const getReportDescription = "Read one published Shorted short-selling report: its narrative sections, market-wide statistics, " +
	"the period's most shorted stocks, the biggest risers and fallers in short interest, a breakdown by " +
	"industry, and the sources the narrative cites. " +
	"The slug identifies both the report and its period BY SHAPE: \"2026-W23\" is ISO week 23 of 2026, " +
	"\"2026-05\" is May 2026, \"2025\" is the 2025 calendar year. Use list_reports to find a valid slug — do not " +
	"construct one, because a period with no published report returns nothing at all. " +
	"THE NARRATIVE IS GENERATED BY A LANGUAGE MODEL from the underlying data. It is Shorted's own editorial " +
	"commentary — not journalism, not analyst research, not investment advice — and should be attributed that " +
	"way rather than cited as a primary source. The STATISTICS are computed from ASIC's short position report " +
	"(published T+4 business days) and are not generated; prefer them, and the citations, for factual claims. " +
	"Sections are capped: narrative prose is truncated to about 800 characters each, top_shorted to 10 stocks, " +
	"risers and fallers to 5 each, industries and citations to 10. The published report at " +
	"shorted.com.au/reports carries the full text, plus FAQs and per-stock trend detail this tool omits."

func getReportTool() Tool {
	tool := Tool{
		Name:        "get_report",
		Title:       "Read a short-selling report",
		Description: getReportDescription,
		RPC:         "shorts.v1alpha1.ReportsService.GetWeeklyReport",
		Domain:      "reports",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getReportHandler(src))
	}
	return tool
}

func getReportHandler(src DataSource) sdk.ToolHandlerFor[GetReportInput, GetReportOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetReportInput) (*sdk.CallToolResult, GetReportOutput, error) {
		slug := strings.ToUpper(strings.TrimSpace(in.Slug))
		reportType := reportTypeForSlug(slug)
		if reportType == "" {
			return nil, GetReportOutput{}, fmt.Errorf(
				"%q is not a valid report slug: use \"YYYY-Www\" for a week (e.g. 2026-W23), \"YYYY-MM\" for a "+
					"month (e.g. 2026-05) or \"YYYY\" for a year (e.g. 2025). Call list_reports to find published slugs",
				in.Slug)
		}

		res, err := src.GetWeeklyReport(ctx, connect.NewRequest(&shortsv1alpha1.GetWeeklyReportRequest{
			WeekSlug: slug,
		}))
		if err != nil {
			if connect.CodeOf(err) == connect.CodeNotFound {
				return nil, GetReportOutput{}, fmt.Errorf(
					"no %s report is published for %s — call list_reports to see which periods exist", reportType, slug)
			}
			return nil, GetReportOutput{}, fmt.Errorf("could not read the report for %s: %w", slug, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetReportOutput{}, fmt.Errorf("no data returned for report %s", slug)
		}

		msg := res.Msg
		out := GetReportOutput{
			Slug:       nonEmpty(msg.GetWeekSlug(), slug),
			ReportType: reportType,
			// Bounded like every other prose field. The generator writes the
			// summary into unbounded JSONB and it does run long — list_reports
			// truncates the same field for that reason — so passing it through
			// raw put this tool over its 16KB budget (measured: 18,672 bytes
			// with a 5.9KB stored summary).
			Headline:     truncate(msg.GetHeadline(), maxHeadlineChars),
			Summary:      truncate(msg.GetSummary(), maxReportStandfirstChars),
			ReportDate:   msg.GetReportDate(),
			PreviousDate: msg.GetPreviousDate(),
		}
		if n := msg.GetNarrative(); n != nil {
			out.Narrative = &ReportNarrative{
				OpeningHook:      truncate(n.GetOpeningHook(), maxNarrativeChars),
				TopAnalysis:      truncate(n.GetTopAnalysis(), maxNarrativeChars),
				MoversAnalysis:   truncate(n.GetMoversAnalysis(), maxNarrativeChars),
				IndustryAnalysis: truncate(n.GetIndustryAnalysis(), maxNarrativeChars),
				Outlook:          truncate(n.GetOutlook(), maxNarrativeChars),
			}
		}
		if s := msg.GetMarketStats(); s != nil {
			out.MarketStats = &ReportMarketStats{
				TotalStocksShorted: int(s.GetTotalStocksShorted()),
				AvgShortPercent:    s.GetAvgShortPct(),
				MedianShortPercent: s.GetMedianShortPct(),
				MaxShortPercent:    s.GetMaxShortPct(),
				MaxShortCode:       s.GetMaxShortCode(),
				AvgChange:          s.GetWowAvgChange(),
				StocksAbove10Pct:   int(s.GetStocksAbove_10Pct()),
				StocksAbove5Pct:    int(s.GetStocksAbove_5Pct()),
				RiserCount:         int(s.GetRiserCount()),
				FallerCount:        int(s.GetFallerCount()),
			}
		}
		for _, stock := range capItems(msg.GetTopShorted(), maxReportStocks) {
			if stock == nil {
				continue
			}
			// The proto also carries a ~13-point weekly history array and a logo
			// URL per stock. The history alone would be most of the payload, for
			// a shape get_stock_history already serves properly.
			out.TopShorted = append(out.TopShorted, ReportStock{
				Rank:         int(stock.GetRank()),
				Code:         stock.GetCode(),
				Name:         stock.GetName(),
				Industry:     stock.GetIndustry(),
				ShortPercent: stock.GetShortPct(),
				Change:       stock.GetWowChange(),
				DaysToCover:  stock.GetDaysToCover(),
				IsNewEntrant: stock.GetIsNewEntrant(),
			})
		}
		out.Risers = projectReportMovers(msg.GetRisers())
		out.Fallers = projectReportMovers(msg.GetFallers())
		for _, stat := range capItems(msg.GetIndustryBreakdown(), maxReportIndustries) {
			if stat == nil {
				continue
			}
			out.IndustryBreakdown = append(out.IndustryBreakdown, ReportIndustryStat{
				Industry:        stat.GetIndustry(),
				AvgShortPercent: stat.GetAvgShortPct(),
				Change:          stat.GetWowChange(),
				StockCount:      int(stat.GetStockCount()),
				TopStockCode:    stat.GetTopStockCode(),
				TopStockPercent: stat.GetTopStockPct(),
			})
		}
		for _, cite := range capItems(msg.GetCitations(), maxReportCitations) {
			if cite == nil {
				continue
			}
			out.Citations = append(out.Citations, ReportCitation{
				Source: cite.GetSource(),
				Date:   cite.GetDate(),
				URL:    cite.GetUrl(),
				Type:   cite.GetType(),
			})
		}

		summary := fmt.Sprintf("%s report %s (%s): %s",
			capitalise(reportType), out.Slug, nonEmpty(out.ReportDate, "date unknown"),
			nonEmpty(out.Headline, "no headline"))
		if out.MarketStats != nil {
			summary += fmt.Sprintf(" %d stocks shorted, averaging %.2f%%; most shorted %s at %.2f%%.",
				out.MarketStats.TotalStocksShorted, out.MarketStats.AvgShortPercent,
				nonEmpty(out.MarketStats.MaxShortCode, "unknown"), out.MarketStats.MaxShortPercent)
		}
		summary += " The narrative is generated by a language model from ASIC data; the statistics are computed from it." + asicCaveat

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

func projectReportMovers(in []*shortsv1alpha1.WeeklyReportMover) []ReportMover {
	out := make([]ReportMover, 0, maxReportMovers)
	for _, mover := range capItems(in, maxReportMovers) {
		if mover == nil {
			continue
		}
		out = append(out, ReportMover{
			Code:           mover.GetCode(),
			Name:           mover.GetName(),
			Industry:       mover.GetIndustry(),
			CurrentPercent: mover.GetCurrentPct(),
			PreviousPct:    mover.GetPreviousPct(),
			Change:         mover.GetChange(),
			ZScore:         mover.GetZScore(),
			StreakPeriods:  int(mover.GetStreakWeeks()),
		})
	}
	return out
}
