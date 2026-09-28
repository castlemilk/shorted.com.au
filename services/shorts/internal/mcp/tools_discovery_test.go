package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// ---------------------------------------------------------------- search_stocks

func TestSearchStocksPassesTheQueryAndClampsTheLimit(t *testing.T) {
	src := &fakeDataSource{searchStocks: &shortsv1alpha1.SearchStocksResponse{
		Query: "pilbara",
		Stocks: []*stocksv1alpha1.Stock{{
			ProductCode: "PLS", Name: "PILBARA MINERALS LIMITED",
			Industry: "Metals & Mining", PercentageShorted: 19.43,
		}},
		Count: 1,
	}}

	_, out, err := searchStocksHandler(src)(context.Background(), nil, SearchStocksInput{Query: "  pilbara ", Limit: 5000})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotSearchStocks.GetQuery() != "pilbara" {
		t.Errorf("query = %q, want it trimmed to %q", src.gotSearchStocks.GetQuery(), "pilbara")
	}
	// Over-asking must clamp, not error: an agent that guesses 5000 should get
	// the ceiling back, not a round trip.
	if got := src.gotSearchStocks.GetLimit(); got != maxSearchLimit {
		t.Errorf("limit = %d, want it clamped to %d", got, maxSearchLimit)
	}
	if out.Count != 1 || len(out.Matches) != 1 {
		t.Fatalf("expected one match, got %+v", out)
	}
	if out.Matches[0].Code != "PLS" || out.Matches[0].PercentShorted != 19.43 {
		t.Errorf("match not projected: %+v", out.Matches[0])
	}
}

