package main

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"google.golang.org/protobuf/proto"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

const (
	// legacyShortsService is the monolithic service that carries every Shorts API
	// rpc a chat tool calls. It stays the path for these calls because it is the
	// public-API surface; the request messages are the same ones the domain
	// services use.
	legacyShortsService = "ShortedStocksService"

	// economyService hosts GetEconomicSeries, the one rpc a chat tool calls on a
	// domain service rather than the legacy one.
	economyService = "EconomyService"
)

// toolCall is one Shorts API call that a model tool maps to: the Connect service
// and method, and the generated request message that is sent as Connect JSON.
//
// The request is always a message from the generated package. Its field names
// come from the protos, so a wrong key such as stockCode for product_code cannot
// be written; it is either a compile error or a value the contract test rejects.
type toolCall struct {
	service string
	method  string
	request proto.Message
}

// buildToolCall maps a tool name and the arguments the model sent onto the
// Shorts API call that serves it. The parameter names the model sees are
// declared in tools.go; this is where they are translated into proto fields and
// where values are normalised (codes trimmed and upper-cased, numeric limits
// coerced to int32 within bounds).
func buildToolCall(toolName string, args map[string]any) (toolCall, error) {
	switch toolName {
	case "query_short_positions":
		return buildQueryShortPositions(args)
	case "get_top_shorts":
		return buildGetTopShorts(args)
	case "get_stock_details":
		return buildGetStockDetails(args)
	case "search_stocks":
		return buildSearchStocks(args)
	case "get_news":
		return buildGetNews(args)
	case "get_director_trades":
		return buildGetDirectorTrades(args)
	case "get_peer_comparison":
		return buildGetPeerComparison(args)
	case "get_weekly_report":
		return buildGetWeeklyReport(args)
	case "get_related_news":
		return buildGetRelatedNews(args)
	case "get_stock_graph":
		return buildGetStockGraph(args)
	case "get_event_timeline":
		return buildGetEventTimeline(args)
	case "get_stock_signals":
		return buildGetStockSignals(args)
	case "get_economic_series":
		return buildGetEconomicSeries(args)
	default:
		return toolCall{}, fmt.Errorf("unknown tool: %s", toolName)
	}
}

func shortsCall(method string, request proto.Message) toolCall {
	return toolCall{service: legacyShortsService, method: method, request: request}
}

// shortPositionMaxPoints caps the series query_short_positions asks for. Points come
// back oldest first and the result is cut at maxToolResultBytes, so an uncapped
// 3M or longer series loses its newest observations. The server thins to this many
// points and always keeps the first and the latest, which fits the budget.
const shortPositionMaxPoints int32 = 40

