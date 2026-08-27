package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"

	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
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
		TotalCount: 41,
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
	if out.TotalCount != 41 || out.Returned != 1 {
		t.Errorf("counts not mapped: %+v", out)
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