func TestSearchStocksAppliesItsDefaultLimit(t *testing.T) {
	src := &fakeDataSource{searchStocks: &shortsv1alpha1.SearchStocksResponse{}}
	if _, _, err := searchStocksHandler(src)(context.Background(), nil, SearchStocksInput{Query: "bank"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := src.gotSearchStocks.GetLimit(); got != defaultSearchLimit {
		t.Errorf("limit = %d, want the default %d", got, defaultSearchLimit)
	}
}

func TestSearchStocksRejectsAnEmptyQueryWithoutCallingTheRPC(t *testing.T) {
	for _, q := range []string{"", "   "} {
		src := &fakeDataSource{searchStocks: &shortsv1alpha1.SearchStocksResponse{}}
		if _, _, err := searchStocksHandler(src)(context.Background(), nil, SearchStocksInput{Query: q}); err == nil {
			t.Errorf("query %q: expected a validation error", q)
		}
		if src.gotSearchStocks != nil {
			t.Errorf("query %q: reached the RPC despite failing validation", q)
		}
	}
}

// An empty search must say "nothing matched", never look like a successful
// lookup of zero companies.
func TestSearchStocksSaysSoWhenNothingMatches(t *testing.T) {
	src := &fakeDataSource{searchStocks: &shortsv1alpha1.SearchStocksResponse{Query: "zzzz", Count: 0}}

	res, out, err := searchStocksHandler(src)(context.Background(), nil, SearchStocksInput{Query: "zzzz"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 0 || len(out.Matches) != 0 {
		t.Errorf("expected no matches, got %+v", out)
	}
	if text := textOf(t, res); !strings.Contains(strings.ToLower(text), "no ") {
		t.Errorf("empty result should say so, got %q", text)
	}
}

func TestSearchStocksSurfacesBackendFailures(t *testing.T) {
	src := &fakeDataSource{err: connect.NewError(connect.CodeInternal, errors.New("algolia down"))}
	if _, _, err := searchStocksHandler(src)(context.Background(), nil, SearchStocksInput{Query: "bhp"}); err == nil {
		t.Fatal("expected an error when the RPC fails")
	}
}

func TestSearchStocksDoesNotInventDataFromANilResponse(t *testing.T) {
	src := &fakeDataSource{searchStocks: nil}
	if _, _, err := searchStocksHandler(src)(context.Background(), nil, SearchStocksInput{Query: "bhp"}); err == nil {
		t.Fatal("expected an error when the RPC returns no body")
	}
}

// get_stock's not-found message tells the model to fall back to search_stocks.
// That pointer is only honest if the tool is actually called that.
func TestSearchStocksIsNamedWhatTheOtherToolsPointAt(t *testing.T) {
	var found bool
	for _, tool := range Registry() {
		if tool.Name == "search_stocks" {
			found = true
		}
	}
	if !found {
		t.Fatal("no tool named search_stocks, but get_stock's error message tells the model to use one")
	}
}

// ---------------------------------------------------------------- screen_stocks

func TestScreenStocksTranslatesCriteriaIntoRangeFilters(t *testing.T) {
	src := &fakeDataSource{screenStocks: &shortsv1alpha1.ScreenStocksResponse{}}

	minShort, maxDTC := 5.0, 12.5
	_, _, err := screenStocksHandler(src)(context.Background(), nil, ScreenStocksInput{
		MinShortPct:    &minShort,
		MaxDaysToCover: &maxDTC,
		Industries:     []string{"Metals & Mining"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	filters := src.gotScreenStocks.GetFilters()
	if filters == nil {
		t.Fatal("no filters were sent — the criteria the caller supplied were dropped")
	}

	// has_min/has_max are what the store actually gates on: a bound sent with
	// has_min unset is silently ignored, which looks like a filter that did
	// nothing rather than an error.
	sp := filters.GetShortPct()
	if !sp.GetHasMin() || sp.GetMin() != 5.0 {
		t.Errorf("short_pct min not set: %+v", sp)
	}
	if sp.GetHasMax() {
		t.Errorf("short_pct max should be unset when the caller omitted it: %+v", sp)
	}
	dtc := filters.GetDaysToCover()
	if !dtc.GetHasMax() || dtc.GetMax() != 12.5 {
		t.Errorf("days_to_cover max not set: %+v", dtc)
	}
	if dtc.GetHasMin() {
		t.Errorf("days_to_cover min should be unset: %+v", dtc)
	}
	if len(filters.GetIndustries()) != 1 || filters.GetIndustries()[0] != "Metals & Mining" {
		t.Errorf("industries not passed through: %+v", filters.GetIndustries())
	}
	// Untouched dimensions must not be sent as zero-valued ranges.
	if filters.GetPeRatio().GetHasMin() || filters.GetPeRatio().GetHasMax() {
		t.Errorf("pe_ratio was filtered on despite the caller not asking: %+v", filters.GetPeRatio())
	}
}

func TestScreenStocksSendsNoFiltersWhenNoneWereGiven(t *testing.T) {
	src := &fakeDataSource{screenStocks: &shortsv1alpha1.ScreenStocksResponse{}}
	if _, _, err := screenStocksHandler(src)(context.Background(), nil, ScreenStocksInput{}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	f := src.gotScreenStocks.GetFilters()
	if f != nil && (f.GetShortPct() != nil || len(f.GetIndustries()) > 0 || f.GetHasDirectorBuys()) {
		t.Errorf("an unfiltered screen sent filters anyway: %+v", f)
	}
	if src.gotScreenStocks.GetLimit() != defaultScreenerLimit {
		t.Errorf("limit = %d, want the default %d", src.gotScreenStocks.GetLimit(), defaultScreenerLimit)
	}
}

func TestScreenStocksMapsSortFieldsAndDirection(t *testing.T) {
	cases := map[string]shortsv1alpha1.ScreenerSortField{
		"":                 shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_SHORT_PCT,
		"short_pct":        shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_SHORT_PCT,
		"days_to_cover":    shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_DAYS_TO_COVER,
		"market_cap":       shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_MARKET_CAP,
		"news_sentiment":   shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_NEWS_SENTIMENT,
		"net_director_buy": shortsv1alpha1.ScreenerSortField_SCREENER_SORT_FIELD_NET_DIRECTOR_BUY,
	}
	for in, want := range cases {
		src := &fakeDataSource{screenStocks: &shortsv1alpha1.ScreenStocksResponse{}}
		if _, _, err := screenStocksHandler(src)(context.Background(), nil, ScreenStocksInput{SortBy: in}); err != nil {
			t.Fatalf("sort_by %q: %v", in, err)
		}
		if got := src.gotScreenStocks.GetSortField(); got != want {
			t.Errorf("sort_by %q mapped to %v, want %v", in, got, want)
		}
	}

	src := &fakeDataSource{screenStocks: &shortsv1alpha1.ScreenStocksResponse{}}
	if _, _, err := screenStocksHandler(src)(context.Background(), nil, ScreenStocksInput{SortDirection: "ASC"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotScreenStocks.GetSortDirection() != shortsv1alpha1.SortDirection_SORT_DIRECTION_ASC {
		t.Errorf("sort_direction = %v, want ASC", src.gotScreenStocks.GetSortDirection())
	}
}

func TestScreenStocksRejectsAnUnknownSortFieldWithoutCallingTheRPC(t *testing.T) {
	src := &fakeDataSource{screenStocks: &shortsv1alpha1.ScreenStocksResponse{}}
	_, _, err := screenStocksHandler(src)(context.Background(), nil, ScreenStocksInput{SortBy: "alphabetical"})
	if err == nil {
		t.Fatal("expected an error for an unknown sort field")
	}
	// The message must list the alternatives, or the model can only guess again.
	if !strings.Contains(err.Error(), "short_pct") {
		t.Errorf("error should list the valid sort fields, got %q", err.Error())
	}
	if src.gotScreenStocks != nil {
		t.Error("reached the RPC despite failing validation")
	}
}

func TestScreenStocksClampsTheLimitAndProjectsRows(t *testing.T) {
	src := &fakeDataSource{screenStocks: &shortsv1alpha1.ScreenStocksResponse{
		Stocks: []*shortsv1alpha1.ScreenerStock{{
			StockCode: "PLS", CompanyName: "PILBARA MINERALS LIMITED", Industry: "Metals & Mining",
			ShortPct: 19.43, ShortPctChange_4W: 2.1, DaysToCover: 6.2, LatestPrice: 2.34,
			PriceChange_1M: 8.4, MarketCap: 7_123_456_789, PeRatio: 22.1, DividendYield: 0.9,
			LogoUrl: "https://storage.googleapis.com/shorted/logos/pls.png",
		}},
		TotalCount: 812,
	}}

	_, out, err := screenStocksHandler(src)(context.Background(), nil, ScreenStocksInput{Limit: 9999})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotScreenStocks.GetLimit() != maxScreenerLimit {
		t.Errorf("limit = %d, want it clamped to %d", src.gotScreenStocks.GetLimit(), maxScreenerLimit)
	}
	if out.TotalCount != 812 {
		t.Errorf("total_count = %d, want 812 — the agent must know the screen matched more than it saw", out.TotalCount)
	}
	if len(out.Stocks) != 1 || out.Stocks[0].Code != "PLS" || out.Stocks[0].Rank != 1 {
		t.Fatalf("row not projected: %+v", out.Stocks)
	}
}

// The screener MV COALESCEs a missing P/E, dividend yield, market cap, price
// and days-to-cover to 0. Emitting that 0 is how a connected model came to
// report "a P/E of zero"; each must be ABSENT instead, and a real value must
// still come through untouched.
func TestScreenStocksOmitsUnknownValuationFieldsRatherThanEmittingZero(t *testing.T) {
	src := &fakeDataSource{screenStocks: &shortsv1alpha1.ScreenStocksResponse{
		Stocks: []*shortsv1alpha1.ScreenerStock{
			{StockCode: "ZZZ", CompanyName: "UNKNOWN METRICS LTD", ShortPct: 7.5},
			{StockCode: "PLS", ShortPct: 19.43, DaysToCover: 6.2, LatestPrice: 2.34,
				MarketCap: 7_123_456_789, PeRatio: 22.1, DividendYield: 0.9},
		},
		TotalCount: 2,
	}}

	res, out, err := screenStocksHandler(src)(context.Background(), nil, ScreenStocksInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	raw, err := json.Marshal(out.Stocks[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"pe_ratio", "dividend_yield", "market_cap", "latest_price", "days_to_cover"} {
		if strings.Contains(string(raw), `"`+key+`"`) {
			t.Errorf("unknown %s was emitted (%s) — absent means unknown, a 0 reads as a real value", key, raw)
		}
	}

	known := out.Stocks[1]
	for name, got := range map[string]*float64{
		"pe_ratio": known.PERatio, "dividend_yield": known.DividendYield, "market_cap": known.MarketCap,
		"latest_price": known.LatestPrice, "days_to_cover": known.DaysToCover,
	} {
		if got == nil {
			t.Errorf("known %s was dropped", name)
		}
	}
	if *known.PERatio != 22.1 || *known.MarketCap != 7_123_456_789 || *known.DaysToCover != 6.2 {
		t.Errorf("known values altered: %+v", known)
	}
	// The lead row's days-to-cover is unknown, so the summary must not say 0.0.
	if text := textOf(t, res); !strings.Contains(text, "days to cover unknown") {
		t.Errorf("summary should say days to cover is unknown for the lead row, got %q", text)
	}
	if !strings.Contains(screenStocksDescription, "absent when unknown, never zero") {
		t.Error("the description must say unknown values are absent, or a model will look for a 0")
	}
}

func TestScreenStocksSaysSoWhenNothingMatches(t *testing.T) {
	src := &fakeDataSource{screenStocks: &shortsv1alpha1.ScreenStocksResponse{}}
	res, out, err := screenStocksHandler(src)(context.Background(), nil, ScreenStocksInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 0 {
		t.Errorf("count = %d, want 0", out.Count)
	}
	if text := textOf(t, res); !strings.Contains(strings.ToLower(text), "no ") {
		t.Errorf("empty screen should say so, got %q", text)
	}
}

func TestScreenStocksDoesNotInventDataFromANilResponse(t *testing.T) {
	src := &fakeDataSource{screenStocks: nil}
	if _, _, err := screenStocksHandler(src)(context.Background(), nil, ScreenStocksInput{}); err == nil {
		t.Fatal("expected an error when the RPC returns no body")
	}
}

// The three ranking/filtering tools are the main selection risk in the tool set.
// Each must name the other two and say what it is not, from its own side.
func TestTheThreeStockRankingToolsDistinguishThemselves(t *testing.T) {
	byName := map[string]string{}
	for _, tool := range Registry() {
		byName[tool.Name] = tool.Description
	}
	for name, others := range map[string][]string{
		"screen_stocks":           {"list_top_shorts", "list_squeeze_candidates"},
		"list_top_shorts":         {"screen_stocks", "list_squeeze_candidates"},
		"list_squeeze_candidates": {"screen_stocks", "list_top_shorts"},
	} {
		desc, ok := byName[name]
		if !ok {
			t.Fatalf("%s is not registered", name)
		}
		for _, other := range others {
			if !strings.Contains(desc, other) {
				t.Errorf("%s's description never mentions %s — a model choosing between them has nothing to go on", name, other)
			}
		}
	}
}

// --------------------------------------------------------------- get_stock_news

func TestGetStockNewsProjectsArticlesAndTruncatesSummaries(t *testing.T) {
	long := strings.Repeat("Lithium prices moved again today. ", 100)
	src := &fakeDataSource{stockNews: &shortsv1alpha1.GetStockNewsResponse{
		Articles: []*shortsv1alpha1.NewsArticle{{
			Id: "abc", StockCode: "PLS", Source: "stockhead",
			Headline: "Pilbara Minerals lifts guidance", Url: "https://stockhead.com.au/x",
			Sentiment: "positive", RelevanceScore: 0.92, IsPriceSensitive: true,
			Summary: long, PublishedAt: timestamppb.New(time.Date(2026, 8, 20, 3, 4, 5, 0, time.UTC)),
			ImageUrl: "https://example.com/hero.jpg", SyndicationCount: 3,
		}},
		// Mirrors the store, which returns len(articles) post-LIMIT.
		TotalCount: 1,
	}}

	res, out, err := getStockNewsHandler(src)(context.Background(), nil, GetStockNewsInput{Code: "pls"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotStockNews.GetStockCode() != "PLS" {
		t.Errorf("stock_code = %q, want it upper-cased", src.gotStockNews.GetStockCode())
	}
	if src.gotStockNews.GetLimit() != defaultNewsLimit {
		t.Errorf("limit = %d, want the default %d", src.gotStockNews.GetLimit(), defaultNewsLimit)
	}
	// The news store returns len(articles) after the limit, so matched_count
	// tracks returned rather than a held total. The fake reflects the real
	// backend here — an independently-set total was the thing that let the old
	// total_count field pass tests while promising a number nobody computes.
	if out.MatchedCount != out.Returned {
		t.Errorf("matched_count %d should equal returned %d", out.MatchedCount, out.Returned)
	}
	if out.Returned != 1 {
		t.Errorf("returned = %d, want 1", out.Returned)
	}
	a := out.Articles[0]
	if a.Headline == "" || a.URL == "" || a.Source != "stockhead" {
		t.Errorf("article not projected: %+v", a)
	}
	if a.PublishedAt != "2026-08-20" {
		t.Errorf("published_at = %q, want 2026-08-20", a.PublishedAt)
	}
	if !strings.HasSuffix(a.Summary, truncationMarker) {
		t.Errorf("long summary should be truncated and marked, got %d chars", len(a.Summary))
	}
	// Sentiment is model-classified; the text fallback must say so rather than
	// letting "positive" read as an objective fact about the article.
	if text := textOf(t, res); !strings.Contains(strings.ToLower(text), "classif") {
		t.Errorf("text fallback should label sentiment as classified, got %q", text)
	}
}

func TestGetStockNewsRejectsABadSentimentFilterWithoutCallingTheRPC(t *testing.T) {
	src := &fakeDataSource{stockNews: &shortsv1alpha1.GetStockNewsResponse{}}
	_, _, err := getStockNewsHandler(src)(context.Background(), nil, GetStockNewsInput{Code: "BHP", Sentiment: "bullish"})
	if err == nil {
		t.Fatal("expected an error for an unknown sentiment")
	}
	if src.gotStockNews != nil {
		t.Error("reached the RPC despite failing validation")
	}
}

func TestGetStockNewsRejectsAMalformedCodeWithoutCallingTheRPC(t *testing.T) {
	src := &fakeDataSource{stockNews: &shortsv1alpha1.GetStockNewsResponse{}}
	if _, _, err := getStockNewsHandler(src)(context.Background(), nil, GetStockNewsInput{Code: "TOOLONG"}); err == nil {
		t.Fatal("expected a validation error")
	}
	if src.gotStockNews != nil {
		t.Error("reached the RPC despite failing validation")
	}
}

func TestGetStockNewsSaysSoWhenThereIsNoNews(t *testing.T) {
	src := &fakeDataSource{stockNews: &shortsv1alpha1.GetStockNewsResponse{}}
	res, out, err := getStockNewsHandler(src)(context.Background(), nil, GetStockNewsInput{Code: "BHP"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Returned != 0 {
		t.Errorf("returned = %d, want 0", out.Returned)
	}
	if text := textOf(t, res); !strings.Contains(strings.ToLower(text), "no ") {
		t.Errorf("empty news should say so, got %q", text)
	}
}

func TestGetStockNewsDoesNotInventDataFromANilResponse(t *testing.T) {
	src := &fakeDataSource{stockNews: nil}
	if _, _, err := getStockNewsHandler(src)(context.Background(), nil, GetStockNewsInput{Code: "BHP"}); err == nil {
		t.Fatal("expected an error when the RPC returns no body")
	}
}

// ------------------------------------------------------------------ list_reports

func TestListReportsProjectsRowsAndDerivesTheReportType(t *testing.T) {
	src := &fakeDataSource{listReports: &shortsv1alpha1.ListReportsResponse{
		Reports: []*shortsv1alpha1.ReportListItem{
			{Slug: "2026-W23", ReportType: "weekly", Headline: "Shorts build in lithium",
				Summary: "A week of covering.", ReportDate: "2026-06-05", MaxShortPct: 19.4,
				MaxShortCode: "PLS", TotalStocksShorted: 812, TopCodes: []string{"PLS", "PDN"},
				TopLogoUrls: []string{"https://x/pls.png", "https://x/pdn.png"}, QualityScore: 0.88},
			{Slug: "2026-05", ReportType: "monthly", Headline: "May in review", ReportDate: "2026-05-30"},
			{Slug: "2025", ReportType: "yearly", Headline: "The year in shorts", ReportDate: "2025-12-31"},
		},
	}}

	_, out, err := listReportsHandler(src)(context.Background(), nil, ListReportsInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotListReports.GetLimit() != defaultReportsLimit {
		t.Errorf("limit = %d, want the default %d", src.gotListReports.GetLimit(), defaultReportsLimit)
	}
	if out.Count != 3 {
		t.Fatalf("count = %d, want 3", out.Count)
	}
	for i, want := range []string{"weekly", "monthly", "yearly"} {
		if out.Reports[i].ReportType != want {
			t.Errorf("report %q: type = %q, want %q", out.Reports[i].Slug, out.Reports[i].ReportType, want)
		}
	}
	if out.Reports[0].MaxShortCode != "PLS" || len(out.Reports[0].TopCodes) != 2 {
		t.Errorf("headline stats not projected: %+v", out.Reports[0])
	}
}

func TestListReportsValidatesReportTypeWithoutCallingTheRPC(t *testing.T) {
	src := &fakeDataSource{listReports: &shortsv1alpha1.ListReportsResponse{}}
	_, _, err := listReportsHandler(src)(context.Background(), nil, ListReportsInput{ReportType: "quarterly"})
	if err == nil {
		t.Fatal("expected an error for an unsupported report type")
	}
	if !strings.Contains(err.Error(), "weekly") {
		t.Errorf("error should list the supported types, got %q", err.Error())
	}
	if src.gotListReports != nil {
		t.Error("reached the RPC despite failing validation")
	}
}

func TestListReportsPassesAndClampsWhatItWasGiven(t *testing.T) {
	src := &fakeDataSource{listReports: &shortsv1alpha1.ListReportsResponse{}}
	if _, _, err := listReportsHandler(src)(context.Background(), nil, ListReportsInput{ReportType: "Monthly", Limit: 9999}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotListReports.GetReportType() != "monthly" {
		t.Errorf("report_type = %q, want it lower-cased", src.gotListReports.GetReportType())
	}
	if src.gotListReports.GetLimit() != maxReportsLimit {
		t.Errorf("limit = %d, want it clamped to %d", src.gotListReports.GetLimit(), maxReportsLimit)
	}
}

func TestListReportsSaysSoWhenThereAreNone(t *testing.T) {
	src := &fakeDataSource{listReports: &shortsv1alpha1.ListReportsResponse{}}
	res, out, err := listReportsHandler(src)(context.Background(), nil, ListReportsInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 0 {
		t.Errorf("count = %d, want 0", out.Count)
	}
	if text := textOf(t, res); !strings.Contains(strings.ToLower(text), "no ") {
		t.Errorf("empty list should say so, got %q", text)
	}
}

func TestListReportsDoesNotInventDataFromANilResponse(t *testing.T) {
	src := &fakeDataSource{listReports: nil}
	if _, _, err := listReportsHandler(src)(context.Background(), nil, ListReportsInput{}); err == nil {
		t.Fatal("expected an error when the RPC returns no body")
	}
}

// -------------------------------------------------------------------- get_report

func TestGetReportAcceptsAllThreeSlugShapes(t *testing.T) {
	for slug, wantType := range map[string]string{
		"2026-W23": "weekly",
		"2026-05":  "monthly",
		"2025":     "yearly",
	} {
		src := &fakeDataSource{weeklyReport: &shortsv1alpha1.GetWeeklyReportResponse{
			WeekSlug: slug, Headline: "A report", ReportDate: "2026-06-05",
		}}
		_, out, err := getReportHandler(src)(context.Background(), nil, GetReportInput{Slug: slug})
		if err != nil {
			t.Fatalf("slug %q: unexpected error: %v", slug, err)
		}
		if src.gotWeeklyReport.GetWeekSlug() != slug {
			t.Errorf("slug %q: passed %q", slug, src.gotWeeklyReport.GetWeekSlug())
		}
		if out.ReportType != wantType {
			t.Errorf("slug %q: report_type = %q, want %q", slug, out.ReportType, wantType)
		}
	}
}

func TestGetReportRejectsAMalformedSlugWithoutCallingTheRPC(t *testing.T) {
	// "2026-13" is a month that does not exist; the handler's own regex accepts
	// it, so rejecting it here is the difference between a clear message and a
	// not-found the model will read as "no report was published".
	for _, slug := range []string{"", "week 23", "2026-W", "2026-13", "26-W23"} {
		src := &fakeDataSource{weeklyReport: &shortsv1alpha1.GetWeeklyReportResponse{}}
		_, _, err := getReportHandler(src)(context.Background(), nil, GetReportInput{Slug: slug})
		if err == nil {
			t.Errorf("slug %q: expected a validation error", slug)
		}
		if src.gotWeeklyReport != nil {
			t.Errorf("slug %q: reached the RPC despite failing validation", slug)
		}
	}
}

func TestGetReportTruncatesNarrativeAndCapsRepeatedSections(t *testing.T) {
	long := strings.Repeat("Short interest rose across the sector this week. ", 200)
	stocks := make([]*shortsv1alpha1.WeeklyReportStock, 40)
	for i := range stocks {
		stocks[i] = &shortsv1alpha1.WeeklyReportStock{
			Rank: int32(i + 1), Code: "PLS", Name: "PILBARA MINERALS LIMITED", ShortPct: 19.4,
			WowChange: 1.2, DaysToCover: 6.2, Industry: "Metals & Mining",
			History: []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13},
			LogoUrl: "https://x/pls.png",
		}
	}
	movers := make([]*shortsv1alpha1.WeeklyReportMover, 30)
	for i := range movers {
		movers[i] = &shortsv1alpha1.WeeklyReportMover{
			Code: "PDN", Name: "PALADIN ENERGY LTD", CurrentPct: 12.3, PreviousPct: 10.1,
			Change: 2.2, ZScore: 1.9, StreakWeeks: 3, Industry: "Energy",
			History: []float64{1, 2, 3}, LogoUrl: "https://x/pdn.png",
		}
	}
	src := &fakeDataSource{weeklyReport: &shortsv1alpha1.GetWeeklyReportResponse{
		WeekSlug: "2026-W23", Headline: "Shorts build in lithium", Summary: "A week of covering.",
		ReportDate: "2026-06-05", PreviousDate: "2026-05-29",
		Narrative: &shortsv1alpha1.WeeklyNarrative{
			OpeningHook: long, TopAnalysis: long, MoversAnalysis: long,
			IndustryAnalysis: long, Outlook: long,
		},
		TopShorted: stocks, Risers: movers, Fallers: movers,
		MarketStats: &shortsv1alpha1.WeeklyMarketStats{TotalStocksShorted: 812, AvgShortPct: 2.1, MaxShortPct: 19.4, MaxShortCode: "PLS"},
	}}

	res, out, err := getReportHandler(src)(context.Background(), nil, GetReportInput{Slug: "2026-W23"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.TopShorted) != maxReportStocks {
		t.Errorf("top_shorted = %d rows, want it capped at %d", len(out.TopShorted), maxReportStocks)
	}
	if len(out.Risers) != maxReportMovers || len(out.Fallers) != maxReportMovers {
		t.Errorf("movers = %d/%d, want both capped at %d", len(out.Risers), len(out.Fallers), maxReportMovers)
	}
	if out.Narrative == nil || !strings.HasSuffix(out.Narrative.OpeningHook, truncationMarker) {
		t.Errorf("narrative sections should be truncated and marked")
	}
	if out.MarketStats == nil || out.MarketStats.TotalStocksShorted != 812 {
		t.Errorf("market stats not projected: %+v", out.MarketStats)
	}
	// The narrative is machine-written. A reader must not take it for reporting.
	if text := textOf(t, res); !strings.Contains(strings.ToLower(text), "generated") {
		t.Errorf("text fallback should say the narrative is generated, got %q", text)
	}
}

func TestGetReportTurnsNotFoundIntoAnActionableMessage(t *testing.T) {
	src := &fakeDataSource{err: connect.NewError(connect.CodeNotFound, errors.New("weekly report not found"))}
	_, _, err := getReportHandler(src)(context.Background(), nil, GetReportInput{Slug: "2026-W23"})
	if err == nil {
		t.Fatal("expected an error for a missing report")
	}
	if !strings.Contains(err.Error(), "list_reports") {
		t.Errorf("not-found error should point at the discovery tool, got %q", err.Error())
	}
}

func TestGetReportSurfacesBackendFailuresDistinctly(t *testing.T) {
	src := &fakeDataSource{err: connect.NewError(connect.CodeInternal, errors.New("database on fire"))}
	_, _, err := getReportHandler(src)(context.Background(), nil, GetReportInput{Slug: "2026-W23"})
	if err == nil {
		t.Fatal("expected an error when the RPC fails")
	}
	if strings.Contains(err.Error(), "list_reports") {
		t.Errorf("an internal failure must not be reported as a missing report, got %q", err.Error())
	}
}

func TestGetReportDoesNotInventDataFromANilResponse(t *testing.T) {
	src := &fakeDataSource{weeklyReport: nil}
	if _, _, err := getReportHandler(src)(context.Background(), nil, GetReportInput{Slug: "2026-W23"}); err == nil {
		t.Fatal("expected an error when the RPC returns no body")
	}
}

// Reports are LLM-written narrative over ASIC data. An agent that cites one as
// primary source data is misleading its user, so both report tools must label
// them and both must name each other as the other half of the pair.
func TestReportToolsDeclareTheirNarrativeIsGenerated(t *testing.T) {
	byName := map[string]string{}
	for _, tool := range Registry() {
		byName[tool.Name] = strings.ToLower(tool.Description)
	}
	for _, name := range []string{"list_reports", "get_report"} {
		desc, ok := byName[name]
		if !ok {
			t.Fatalf("%s is not registered", name)
		}
		if !strings.Contains(desc, "generated") {
			t.Errorf("%s's description does not say the narrative is machine-generated", name)
		}
	}
	if !strings.Contains(byName["get_report"], "list_reports") {
		t.Error("get_report should point at list_reports so an agent never guesses a slug")
	}
	if !strings.Contains(byName["list_reports"], "get_report") {
		t.Error("list_reports should point at get_report as the way to read one")
	}
}

// get_stock_news carries a model-assigned sentiment label. Say so where the
// model will read it.
func TestGetStockNewsDeclaresItsSentimentIsModelAssigned(t *testing.T) {
	for _, tool := range Registry() {
		if tool.Name != "get_stock_news" {
			continue
		}
		if !strings.Contains(strings.ToLower(tool.Description), "classif") {
			t.Error("get_stock_news's description does not say sentiment is model-classified")
		}
		return
	}
	t.Fatal("get_stock_news is not registered")
}

// ------------------------------------------------------------- list_strategies

func strategiesFixture() *shortsv1alpha1.ListStrategiesResponse {
	return &shortsv1alpha1.ListStrategiesResponse{
		Strategies: []*shortsv1alpha1.Strategy{
			{
				Id: "zanger-breakout", Name: "Zanger Breakout", Author: "Dan Zanger",
				Tagline:               "Buy fast growers breaking out of a tight base.",
				DescriptionParagraphs: []string{"A LONG BIOGRAPHICAL PARAGRAPH THAT BELONGS ON THE PAGE."},
				Rules: []*shortsv1alpha1.StrategyRule{
					{Id: "growth", Title: "Explosive growth", Core: true, Evaluation: "EVALUATION PROSE", DataSource: "stock_fundamentals"},
					{Id: "rs", Title: "Relative strength", Core: false, DataSource: "stock_prices"},
				},
				Metadata: &shortsv1alpha1.StrategyMetadata{Style: "momentum-breakout", HoldingPeriod: "Weeks to months"},
				Caveats:  []string{"A CAVEAT"},
			},
			{Id: "canslim", Name: "CAN SLIM", Author: "William J. O'Neil"},
		},
		Regime: &shortsv1alpha1.MarketRegime{
			IndexCode: "XJO", AsOf: "2026-09-25", Regime: "uptrend",
			Verdict: "Uptrend: XJO is above its 50-day average.", Close: 8123.4,
		},
	}
}

func TestListStrategiesProjectsRulesAndRegimeButNotProse(t *testing.T) {
	src := &fakeDataSource{strategies: strategiesFixture()}

	res, out, err := listStrategiesHandler(src)(context.Background(), nil, ListStrategiesInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotStrategies == nil {
		t.Fatal("ListStrategies was not called")
	}
	if out.Count != 2 || len(out.Strategies) != 2 {
		t.Fatalf("count = %d, want 2", out.Count)
	}
	z := out.Strategies[0]
	if z.ID != "zanger-breakout" || z.Author != "Dan Zanger" || z.Style != "momentum-breakout" || z.HoldingPeriod != "Weeks to months" {
		t.Errorf("strategy not projected: %+v", z)
	}
	if len(z.Rules) != 2 || z.Rules[0] != (StrategyRuleSummary{ID: "growth", Title: "Explosive growth", Core: true}) || z.Rules[1].Core {
		t.Errorf("rules not projected: %+v", z.Rules)
	}
	if out.Regime != (MarketRegimeSummary{IndexCode: "XJO", AsOf: "2026-09-25", Regime: "uptrend", Verdict: "Uptrend: XJO is above its 50-day average."}) {
		t.Errorf("regime not projected: %+v", out.Regime)
	}
	// A strategy with no rules still serialises rules as [], never null.
	if out.Strategies[1].Rules == nil {
		t.Error("rules should be an empty list, not null")
	}

	raw, _ := json.Marshal(out)
	for _, prose := range []string{"BIOGRAPHICAL", "EVALUATION PROSE", "A CAVEAT"} {
		if strings.Contains(string(raw), prose) {
			t.Errorf("list_strategies leaked %q — the page carries the prose, the tool carries the shape", prose)
		}
	}
	text := textOf(t, res)
	for _, want := range []string{"zanger-breakout", "canslim", "get_strategy_picks", "uptrend", "Not financial advice"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary missing %q: %q", want, text)
		}
	}
}

func TestListStrategiesSaysSoWhenTheRegimeIsUnknown(t *testing.T) {
	fixture := strategiesFixture()
	fixture.Regime = &shortsv1alpha1.MarketRegime{IndexCode: "XJO", Verdict: "Market regime unavailable: not enough XJO data."}
	src := &fakeDataSource{strategies: fixture}

	res, out, err := listStrategiesHandler(src)(context.Background(), nil, ListStrategiesInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Regime.Regime != "" {
		t.Errorf("regime = %q, want absent", out.Regime.Regime)
	}
	if !strings.Contains(textOf(t, res), "Market regime unavailable") {
		t.Errorf("an unknown regime must be stated, got %q", textOf(t, res))
	}
}

func TestListStrategiesHandlesEmptyErrorsAndNilBodies(t *testing.T) {
	res, out, err := listStrategiesHandler(&fakeDataSource{strategies: &shortsv1alpha1.ListStrategiesResponse{}})(
		context.Background(), nil, ListStrategiesInput{})
	if err != nil {
		t.Fatalf("an empty list is a result, not an error: %v", err)
	}
	if out.Count != 0 || out.Strategies == nil || out.Regime.IndexCode != strategies.DefaultIndexCode {
		t.Errorf("empty result malformed: %+v", out)
	}
	if !strings.Contains(textOf(t, res), "No strategies") {
		t.Errorf("empty result should say so, got %q", textOf(t, res))
	}

	if _, _, err := listStrategiesHandler(&fakeDataSource{})(context.Background(), nil, ListStrategiesInput{}); err == nil {
		t.Error("expected an error when the RPC returns no body")
	}
	src := &fakeDataSource{err: connect.NewError(connect.CodeInternal, errors.New("database on fire"))}
	if _, _, err := listStrategiesHandler(src)(context.Background(), nil, ListStrategiesInput{}); err == nil {
		t.Error("expected the backend error to surface")
	}
}

// ---------------------------------------------------------- get_strategy_picks

// The schema description is the only place a model learns the ids before it
// has called list_strategies, so it must name every one the registry holds.
func TestGetStrategyPicksSchemaNamesEveryStrategyID(t *testing.T) {
	field, ok := reflect.TypeOf(GetStrategyPicksInput{}).FieldByName("StrategyID")
	if !ok {
		t.Fatal("no StrategyID field")
	}
	tag := field.Tag.Get("jsonschema")
	ids := strategyIDs()
	if len(ids) == 0 {
		t.Fatal("registry is empty — this test would pass vacuously")
	}
	for _, id := range ids {
		if !strings.Contains(tag, id) {
			t.Errorf("strategy_id description does not name %q: %q", id, tag)
		}
	}
}

func TestGetStrategyPicksValidatesBeforeCallingTheRPC(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   GetStrategyPicksInput
		want string
	}{
		{"missing id", GetStrategyPicksInput{StrategyID: "  "}, "zanger-breakout"},
		{"unknown id", GetStrategyPicksInput{StrategyID: "buffett-value"}, "minervini-trend-template"},
		{"bad status", GetStrategyPicksInput{StrategyID: "canslim", Status: "hot"}, "triggered"},
		{"bad sort", GetStrategyPicksInput{StrategyID: "canslim", SortBy: "dividend_yield"}, "market_cap"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := &fakeDataSource{strategyPicks: &shortsv1alpha1.GetStrategyPicksResponse{}}
			_, _, err := getStrategyPicksHandler(src)(context.Background(), nil, tc.in)
			if err == nil {
				t.Fatal("expected a validation error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error should name the valid values (%q), got %q", tc.want, err.Error())
			}
			if src.gotStrategyPicks != nil {
				t.Error("reached the RPC despite failing validation")
			}
		})
	}
}

func TestGetStrategyPicksNormalisesAndClampsTheRequest(t *testing.T) {
	for _, tc := range []struct {
		limit int
		want  int32
	}{
		{0, defaultStrategyPicksLimit},
		{-3, defaultStrategyPicksLimit},
		{7, 7},
		{9999, maxStrategyPicksLimit},
	} {
		src := &fakeDataSource{strategyPicks: &shortsv1alpha1.GetStrategyPicksResponse{}}
		in := GetStrategyPicksInput{StrategyID: " Zanger-Breakout ", Status: " SETUP ", SortBy: " ROE ", Limit: tc.limit}
		if _, _, err := getStrategyPicksHandler(src)(context.Background(), nil, in); err != nil {
			t.Fatalf("limit %d: unexpected error: %v", tc.limit, err)
		}
		got := src.gotStrategyPicks
		if got.GetLimit() != tc.want {
			t.Errorf("limit %d sent as %d, want %d", tc.limit, got.GetLimit(), tc.want)
		}
		if got.GetStrategyId() != "zanger-breakout" || got.GetStatus() != "setup" || got.GetSortBy() != "roe" {
			t.Errorf("request not normalised: id=%q status=%q sort_by=%q", got.GetStrategyId(), got.GetStatus(), got.GetSortBy())
		}
	}

	// Omitted, sort_by stays empty: the server's rank order.
	src := &fakeDataSource{strategyPicks: &shortsv1alpha1.GetStrategyPicksResponse{}}
	if _, _, err := getStrategyPicksHandler(src)(context.Background(), nil, GetStrategyPicksInput{StrategyID: "canslim"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := src.gotStrategyPicks.GetSortBy(); got != "" {
		t.Errorf("an omitted sort_by was sent as %q", got)
	}
}

// sort_by's description is the only place a model learns the keys before it
// guesses one, so it must name every key the evaluator accepts; and every key
// it names must be accepted.
func TestGetStrategyPicksSchemaNamesEverySortKey(t *testing.T) {
	field, ok := reflect.TypeOf(GetStrategyPicksInput{}).FieldByName("SortBy")
	if !ok {
		t.Fatal("no SortBy field")
	}
	tag := field.Tag.Get("jsonschema")
	keys := strategies.SortKeys()
	if len(keys) == 0 {
		t.Fatal("no sort keys: this test would pass vacuously")
	}
	for _, k := range keys {
		if !strings.Contains(tag, k) {
			t.Errorf("sort_by description does not name %q: %q", k, tag)
		}
		src := &fakeDataSource{strategyPicks: &shortsv1alpha1.GetStrategyPicksResponse{}}
		if _, _, err := getStrategyPicksHandler(src)(context.Background(), nil, GetStrategyPicksInput{StrategyID: "canslim", SortBy: k}); err != nil {
			t.Errorf("sort key %q refused: %v", k, err)
		}
	}
}

// Every strategy the registry holds is named in list_strategies' description,
// by the name the registry gives it.
func TestListStrategiesDescriptionNamesEveryStrategy(t *testing.T) {
	reg := strategies.Registry()
	if len(reg) == 0 {
		t.Fatal("registry is empty: this test would pass vacuously")
	}
	for _, st := range reg {
		if !strings.Contains(listStrategiesDescription, st.Name) {
			t.Errorf("list_strategies description does not name %q", st.Name)
		}
	}
}

func picksFixture() *shortsv1alpha1.GetStrategyPicksResponse {
	return &shortsv1alpha1.GetStrategyPicksResponse{
		Strategy: &shortsv1alpha1.Strategy{
			Id: "zanger-breakout", Name: "Zanger Breakout", Author: "Dan Zanger", Tagline: "Breakouts.",
			Rules: []*shortsv1alpha1.StrategyRule{{Id: "growth", DataSource: "stock_fundamentals"}},
		},
		Regime:     &shortsv1alpha1.MarketRegime{IndexCode: "XJO", AsOf: "2026-09-25", Regime: "neutral", Verdict: "Be selective."},
		TotalCount: 40, UniverseCount: 1200, FundamentalsCoverageCount: 900, AsOf: "2026-09-25",
		Picks: []*shortsv1alpha1.StrategyPick{
			{
				Rank: 1, StockCode: "PLS", CompanyName: "PILBARA MINERALS", Industry: "Metals & Mining",
				Status: "triggered", Score: 87.4, Close: 2.34, Pivot: 2.2, BaseDepthPct: 18.456, BaseLengthDays: 45,
				VolumeRatio_50D: 2.345, RevenueYoyPct: 41.237, HasRevenueYoy: true,
				// Known flat EPS: zero is a MEASUREMENT here, and must survive.
				EpsYoyPct: 0, HasEpsYoy: true,
				Rs_3MPct: 12.5, ShortPct: 6.2, MarketCap: 7e9, LogoUrl: "https://x/pls.png",
				HasClose: true, HasRs_3MPct: true, HasShortPct: true, HasMarketCap: true,
				Rules: []*shortsv1alpha1.RuleResult{
					{RuleId: "growth", Status: "pass", Detail: "Revenue +41% YoY"},
					{RuleId: "breakout", Status: "pass", Detail: "Broke out on 2026-09-24"},
					{RuleId: "rs", Status: "fail", Detail: "Lagged the S&P/ASX 200 by 2.0 points over 3 months"},
					{RuleId: "liquidity", Status: "unknown", Detail: "Not enough history to measure turnover"},
				},
			},
			{
				// Every NULL feature dereferenced to 0 by the handler, every
				// has_* flag false, and no growth data at all.
				Rank: 2, StockCode: "ZZZ", Status: "watch", Score: 12,
				Rules: []*shortsv1alpha1.RuleResult{{RuleId: "liquidity", Status: "pass"}},
			},
		},
	}
}

func TestGetStrategyPicksProjectsOutcomesAndOmitsUnknownFigures(t *testing.T) {
	src := &fakeDataSource{strategyPicks: picksFixture()}

	res, out, err := getStrategyPicksHandler(src)(context.Background(), nil, GetStrategyPicksInput{StrategyID: "zanger-breakout"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Strategy != (StrategyHeader{ID: "zanger-breakout", Name: "Zanger Breakout", Author: "Dan Zanger", Tagline: "Breakouts."}) {
		t.Errorf("strategy header: %+v", out.Strategy)
	}
	if out.Regime.Regime != "neutral" || out.Regime.Verdict != "Be selective." {
		t.Errorf("regime: %+v", out.Regime)
	}
	if out.UniverseCount != 1200 || out.FundamentalsCoverageCount != 900 || out.TotalCount != 40 || out.Count != 2 || out.AsOf != "2026-09-25" {
		t.Errorf("counts: %+v", out)
	}

	p := out.Picks[0]
	if p.Code != "PLS" || p.Rank != 1 || p.Status != "triggered" || p.Score != 87.4 || p.Industry != "Metals & Mining" {
		t.Errorf("pick header: %+v", p)
	}
	if p.Pivot == nil || *p.Pivot != 2.2 || p.BaseDepthPct == nil || *p.BaseDepthPct != 18.46 || p.BaseLengthDays != 45 {
		t.Errorf("base figures: pivot=%v depth=%v length=%d", p.Pivot, p.BaseDepthPct, p.BaseLengthDays)
	}
	if p.RevenueYoYPct == nil || *p.RevenueYoYPct != 41.24 {
		t.Errorf("revenue growth: %v", p.RevenueYoYPct)
	}
	if p.EPSYoYPct == nil || *p.EPSYoYPct != 0 {
		t.Errorf("a known 0%% EPS growth must be emitted as 0, got %v", p.EPSYoYPct)
	}
	if p.Close == nil || *p.Close != 2.34 || p.RS3MPct == nil || *p.RS3MPct != 12.5 || p.ShortPct == nil || *p.ShortPct != 6.2 {
		t.Errorf("flagged headline figures: close=%v rs=%v short=%v", p.Close, p.RS3MPct, p.ShortPct)
	}
	if !reflect.DeepEqual(p.Passed, []string{"growth", "breakout"}) || !reflect.DeepEqual(p.Failed, []string{"rs"}) ||
		!reflect.DeepEqual(p.Unknown, []string{"liquidity"}) {
		t.Errorf("outcomes: passed=%v failed=%v unknown=%v", p.Passed, p.Failed, p.Unknown)
	}
	if len(p.Evidence) != 2 || !strings.Contains(p.Evidence["rs"], "Lagged") || !strings.Contains(p.Evidence["liquidity"], "turnover") {
		t.Errorf("evidence should cover exactly the failed and unknown rules: %+v", p.Evidence)
	}

	raw, _ := json.Marshal(out.Picks[1])
	for _, key := range []string{"close", "pivot", "base_depth_pct", "base_length_days", "volume_ratio_50d",
		"revenue_yoy_pct", "eps_yoy_pct", "rs_3m_pct", "short_pct", "evidence"} {
		if strings.Contains(string(raw), `"`+key+`"`) {
			t.Errorf("unknown %s emitted on a row with no data: %s", key, raw)
		}
	}
	whole, _ := json.Marshal(out)
	if strings.Contains(string(whole), "logo") || strings.Contains(string(whole), "market_cap") {
		t.Errorf("projection leaked unpublished fields: %s", whole)
	}

	text := textOf(t, res)
	for _, want := range []string{"2 picks for Zanger Breakout: 1 triggered, 0 setup", "of 40 matching", "neutral",
		"First: PLS", "pivot A$2.20", "Fundamentals cover 900 of 1200", "https://shorted.com.au/picks/zanger-breakout",
		"Not financial advice"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary missing %q: %q", want, text)
		}
	}
}

// The has_* flags, not the value, decide whether close, relative strength and
// short percent are emitted. A measured zero (a stock exactly in line with the
// index, an ASIC row reporting no position) is a reading and must survive; a
// value without its flag is not one and must not.
func TestGetStrategyPicksPresenceFlagsDecideCloseRSAndShortPct(t *testing.T) {
	src := &fakeDataSource{strategyPicks: &shortsv1alpha1.GetStrategyPicksResponse{
		UniverseCount: 2,
		Picks: []*shortsv1alpha1.StrategyPick{
			{
				Rank: 1, StockCode: "ZRO", Status: "watch", Score: 30,
				Close: 1.5, HasClose: true,
				Rs_3MPct: 0, HasRs_3MPct: true,
				ShortPct: 0, HasShortPct: true,
				// A 0 pivot has no flag and is never a real level.
				Pivot: 0,
			},
			{
				// Values without flags: the flag is authoritative.
				Rank: 2, StockCode: "NOF", Status: "watch", Score: 20,
				Close: 3.2, Rs_3MPct: 4.5, ShortPct: 7.1,
			},
		},
	}}

	_, out, err := getStrategyPicksHandler(src)(context.Background(), nil, GetStrategyPicksInput{StrategyID: "crowded-short-breakout"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.Picks) != 2 {
		t.Fatalf("want 2 picks, got %d", len(out.Picks))
	}
	zro := out.Picks[0]
	if zro.Close == nil || *zro.Close != 1.5 {
		t.Errorf("flagged close: %v", zro.Close)
	}
	if zro.RS3MPct == nil || *zro.RS3MPct != 0 {
		t.Errorf("a measured 0 relative strength must be emitted as 0, got %v", zro.RS3MPct)
	}
	if zro.ShortPct == nil || *zro.ShortPct != 0 {
		t.Errorf("a reported 0%% short position must be emitted as 0, got %v", zro.ShortPct)
	}
	if zro.Pivot != nil {
		t.Errorf("an unflagged 0 pivot must stay absent, got %v", *zro.Pivot)
	}
	raw, _ := json.Marshal(zro)
	for _, key := range []string{`"rs_3m_pct":0`, `"short_pct":0`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("want %s in %s", key, raw)
		}
	}

	raw, _ = json.Marshal(out.Picks[1])
	for _, key := range []string{"close", "rs_3m_pct", "short_pct"} {
		if strings.Contains(string(raw), `"`+key+`"`) {
			t.Errorf("%s emitted without its has_* flag: %s", key, raw)
		}
	}
}

// The evidence allowance is what keeps a 25-pick call inside the payload
// budget. Outcomes must stay complete on every row even once it is spent, and
// the result must SAY it ran out rather than look like rows with no failures.
func TestGetStrategyPicksSpendsEvidenceInRankOrderAndSaysWhenItRunsOut(t *testing.T) {
	long := strings.Repeat("A long evidence sentence about a rule that failed. ", 6)
	picks := make([]*shortsv1alpha1.StrategyPick, 0, maxStrategyPicksLimit)
	for i := 0; i < maxStrategyPicksLimit; i++ {
		picks = append(picks, &shortsv1alpha1.StrategyPick{
			Rank: int32(i + 1), StockCode: "ABC", Status: "watch",
			Rules: []*shortsv1alpha1.RuleResult{
				{RuleId: "liquidity", Status: "pass", Detail: long},
				{RuleId: "trend_stack", Status: "fail", Detail: long},
				{RuleId: "off_high", Status: "fail", Detail: long},
				{RuleId: "rs_leader", Status: "unknown", Detail: long},
			},
		})
	}
	src := &fakeDataSource{strategyPicks: &shortsv1alpha1.GetStrategyPicksResponse{Picks: picks, UniverseCount: 900}}

	res, out, err := getStrategyPicksHandler(src)(context.Background(), nil,
		GetStrategyPicksInput{StrategyID: "minervini-trend-template", Limit: maxStrategyPicksLimit})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !out.DetailTrimmed {
		t.Fatal("detail_trimmed should be set once the allowance is spent")
	}
	if len(out.Picks[0].Evidence) != 3 {
		t.Errorf("the top pick must carry all its evidence, got %d entries", len(out.Picks[0].Evidence))
	}
	last := out.Picks[len(out.Picks)-1]
	if len(last.Evidence) != 0 {
		t.Errorf("evidence should have run out before the last row, got %+v", last.Evidence)
	}
	spent := 0
	for _, p := range out.Picks {
		if len(p.Failed) != 2 || len(p.Unknown) != 1 || len(p.Passed) != 1 {
			t.Fatalf("rank %d: outcomes must stay complete after the evidence runs out: %+v", p.Rank, p)
		}
		for id, detail := range p.Evidence {
			if len([]rune(detail)) > maxRuleEvidenceChars+len([]rune(truncationMarker)) {
				t.Errorf("evidence for %s is %d runes, over the cap", id, len([]rune(detail)))
			}
			if !strings.HasSuffix(detail, truncationMarker) {
				t.Errorf("an over-long sentence must be marked as cut: %q", detail)
			}
			spent += len(id) + len(detail)
		}
	}
	if spent > maxPickEvidenceBytes {
		t.Errorf("spent %d bytes of evidence, over the %d allowance", spent, maxPickEvidenceBytes)
	}
	if !strings.Contains(textOf(t, res), "trimmed") {
		t.Errorf("the summary should say evidence was trimmed, got %q", textOf(t, res))
	}
}

// A pick carries two quality ratios and where its growth figures came from.
// The ratios obey their has_* flags like every other figure; the source is
// "filing" when EITHER growth figure came from a parsed filing, "vendor" when
// the ones present are all the provider's, and absent when there is nothing to
// attribute (no fundamentals block, or an API from before basis sources).
func TestGetStrategyPicksProjectsQualityAndFundamentalsSource(t *testing.T) {
	pick := func(code string, f *shortsv1alpha1.PickFundamentals) *shortsv1alpha1.StrategyPick {
		return &shortsv1alpha1.StrategyPick{Rank: 1, StockCode: code, Status: "watch", Fundamentals: f}
	}
	src := &fakeDataSource{strategyPicks: &shortsv1alpha1.GetStrategyPicksResponse{
		Strategy: &shortsv1alpha1.Strategy{
			Id: "quality-compounders", Name: "Quality compounders",
			Rules: []*shortsv1alpha1.StrategyRule{{Id: "roe", DataSource: "stock_fundamentals"}},
		},
		UniverseCount: 1_200, FundamentalsRowsCount: 950, FundamentalsCoverageCount: 700, AsOf: "2026-09-25",
		Picks: []*shortsv1alpha1.StrategyPick{
			pick("REV", &shortsv1alpha1.PickFundamentals{
				RoePct: 23.4567, HasRoePct: true, NetMarginPct: 0, HasNetMarginPct: true,
				RevenueBasisSource: "filing", EpsBasisSource: "vendor",
			}),
			pick("EPS", &shortsv1alpha1.PickFundamentals{
				RoePct: 12, HasRoePct: false, NetMarginPct: 8.1, HasNetMarginPct: false,
				RevenueBasisSource: "vendor", EpsBasisSource: "filing",
			}),
			pick("VEN", &shortsv1alpha1.PickFundamentals{EpsBasisSource: "vendor"}),
			pick("OLD", &shortsv1alpha1.PickFundamentals{RoePct: 15.2, HasRoePct: true}),
			pick("NON", nil),
		},
	}}

	res, out, err := getStrategyPicksHandler(src)(context.Background(), nil,
		GetStrategyPicksInput{StrategyID: "quality-compounders", SortBy: "roe"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.FundamentalsRowsCount != 950 || out.FundamentalsCoverageCount != 700 {
		t.Errorf("counts: rows=%d growth=%d", out.FundamentalsRowsCount, out.FundamentalsCoverageCount)
	}
	byCode := map[string]StrategyPickRow{}
	for _, p := range out.Picks {
		byCode[p.Code] = p
	}
	rev := byCode["REV"]
	if rev.ROEPct == nil || *rev.ROEPct != 23.46 {
		t.Errorf("roe_pct: %v", rev.ROEPct)
	}
	if rev.NetMarginPct == nil || *rev.NetMarginPct != 0 {
		t.Errorf("a measured 0%% net margin must be emitted as 0, got %v", rev.NetMarginPct)
	}
	for code, want := range map[string]string{"REV": "filing", "EPS": "filing", "VEN": "vendor", "OLD": "", "NON": ""} {
		if got := byCode[code].FundamentalsSource; got != want {
			t.Errorf("%s fundamentals_source = %q, want %q", code, got, want)
		}
	}
	if e := byCode["EPS"]; e.ROEPct != nil || e.NetMarginPct != nil {
		t.Errorf("ratios emitted without their has_* flags: roe=%v margin=%v", e.ROEPct, e.NetMarginPct)
	}
	raw := mustJSON(t, byCode["NON"])
	for _, key := range []string{"roe_pct", "net_margin_pct", "fundamentals_source"} {
		if strings.Contains(raw, key) {
			t.Errorf("%s emitted on a pick with no fundamentals: %s", key, raw)
		}
	}

	text := textOf(t, res)
	for _, want := range []string{"Sorted by roe, highest first", "rank is still the strategy's",
		"Fundamentals held for 950 of 1200 stocks evaluated (growth figures for 700)", "quality rules read unknown"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary missing %q: %q", want, text)
		}
	}
	if strings.Contains(text, "get_stock_fundamentals") {
		t.Errorf("roe is a column of the row; the summary should not send the reader elsewhere for it: %q", text)
	}
}

// The rows count is quoted only when the API sends one that can contain the
// growth count; an older API's absent count is not "0 of N", and pe sorts
// lowest first.
func TestGetStrategyPicksCoverageCopyFallsBackForAnOlderAPI(t *testing.T) {
	fixture := picksFixture()
	fixture.FundamentalsRowsCount = 0
	src := &fakeDataSource{strategyPicks: fixture}
	res, _, err := getStrategyPicksHandler(src)(context.Background(), nil, GetStrategyPicksInput{StrategyID: "zanger-breakout", SortBy: "pe"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	text := textOf(t, res)
	for _, want := range []string{"Fundamentals cover 900 of 1200", "growth rules read unknown", "Sorted by pe, lowest first",
		"pe figure is in get_stock_fundamentals"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary missing %q: %q", want, text)
		}
	}
	if strings.Contains(text, "held for 0") {
		t.Errorf("an absent rows count was quoted: %q", text)
	}
	if res, _, _ := getStrategyPicksHandler(src)(context.Background(), nil, GetStrategyPicksInput{StrategyID: "zanger-breakout"}); strings.Contains(textOf(t, res), "Sorted by") {
		t.Errorf("rank order must not claim a sort: %q", textOf(t, res))
	}
}

// A market-cap sort orders some stocks by the screener's figure, which
// get_stock_fundamentals does not carry; the summary must not send the reader
// there for a number it will not find.
func TestDescribeSortSaysWhereTheMarketCapComesFrom(t *testing.T) {
	got := describeSort("market_cap")
	for _, want := range []string{"Sorted by market_cap, highest first", "latest close x shares on issue",
		"the screener's figure where we hold no share count"} {
		if !strings.Contains(got, want) {
			t.Errorf("describeSort(market_cap) missing %q: %q", want, got)
		}
	}
	if strings.Contains(got, "figure is in get_stock_fundamentals") {
		t.Errorf("not every sorted market cap is in get_stock_fundamentals: %q", got)
	}
	if got := describeSort("fcf_margin"); !strings.Contains(got, "fcf_margin figure is in get_stock_fundamentals") {
		t.Errorf("describeSort(fcf_margin) = %q", got)
	}
}

func TestGetStrategyPicksExplainsAnEmptyResult(t *testing.T) {
	fundamentals := []*shortsv1alpha1.StrategyRule{{Id: "growth", DataSource: "stock_fundamentals"}}
	pricesOnly := []*shortsv1alpha1.StrategyRule{{Id: "trend_stack", DataSource: "stock_prices"}}
	downtrend := &shortsv1alpha1.MarketRegime{IndexCode: "XJO", Regime: "downtrend", Verdict: "Stand aside: XJO is below its 200-day average."}

	for _, tc := range []struct {
		name   string
		status string
		resp   *shortsv1alpha1.GetStrategyPicksResponse
		want   []string
	}{
		{"empty universe", "", &shortsv1alpha1.GetStrategyPicksResponse{
			Strategy: &shortsv1alpha1.Strategy{Name: "Zanger Breakout", Rules: fundamentals}},
			[]string{"No picks for Zanger Breakout", "universe is empty"}},
		{"no fundamentals yet", "", &shortsv1alpha1.GetStrategyPicksResponse{
			Strategy: &shortsv1alpha1.Strategy{Name: "CAN SLIM", Rules: fundamentals}, UniverseCount: 800, Regime: downtrend},
			[]string{"No picks for CAN SLIM", "None of the 800", "fundamentals", "Stand aside"}},
		{"status filter", "triggered", &shortsv1alpha1.GetStrategyPicksResponse{
			Strategy: &shortsv1alpha1.Strategy{Name: "Minervini Trend Template", Rules: pricesOnly}, UniverseCount: 800, Regime: downtrend},
			[]string{"with status triggered", "omit the status filter", "downtrend"}},
		{"rows but no growth figures", "", &shortsv1alpha1.GetStrategyPicksResponse{
			Strategy: &shortsv1alpha1.Strategy{Id: "canslim", Name: "CAN SLIM", Rules: fundamentals}, UniverseCount: 800,
			FundamentalsRowsCount: 600, Regime: downtrend},
			[]string{"None of the 800", "has a growth figure yet (600 hold reported fundamentals)", "growth rules"}},
		{"quality strategy without fundamentals", "", &shortsv1alpha1.GetStrategyPicksResponse{
			Strategy:      &shortsv1alpha1.Strategy{Id: "quality-compounders", Name: "Quality compounders", Rules: fundamentals},
			UniverseCount: 800, Regime: downtrend},
			[]string{"None of the 800", "has reported fundamentals yet", "quality rules read unknown"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := &fakeDataSource{strategyPicks: tc.resp}
			res, out, err := getStrategyPicksHandler(src)(context.Background(), nil,
				GetStrategyPicksInput{StrategyID: "canslim", Status: tc.status})
			if err != nil {
				t.Fatalf("no picks is a result, not an error: %v", err)
			}
			if out.Count != 0 || out.Picks == nil {
				t.Errorf("empty result malformed: count=%d picks=%v", out.Count, out.Picks)
			}
			text := textOf(t, res)
			for _, want := range tc.want {
				if !strings.Contains(text, want) {
					t.Errorf("summary missing %q: %q", want, text)
				}
			}
		})
	}
}

func TestGetStrategyPicksSurfacesBackendErrorsAndNilBodies(t *testing.T) {
	in := GetStrategyPicksInput{StrategyID: "canslim"}
	if _, _, err := getStrategyPicksHandler(&fakeDataSource{})(context.Background(), nil, in); err == nil {
		t.Error("expected an error when the RPC returns no body")
	}
	src := &fakeDataSource{err: connect.NewError(connect.CodeInternal, errors.New("failed to evaluate strategy"))}
	_, _, err := getStrategyPicksHandler(src)(context.Background(), nil, in)
	if err == nil || !strings.Contains(err.Error(), "canslim") {
		t.Errorf("backend error should surface naming the strategy, got %v", err)
	}
}