func buildQueryShortPositions(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.GetStockDataRequest{
		ProductCode: r.stockCode("stock_code", true),
		Period:      r.upper("period", ""),
		MaxPoints:   shortPositionMaxPoints,
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("GetStockData", request), nil
}

// topShortsPeriod is the window of each stock's sparkline: the 3-month window the
// site's top-shorts list draws. The tool takes no period, so one a model sends is
// ignored.
const topShortsPeriod = "3M"

// buildGetTopShorts asks for each stock's code, name, latest short position and its
// sparkline. The summary query has no points, which left the chat card nothing to
// draw. The sparkline is thinned and the rows are budgeted by summarizeTopShorts.
func buildGetTopShorts(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.GetTopShortsRequest{
		Period: topShortsPeriod,
		Limit:  r.integer("limit", 10, 50),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("GetTopShorts", request), nil
}

func buildGetStockDetails(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.GetStockDetailsRequest{
		ProductCode: r.stockCode("stock_code", true),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("GetStockDetails", request), nil
}

func buildSearchStocks(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.SearchStocksRequest{
		Query: r.text("query", true),
		Limit: r.integer("limit", 5, 50),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("SearchStocks", request), nil
}

// buildGetNews routes on the stock code: a stock's news when one is given, the
// market-wide feed otherwise. A blank stock_code counts as omitted.
func buildGetNews(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	code := r.stockCode("stock_code", false)
	limit := r.integer("limit", 5, 50)
	if r.err != nil {
		return toolCall{}, r.err
	}
	if code == "" {
		return shortsCall("GetMarketNews", &shortsv1alpha1.GetMarketNewsRequest{Limit: limit}), nil
	}
	return shortsCall("GetStockNews", &shortsv1alpha1.GetStockNewsRequest{StockCode: code, Limit: limit}), nil
}

func buildGetDirectorTrades(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.GetDirectorTradesRequest{
		StockCode: r.stockCode("stock_code", true),
		Limit:     r.integer("limit", 10, 50),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("GetDirectorTrades", request), nil
}

func buildGetPeerComparison(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.GetPeerComparisonRequest{
		StockCode: r.stockCode("stock_code", true),
		Limit:     r.integer("limit", 5, 20),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("GetPeerComparison", request), nil
}

// buildGetWeeklyReport sends no week for the latest report. A given week is an
// ISO week slug such as 2026-W08; the API validates the format.
func buildGetWeeklyReport(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.GetWeeklyReportRequest{
		WeekSlug: r.upper("week", ""),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("GetWeeklyReport", request), nil
}

func buildGetRelatedNews(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.GetRelatedNewsRequest{
		StockCode: r.stockCode("stock_code", true),
		ArticleId: r.text("article_id", false),
		Limit:     r.integer("limit", 5, 50),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("GetRelatedNews", request), nil
}

func buildGetStockGraph(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.GetStockGraphRequest{
		StockCode: r.stockCode("stock_code", true),
		Limit:     r.integer("limit", 10, 50),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("GetStockGraph", request), nil
}

func buildGetEventTimeline(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.GetEventTimelineRequest{
		StockCode: r.stockCode("stock_code", true),
		DaysBack:  r.integer("days_back", 90, 365),
		Limit:     r.integer("limit", 20, 50),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("GetEventTimeline", request), nil
}

func buildGetStockSignals(args map[string]any) (toolCall, error) {
	r := argReader{args: args}
	request := &shortsv1alpha1.GetStockSignalsRequest{
		StockCode: r.stockCode("stock_code", true),
		Limit:     r.integer("limit", 10, 50),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return shortsCall("GetStockSignals", request), nil
}

func buildGetEconomicSeries(args map[string]any) (toolCall, error) {
	seriesKeys, err := economicSeriesKeys(args["series_keys"])
	if err != nil {
		return toolCall{}, err
	}
	r := argReader{args: args}
	request := &shortsv1alpha1.GetEconomicSeriesRequest{
		SeriesKeys:      seriesKeys,
		MaxObservations: r.integer("limit", 12, 60),
	}
	if r.err != nil {
		return toolCall{}, r.err
	}
	return toolCall{service: economyService, method: "GetEconomicSeries", request: request}, nil
}

func economicSeriesKeys(value any) ([]string, error) {
	var rawKeys []any
	switch keys := value.(type) {
	case []string:
		rawKeys = make([]any, len(keys))
		for i := range keys {
			rawKeys[i] = keys[i]
		}
	case []any:
		rawKeys = keys
	default:
		return nil, fmt.Errorf("series_keys must be a non-empty string array")
	}

	if len(rawKeys) == 0 {
		return nil, fmt.Errorf("series_keys must be a non-empty string array")
	}
	if len(rawKeys) > 10 {
		return nil, fmt.Errorf("series_keys must contain at most 10 keys")
	}

	seriesKeys := make([]string, len(rawKeys))
	for i, rawKey := range rawKeys {
		key, ok := rawKey.(string)
		if !ok || strings.TrimSpace(key) == "" {
			return nil, fmt.Errorf("series_keys must contain only non-empty strings")
		}
		seriesKeys[i] = strings.TrimSpace(key)
	}
	return seriesKeys, nil
}

// argReader reads the arguments a model sent for one tool. Models send JSON
// numbers as float64 and sometimes send them as strings, so each read normalises
// its value. The first malformed argument is kept in err and later reads return
// zero values, so a builder reads all its arguments and checks err once.
type argReader struct {
	args map[string]any
	err  error
}

func (r *argReader) fail(format string, values ...any) {
	if r.err == nil {
		r.err = fmt.Errorf(format, values...)
	}
}

// text returns the trimmed string argument, or "" when it is absent or null.
// required makes a blank value an error.
func (r *argReader) text(key string, required bool) string {
	value, ok := r.args[key]
	if !ok || value == nil {
		if required {
			r.fail("%s is required", key)
		}
		return ""
	}
	s, ok := value.(string)
	if !ok {
		r.fail("%s must be a string", key)
		return ""
	}
	s = strings.TrimSpace(s)
	if s == "" && required {
		r.fail("%s is required", key)
	}
	return s
}

// stockCode returns an ASX code in upper case, as the Shorts API expects.
func (r *argReader) stockCode(key string, required bool) string {
	return strings.ToUpper(r.text(key, required))
}

// upper returns the argument in upper case, or fallback when it is blank. Periods
// arrive lower-case ("3m") and the API takes upper case ("3M").
func (r *argReader) upper(key, fallback string) string {
	if value := strings.ToUpper(r.text(key, false)); value != "" {
		return value
	}
	return fallback
}

// integer reads an integer argument. A missing, null or non-positive value yields
// def, and a value above max is clamped to max. A number that is not a whole
// integer is an error, which is returned to the model.
func (r *argReader) integer(key string, def, max int32) int32 {
	value, ok := r.args[key]
	if !ok || value == nil {
		return def
	}
	number, ok := numberValue(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number {
		r.fail("%s must be an integer", key)
		return def
	}
	switch {
	case number <= 0:
		return def
	case number > float64(max):
		return max
	default:
		return int32(number)
	}
}

func numberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	case string:
		number, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return number, err == nil
	default:
		return 0, false
	}
}
