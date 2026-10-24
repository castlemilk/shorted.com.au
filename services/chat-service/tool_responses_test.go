package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

// TestStockDetailsKeepsMarketCapWhenTheStatementsAreLarge reproduces the defect the
// raw response had: the financial reports and industry history push marketCap past
// the result budget, so a raw cut drops it. The shaped result must keep it.
func TestStockDetailsKeepsMarketCapWhenTheStatementsAreLarge(t *testing.T) {
	details := &stocksv1alpha1.StockDetails{
		ProductCode: "BHP",
		CompanyName: "BHP Group Limited",
		Industry:    "Materials",
		Summary:     "Diversified miner.",
		FinancialStatements: &stocksv1alpha1.FinancialStatements{
			Success: true,
			Info:    &stocksv1alpha1.FinancialStatementsInfo{MarketCap: 331023450112, PeRatio: 24.04, Eps: 2.71},
		},
	}
	for range 60 {
		details.FinancialReports = append(details.FinancialReports, &stocksv1alpha1.FinancialReport{
			Url:   "https://example.test/report",
			Title: strings.Repeat("Annual report and results ", 12),
		})
	}
	for range 200 {
		details.IndustryHistory = append(details.IndustryHistory, &stocksv1alpha1.IndustryObservation{
			Industry: "Materials", ObservedFrom: "2026-09-01", Source: "seed",
		})
	}
	for i := range 12 {
		details.KeyPeople = append(details.KeyPeople, &stocksv1alpha1.CompanyPerson{
			Name: fmt.Sprintf("Person-%02d", i), Role: "Director",
		})
	}

	body, err := protojson.Marshal(details)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if index := strings.Index(string(body), "marketCap"); index <= maxToolResultBytes {
		t.Fatalf("fixture puts marketCap at byte %d, inside the budget; the test would pass without shaping", index)
	}

	executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	result, err := executor.Execute(context.Background(), "get_stock_details", map[string]any{"stock_code": "bhp"})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if strings.HasSuffix(result, "...(truncated)") {
		t.Fatalf("result was cut at the budget: %.200s", result)
	}
	if !json.Valid([]byte(result)) {
		t.Fatalf("result is not valid JSON: %.200s", result)
	}
	for _, want := range []string{`"marketCap":331023450112`, `"peRatio":24.04`, `"companyName":"BHP Group Limited"`, `"summary":"Diversified miner."`} {
		if !strings.Contains(result, want) {
			t.Errorf("result lacks %s", want)
		}
	}
	for _, dropped := range []string{`"financialReports"`, `"financialStatements"`, `"industryHistory"`, `"annual"`} {
		if strings.Contains(result, dropped) {
			t.Errorf("result keeps %s, which the model does not need", dropped)
		}
	}
	if !strings.Contains(result, `"Person-07"`) || strings.Contains(result, `"Person-08"`) {
		t.Errorf("key people = %s, want the first %d", result, keyPeopleLimit)
	}
}

func TestStockDetailsWithoutStatementsStillDecodes(t *testing.T) {
	result, err := summarizeStockDetails([]byte(`{"productCode":"XYZ","companyName":"X Ltd"}`))
	if err != nil {
		t.Fatalf("summarizeStockDetails() error = %v", err)
	}
	if !strings.Contains(result, `"productCode":"XYZ"`) || strings.Contains(result, `"marketCap"`) {
		t.Errorf("result = %s, want the profile and no valuation figures", result)
	}
}

// TestWeeklyReportKeepsMoversAndSectorsWithinBudget uses a report bigger than the
// budget. Its trend insights and FAQs are dropped, the lists are cut to the top
// entries, and the narrative, market statistics and sector breakdown are kept.
func TestWeeklyReportKeepsMoversAndSectorsWithinBudget(t *testing.T) {
	report := &shortsv1alpha1.GetWeeklyReportResponse{
		WeekSlug:     "2026-W43",
		Headline:     "Shorts shift",
		Summary:      "Summary text.",
		ReportDate:   "2026-10-19",
		PreviousDate: "2026-10-12",
		Narrative: &shortsv1alpha1.WeeklyNarrative{
			OpeningHook:      strings.Repeat("hook ", 300),
			TopAnalysis:      strings.Repeat("top ", 800),
			MoversAnalysis:   "movers-analysis-text " + strings.Repeat("movers ", 100),
			IndustryAnalysis: strings.Repeat("industry ", 200),
			Outlook:          "outlook-text",
		},
		MarketStats: &shortsv1alpha1.WeeklyMarketStats{TotalStocksShorted: 694, AvgShortPct: 1.57},
	}
	history := []float64{12.1, 12.4, 13.0, 13.4}
	for i := range 8 {
		report.TopShorted = append(report.TopShorted, &shortsv1alpha1.WeeklyReportStock{
			Rank: int32(i + 1), Code: fmt.Sprintf("T%d", i), ShortPct: 10, History: history, LogoUrl: "https://example.test/logo.png",
		})
		report.Risers = append(report.Risers, &shortsv1alpha1.WeeklyReportMover{
			Code: fmt.Sprintf("R%d", i), Change: 1, History: history, Significance: 1.2,
		})
		report.Fallers = append(report.Fallers, &shortsv1alpha1.WeeklyReportMover{
			Code: fmt.Sprintf("F%d", i), Change: -1, History: history, LogoUrl: "https://example.test/logo.png",
		})
	}
	for i := range 12 {
		report.IndustryBreakdown = append(report.IndustryBreakdown, &shortsv1alpha1.WeeklyIndustryStat{
			Industry: fmt.Sprintf("Industry-%02d", i), AvgShortPct: 2, StockCount: 10,
		})
	}
	for i := range 3 {
		report.Citations = append(report.Citations, &shortsv1alpha1.WeeklyReportCitation{
			Id: fmt.Sprintf("ref-%d", i+1), Source: "ASIC", Date: "2026-10-19", Url: "https://example.test/source", Type: "asic_data",
		})
	}
	for i := range 40 {
		report.TrendInsights = append(report.TrendInsights, &shortsv1alpha1.WeeklyReportTrendInsight{
			Code: fmt.Sprintf("TI%d", i), KeyAnnouncements: []string{strings.Repeat("announcement ", 30)},
		})
	}
	for range 5 {
		report.Faqs = append(report.Faqs, &shortsv1alpha1.WeeklyReportFAQ{Question: "question?", Answer: strings.Repeat("answer ", 25)})
	}

	body, err := protojson.Marshal(report)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if len(body) <= maxWeeklyReportBytes {
		t.Fatalf("fixture is %d bytes, want it over the report budget so the test means something", len(body))
	}

	executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	result, err := executor.Execute(context.Background(), "get_weekly_report", map[string]any{"week": "2026-W43"})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if strings.HasSuffix(result, "...(truncated)") {
		t.Fatalf("result was cut at the report budget, so the model loses the tail: %.200s", result)
	}

	if len(result) <= maxToolResultBytes {
		t.Errorf("result is %d bytes, within the default budget, so the report budget is not exercised", len(result))
	}

	var out struct {
		TopShorted []struct {
			Code string `json:"code"`
		} `json:"topShorted"`
		Risers []struct {
			Code string `json:"code"`
		} `json:"risers"`
		Fallers []struct {
			Code string `json:"code"`
		} `json:"fallers"`
		IndustryBreakdown []struct {
			Industry string `json:"industry"`
		} `json:"industryBreakdown"`
		Citations []struct {
			ID  string `json:"id"`
			URL string `json:"url"`
		} `json:"citations"`
	}
	if err := json.Unmarshal([]byte(result), &out); err != nil {
		t.Fatalf("result is not valid JSON: %v\n%.200s", err, result)
	}
	if len(out.TopShorted) != weeklyListLimit || len(out.Risers) != weeklyListLimit || len(out.Fallers) != weeklyListLimit {
		t.Errorf("list lengths = %d/%d/%d, want %d each", len(out.TopShorted), len(out.Risers), len(out.Fallers), weeklyListLimit)
	}
	if len(out.Fallers) > 0 && out.Fallers[0].Code != "F0" {
		t.Errorf("first faller = %q, want F0 (list order kept)", out.Fallers[0].Code)
	}
	if len(out.IndustryBreakdown) != 12 {
		t.Errorf("industry breakdown = %d entries, want all 12", len(out.IndustryBreakdown))
	}
	if len(out.Citations) != 3 {
		t.Errorf("citations = %d, want 3", len(out.Citations))
	}
	for _, citation := range out.Citations {
		if citation.URL != "" {
			t.Errorf("citation %s keeps its URL", citation.ID)
		}
	}
	for _, want := range []string{`"weekSlug":"2026-W43"`, `"totalStocksShorted":694`, `"moversAnalysis":"movers-analysis-text `, `"outlook":"outlook-text"`} {
		if !strings.Contains(result, want) {
			t.Errorf("result lacks %s", want)
		}
	}
	for _, dropped := range []string{`"trendInsights"`, `"faqs"`, `"history"`, `"logoUrl"`} {
		if strings.Contains(result, dropped) {
			t.Errorf("result keeps %s, which the model does not need", dropped)
		}
	}
}

// readFixture returns a response recorded from the live Shorts API, from testdata.
func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return body
}

// replyWith returns a handler that answers every request with body.
func replyWith(body []byte) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	})
}

// signalsOutput is a get_stock_signals result as the model reads it. Tests decode the
// wire JSON, so the names checked are the ones the model sees.
type signalsOutput struct {
	Adverse         []signalItemOutput `json:"adverse"`
	Positive        []signalItemOutput `json:"positive"`
	OmittedAdverse  int                `json:"omittedAdverse"`
	OmittedPositive int                `json:"omittedPositive"`
}

type signalItemOutput struct {
	Polarity  string `json:"polarity"`
	Kind      string `json:"kind"`
	Headline  string `json:"headline"`
	Detail    string `json:"detail"`
	Date      string `json:"date"`
	Severity  string `json:"severity"`
	Source    string `json:"source"`
	SourceURL string `json:"sourceUrl"`
}

// decodeSignals fails unless result is valid JSON within the budget, and returns it
// decoded.
func decodeSignals(t *testing.T, result string) signalsOutput {
	t.Helper()
	if len(result) > maxToolResultBytes {
		t.Fatalf("result is %d bytes, over the %d byte budget", len(result), maxToolResultBytes)
	}
	if !json.Valid([]byte(result)) {
		t.Fatalf("result is not valid JSON: %.200s", result)
	}
	var out signalsOutput
	if err := json.Unmarshal([]byte(result), &out); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	return out
}

// TestStockSignalsFitTheBudgetAtLiveSize replays the GetStockSignals response for CBA at
// limit 10, recorded from the live API. Raw it is 32.9 KB and nearly all of it is
// grounding redirects. The budget used to cut it into a prefix that was not valid JSON,
// so the model lost the end. The shaped answer must be whole.
func TestStockSignalsFitTheBudgetAtLiveSize(t *testing.T) {
	body := readFixture(t, "get_stock_signals_cba_10.json")
	if len(body) <= maxToolResultBytes {
		t.Fatalf("fixture is %d bytes, want it over the budget so the test means something", len(body))
	}
	var recorded shortsv1alpha1.GetStockSignalsResponse
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(body, &recorded); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	recordedHeadlines := make(map[string]bool)
	for _, signal := range recorded.GetPositive() {
		recordedHeadlines[signal.GetHeadline()] = true
	}

	executor := newTestToolExecutor(replyWith(body))
	result, err := executor.Execute(context.Background(), "get_stock_signals", map[string]any{"stock_code": "CBA", "limit": 10.0})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	out := decodeSignals(t, result)

	if strings.Contains(result, "vertexaisearch") || strings.Contains(result, `"citations"`) {
		t.Errorf("result keeps a grounding redirect or the citation list")
	}
	if len(out.Positive) != len(recorded.GetPositive()) {
		t.Errorf("positive items = %d, want all %d from the fixture", len(out.Positive), len(recorded.GetPositive()))
	}
	if !strings.Contains(result, `"adverse":[]`) {
		t.Errorf("adverse list is not an empty array: %.200s", result)
	}
	if out.OmittedAdverse != 0 || out.OmittedPositive != 0 {
		t.Errorf("omitted = %d adverse, %d positive, want none", out.OmittedAdverse, out.OmittedPositive)
	}
	for _, item := range out.Positive {
		if item.Polarity != "positive" || !recordedHeadlines[item.Headline] {
			t.Errorf("item %q does not match a fixture positive signal", item.Headline)
		}
	}
}

// TestStockSignalsKeepsAdverseFirstWhenTheBudgetIsTight builds 10 adverse and 40 positive
// signals. The adverse list fits on its own but not beside the positive one, so the budget
// drops positive items. It keeps every adverse item, ordered by severity and then newest.
func TestStockSignalsKeepsAdverseFirstWhenTheBudgetIsTight(t *testing.T) {
	response := &shortsv1alpha1.GetStockSignalsResponse{}
	for i := range 10 {
		severity := "medium"
		if i%2 == 0 {
			severity = "high"
		}
		response.Adverse = append(response.Adverse, &shortsv1alpha1.StockSignal{
			Polarity:  "adverse",
			Kind:      "court",
			Headline:  fmt.Sprintf("Adverse matter %02d", i),
			Detail:    strings.Repeat("detail ", 75),
			EventDate: fmt.Sprintf("2026-%02d-01", i+1),
			Severity:  severity,
		})
	}
	for i := range 40 {
		response.Positive = append(response.Positive, &shortsv1alpha1.StockSignal{
			Polarity:  "positive",
			Kind:      "press",
			Headline:  fmt.Sprintf("Positive item %02d", i),
			Detail:    strings.Repeat("detail ", 40),
			EventDate: fmt.Sprintf("2024-%02d-%02d", i/28+1, i%28+1),
			Severity:  "low",
		})
	}
	body, err := protojson.Marshal(response)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if len(body) <= maxToolResultBytes {
		t.Fatalf("fixture is %d bytes, want it over the budget so the test means something", len(body))
	}

	result, err := summarizeStockSignals(body)
	if err != nil {
		t.Fatalf("summarizeStockSignals() error = %v", err)
	}
	out := decodeSignals(t, result)

	var adverse []string
	for _, item := range out.Adverse {
		adverse = append(adverse, item.Headline)
	}
	wantAdverse := []string{
		"Adverse matter 08", "Adverse matter 06", "Adverse matter 04", "Adverse matter 02", "Adverse matter 00",
		"Adverse matter 09", "Adverse matter 07", "Adverse matter 05", "Adverse matter 03", "Adverse matter 01",
	}
	if !slices.Equal(adverse, wantAdverse) {
		t.Errorf("adverse order = %v, want high severity first, newest first within each", adverse)
	}
	if out.OmittedAdverse != 0 {
		t.Errorf("omittedAdverse = %d, want every adverse item kept", out.OmittedAdverse)
	}
	if len(out.Positive) == 0 || len(out.Positive) >= maxSignalsPerPolarity {
		t.Fatalf("positive items = %d, want the budget to drop some but keep some", len(out.Positive))
	}
	if out.OmittedPositive != 40-len(out.Positive) {
		t.Errorf("omittedPositive = %d, want %d: the 40 fixture items less the %d kept", out.OmittedPositive, 40-len(out.Positive), len(out.Positive))
	}
	if out.Positive[0].Headline != "Positive item 39" {
		t.Errorf("first positive = %q, want the newest kept", out.Positive[0].Headline)
	}
}

// TestStockSignalsCapsEachPolarityAndCountsTheRest checks the per-polarity cap, the
// omitted count, and the empty answer. A count of zero is left out of the JSON.
func TestStockSignalsCapsEachPolarityAndCountsTheRest(t *testing.T) {
	response := &shortsv1alpha1.GetStockSignalsResponse{}
	for i := range 12 {
		response.Positive = append(response.Positive, &shortsv1alpha1.StockSignal{
			Polarity:  "positive",
			Kind:      "award",
			Headline:  fmt.Sprintf("Award %02d", i),
			EventDate: fmt.Sprintf("2025-%02d-01", i+1),
		})
	}
	body, err := protojson.Marshal(response)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}

	result, err := summarizeStockSignals(body)
	if err != nil {
		t.Fatalf("summarizeStockSignals() error = %v", err)
	}
	out := decodeSignals(t, result)
	if len(out.Positive) != maxSignalsPerPolarity || out.OmittedPositive != 2 {
		t.Errorf("positive = %d shown, %d omitted, want %d shown and 2 omitted", len(out.Positive), out.OmittedPositive, maxSignalsPerPolarity)
	}
	if out.Positive[0].Headline != "Award 11" {
		t.Errorf("first positive = %q, want the newest, Award 11", out.Positive[0].Headline)
	}
	if strings.Contains(result, "omittedAdverse") {
		t.Errorf("a zero adverse count is in the result: %s", result)
	}

	empty, err := summarizeStockSignals([]byte(`{}`))
	if err != nil {
		t.Fatalf("summarizeStockSignals(empty) error = %v", err)
	}
	if want := `{"adverse":[],"positive":[]}`; empty != want {
		t.Errorf("empty answer = %s, want %s", empty, want)
	}
}

// TestStockSignalsKeepsThePublisherDomainAndDropsRedirects: a grounding redirect names
// only the grounding service, so it is dropped whatever the case of its host. A publisher
// link keeps its domain, and its URL when the URL is short enough.
func TestStockSignalsKeepsThePublisherDomainAndDropsRedirects(t *testing.T) {
	redirect := "https://vertexaisearch.cloud.google.com/grounding-api-redirect/" + strings.Repeat("A", 250)
	response := &shortsv1alpha1.GetStockSignalsResponse{Positive: []*shortsv1alpha1.StockSignal{
		{Polarity: "positive", Headline: "Publisher link", Citations: []string{redirect, "https://www.ASX.com.au/announcements/cba-result.pdf"}},
		{Polarity: "positive", Headline: "Redirect only", Citations: []string{redirect}},
		{Polarity: "positive", Headline: "Mixed case redirect", Citations: []string{"https://VertexAISearch.cloud.google.com/grounding-api-redirect/AbC"}},
		{Polarity: "positive", Headline: "Long link", Citations: []string{"https://news.example.com/" + strings.Repeat("x", 220)}},
		{Polarity: "positive", Headline: "Not a link", Citations: []string{"see the annual report"}},
	}}
	body, err := protojson.Marshal(response)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}

	result, err := summarizeStockSignals(body)
	if err != nil {
		t.Fatalf("summarizeStockSignals() error = %v", err)
	}
	out := decodeSignals(t, result)
	if strings.Contains(result, "vertexaisearch") {
		t.Errorf("result keeps a grounding redirect: %.200s", result)
	}

	byHeadline := make(map[string]signalItemOutput, len(out.Positive))
	for _, item := range out.Positive {
		byHeadline[item.Headline] = item
	}
	for _, want := range []struct{ headline, source, sourceURL string }{
		{"Publisher link", "asx.com.au", "https://www.ASX.com.au/announcements/cba-result.pdf"},
		{"Redirect only", "", ""},
		{"Mixed case redirect", "", ""},
		{"Long link", "news.example.com", ""},
		{"Not a link", "", ""},
	} {
		item, ok := byHeadline[want.headline]
		if !ok {
			t.Errorf("%s is missing from the result", want.headline)
			continue
		}
		if item.Source != want.source || item.SourceURL != want.sourceURL {
			t.Errorf("%s: source %q and url %q, want %q and %q", want.headline, item.Source, item.SourceURL, want.source, want.sourceURL)
		}
	}
}

// TestSignalsSortByTheLeadingDate: the API sends placeholder dates such as "Unknown" and
// "2019 onwards" beside full dates. Compared as raw strings, "Unknown" would sort ahead of
// the dated signals. Only the leading year, year-month or date orders a signal, and one
// without any sorts last, in the API's order.
func TestSignalsSortByTheLeadingDate(t *testing.T) {
	dates := []string{"2026-09-01", "Unknown", "2024", "", "2019 onwards", "2026-09"}
	response := &shortsv1alpha1.GetStockSignalsResponse{}
	for _, date := range dates {
		response.Adverse = append(response.Adverse, &shortsv1alpha1.StockSignal{
			Polarity:  "adverse",
			Headline:  "[" + date + "]",
			EventDate: date,
			Severity:  "high",
		})
	}
	body, err := protojson.Marshal(response)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}

	result, err := summarizeStockSignals(body)
	if err != nil {
		t.Fatalf("summarizeStockSignals() error = %v", err)
	}
	out := decodeSignals(t, result)

	var got []string
	for _, item := range out.Adverse {
		got = append(got, item.Headline)
	}
	want := []string{"[2026-09-01]", "[2026-09]", "[2024]", "[2019 onwards]", "[Unknown]", "[]"}
	if !slices.Equal(got, want) {
		t.Errorf("adverse order = %v, want the dated signals newest first, then the undated ones in the API's order", got)
	}
}

// TestStockSignalsCapDropsUndatedFirst: at the per-polarity cap, the undated signal is the
// one left out, even though the API sent it first.
func TestStockSignalsCapDropsUndatedFirst(t *testing.T) {
	response := &shortsv1alpha1.GetStockSignalsResponse{}
	response.Positive = append(response.Positive, &shortsv1alpha1.StockSignal{
		Polarity: "positive", Headline: "Undated", EventDate: "Unknown",
	})
	for i := range maxSignalsPerPolarity {
		response.Positive = append(response.Positive, &shortsv1alpha1.StockSignal{
			Polarity: "positive", Headline: fmt.Sprintf("Dated %02d", i), EventDate: fmt.Sprintf("2025-%02d-01", i+1),
		})
	}
	body, err := protojson.Marshal(response)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}

	result, err := summarizeStockSignals(body)
	if err != nil {
		t.Fatalf("summarizeStockSignals() error = %v", err)
	}
	out := decodeSignals(t, result)
	if len(out.Positive) != maxSignalsPerPolarity || out.OmittedPositive != 1 {
		t.Errorf("positive = %d shown, %d omitted, want %d shown and 1 omitted", len(out.Positive), out.OmittedPositive, maxSignalsPerPolarity)
	}
	for _, item := range out.Positive {
		if item.Headline == "Undated" {
			t.Errorf("the undated signal is kept at the cap ahead of dated ones")
		}
	}
}

// TestTopShortsSparklineFitsTheBudgetAtLiveSize replays the GetTopShorts response for the
// top 10 over 3 months, recorded from the live API. Raw it is 37.5 KB with 60 points per
// stock. Shaped, the 10 rows must fit as valid JSON, each sparkline cut to 8 points that
// keep the first and the latest.
func TestTopShortsSparklineFitsTheBudgetAtLiveSize(t *testing.T) {
	body := readFixture(t, "get_top_shorts_3m_10.json")
	if len(body) <= maxToolResultBytes {
		t.Fatalf("fixture is %d bytes, want it over the budget so the test means something", len(body))
	}
	var recorded struct {
		TimeSeries []struct {
			ProductCode         string  `json:"productCode"`
			LatestShortPosition float64 `json:"latestShortPosition"`
			Points              []struct {
				Timestamp     string  `json:"timestamp"`
				ShortPosition float64 `json:"shortPosition"`
			} `json:"points"`
		} `json:"timeSeries"`
	}
	if err := json.Unmarshal(body, &recorded); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	if len(recorded.TimeSeries) != 10 {
		t.Fatalf("fixture has %d rows, want the 10 the test is for", len(recorded.TimeSeries))
	}

	executor := newTestToolExecutor(replyWith(body))
	result, err := executor.Execute(context.Background(), "get_top_shorts", map[string]any{"limit": 10.0})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(result) > maxToolResultBytes {
		t.Fatalf("result is %d bytes, over the %d byte budget", len(result), maxToolResultBytes)
	}
	if !json.Valid([]byte(result)) {
		t.Fatalf("result is not valid JSON: %.200s", result)
	}

	var out struct {
		TimeSeries []struct {
			ProductCode         string  `json:"productCode"`
			Name                string  `json:"name"`
			LatestShortPosition float64 `json:"latestShortPosition"`
			Points              []struct {
				Timestamp     string  `json:"timestamp"`
				ShortPosition float64 `json:"shortPosition"`
			} `json:"points"`
		} `json:"timeSeries"`
		OmittedStocks int `json:"omittedStocks"`
	}
	if err := json.Unmarshal([]byte(result), &out); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if len(out.TimeSeries) != 10 || out.OmittedStocks != 0 {
		t.Fatalf("rows = %d with %d omitted, want all 10 rows", len(out.TimeSeries), out.OmittedStocks)
	}
	for i, row := range out.TimeSeries {
		want := recorded.TimeSeries[i]
		if row.ProductCode != want.ProductCode || row.LatestShortPosition != want.LatestShortPosition || row.Name == "" {
			t.Errorf("row %d = %s %q %v, want %s with latest %v and a name", i, row.ProductCode, row.Name, row.LatestShortPosition, want.ProductCode, want.LatestShortPosition)
		}
		// A stock with fewer points than the cap keeps them all, so the expected count is
		// the smaller of the two.
		if wantPoints := min(len(want.Points), topShortsSparklinePoints); len(row.Points) != wantPoints {
			t.Fatalf("%s has %d points, want %d", row.ProductCode, len(row.Points), wantPoints)
		}
		first, last := row.Points[0], row.Points[len(row.Points)-1]
		wantFirst, wantLast := want.Points[0], want.Points[len(want.Points)-1]
		if first.Timestamp != wantFirst.Timestamp || first.ShortPosition != wantFirst.ShortPosition {
			t.Errorf("%s first point = %+v, want %+v", row.ProductCode, first, wantFirst)
		}
		if last.Timestamp != wantLast.Timestamp || last.ShortPosition != wantLast.ShortPosition {
			t.Errorf("%s latest point = %+v, want %+v", row.ProductCode, last, wantLast)
		}
		for j := 1; j < len(row.Points); j++ {
			if row.Points[j].Timestamp <= row.Points[j-1].Timestamp {
				t.Errorf("%s points are not in time order at %d", row.ProductCode, j)
			}
		}
	}
}

// TestThinSparklineKeepsFirstAndLatestEvenly checks the thinning for short and long
// series. The first and latest points are always kept, and the gaps between the kept
// points differ by at most one.
func TestThinSparklineKeepsFirstAndLatestEvenly(t *testing.T) {
	for _, n := range []int{1, 2, 8, 9, 60, 61, 1000} {
		points := make([]*stocksv1alpha1.TimeSeriesPoint, n)
		for i := range points {
			points[i] = &stocksv1alpha1.TimeSeriesPoint{ShortPosition: float64(i)}
		}
		thinned := thinSparkline(points, topShortsSparklinePoints)
		if want := min(n, topShortsSparklinePoints); len(thinned) != want {
			t.Errorf("n=%d: kept %d points, want %d", n, len(thinned), want)
			continue
		}
		if thinned[0] != points[0] || thinned[len(thinned)-1] != points[n-1] {
			t.Errorf("n=%d: first or latest point is not kept", n)
		}
		if len(thinned) < 2 {
			continue
		}
		minGap, maxGap := n, 0
		for i := 1; i < len(thinned); i++ {
			gap := int(thinned[i].ShortPosition - thinned[i-1].ShortPosition)
			minGap, maxGap = min(minGap, gap), max(maxGap, gap)
		}
		if gap := maxGap - minGap; gap > 1 {
			t.Errorf("n=%d: gaps range from %d to %d, want them even to within one", n, minGap, maxGap)
		}
	}
}

// topShortsBody returns a GetTopShorts response of rows stocks in rank order. Each has
// the given name and a 3-month series of 60 daily points.
func topShortsBody(t *testing.T, rows int, name string) []byte {
	t.Helper()
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	response := &shortsv1alpha1.GetTopShortsResponse{}
	for i := range rows {
		series := &stocksv1alpha1.TimeSeriesData{
			ProductCode:         fmt.Sprintf("T%02d", i),
			Name:                name,
			LatestShortPosition: float64(rows - i),
		}
		for d := range 60 {
			series.Points = append(series.Points, &stocksv1alpha1.TimeSeriesPoint{
				Timestamp:     timestamppb.New(start.AddDate(0, 0, d)),
				ShortPosition: float64(i) + float64(d)/100,
			})
		}
		response.TimeSeries = append(response.TimeSeries, series)
	}
	body, err := protojson.Marshal(response)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	return body
}

// topShortsOutput is a get_top_shorts result as the model reads it.
type topShortsOutput struct {
	TimeSeries []struct {
		ProductCode string `json:"productCode"`
		Points      []struct {
			Timestamp     string  `json:"timestamp"`
			ShortPosition float64 `json:"shortPosition"`
		} `json:"points"`
	} `json:"timeSeries"`
	OmittedStocks int `json:"omittedStocks"`
}

// decodeTopShorts fails unless result is valid JSON within the budget, and returns it
// decoded.
func decodeTopShorts(t *testing.T, result string) topShortsOutput {
	t.Helper()
	if len(result) > maxToolResultBytes {
		t.Fatalf("result is %d bytes, over the %d byte budget", len(result), maxToolResultBytes)
	}
	if !json.Valid([]byte(result)) {
		t.Fatalf("result is not valid JSON: %.200s", result)
	}
	var out topShortsOutput
	if err := json.Unmarshal([]byte(result), &out); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	return out
}

// TestTopShortsKeepsAllFiftyRowsAndThinsTheLowestSparklines: 50 stocks with full sparklines
// are over the budget, but the same rows without their sparklines fit. The lowest-ranked
// sparklines go first, so every row is kept in rank order, the top rows keep theirs, and
// the first row keeps its first and latest points.
func TestTopShortsKeepsAllFiftyRowsAndThinsTheLowestSparklines(t *testing.T) {
	start := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	body := topShortsBody(t, 50, strings.Repeat("Company Name ", 4))
	if len(body) <= maxToolResultBytes {
		t.Fatalf("fixture is %d bytes, want it over the budget so the test means something", len(body))
	}

	result, err := summarizeTopShorts(body)
	if err != nil {
		t.Fatalf("summarizeTopShorts() error = %v", err)
	}
	out := decodeTopShorts(t, result)
	if len(out.TimeSeries) != 50 || out.OmittedStocks != 0 {
		t.Fatalf("rows = %d with %d omitted, want all 50 rows", len(out.TimeSeries), out.OmittedStocks)
	}

	withSparkline := 0
	for i, row := range out.TimeSeries {
		if want := fmt.Sprintf("T%02d", i); row.ProductCode != want {
			t.Errorf("row %d = %s, want %s: rows must stay in rank order", i, row.ProductCode, want)
		}
		if len(row.Points) == 0 {
			continue
		}
		// Sparklines are cleared from the bottom up, so no row can keep one below a row
		// that lost its own.
		if withSparkline != i {
			t.Fatalf("row %d keeps its sparkline, but row %d above it lost its", i, withSparkline)
		}
		withSparkline++
	}
	if withSparkline == 0 || withSparkline == 50 {
		t.Fatalf("%d rows keep a sparkline, want some cleared and some kept so the test means something", withSparkline)
	}

	points := out.TimeSeries[0].Points
	if len(points) != topShortsSparklinePoints {
		t.Fatalf("first row has %d points, want %d", len(points), topShortsSparklinePoints)
	}
	if got, want := points[0].Timestamp, start.Format(time.RFC3339); got != want {
		t.Errorf("first row starts at %s, want %s", got, want)
	}
	if got, want := points[len(points)-1].Timestamp, start.AddDate(0, 0, 59).Format(time.RFC3339); got != want {
		t.Errorf("first row ends at %s, want its latest point %s", got, want)
	}
}

// TestTopShortsDropsRowsOnlyWhenEvenBareRowsDoNotFit: names long enough that 50 rows
// without sparklines are over the budget. Every sparkline but the first row's is cleared
// before any row is dropped, and omittedStocks counts the dropped rows.
func TestTopShortsDropsRowsOnlyWhenEvenBareRowsDoNotFit(t *testing.T) {
	body := topShortsBody(t, 50, strings.Repeat("Long Company Name ", 20))

	result, err := summarizeTopShorts(body)
	if err != nil {
		t.Fatalf("summarizeTopShorts() error = %v", err)
	}
	out := decodeTopShorts(t, result)
	if out.OmittedStocks == 0 {
		t.Fatalf("no rows omitted, so the fixture does not exercise the drop")
	}
	if len(out.TimeSeries)+out.OmittedStocks != 50 {
		t.Errorf("kept %d rows and omitted %d, want 50 in all", len(out.TimeSeries), out.OmittedStocks)
	}
	if len(out.TimeSeries) < 10 {
		t.Errorf("kept %d rows, want at least the 10 the default limit asks for", len(out.TimeSeries))
	}
	for i, row := range out.TimeSeries {
		if want := fmt.Sprintf("T%02d", i); row.ProductCode != want {
			t.Errorf("row %d = %s, want %s: rows must stay in rank order", i, row.ProductCode, want)
		}
		if i > 0 && len(row.Points) > 0 {
			t.Errorf("row %d keeps a sparkline although rows were dropped, so the sparklines below the first row should have been cleared first", i)
		}
	}
	if len(out.TimeSeries[0].Points) != topShortsSparklinePoints {
		t.Errorf("first row has %d points, want its sparkline kept", len(out.TimeSeries[0].Points))
	}
}

// directorTradesBody returns a GetDirectorTrades response of count trades, newest first.
// Each carries the announcement link the API sends, so the rows are as long as real ones.
func directorTradesBody(t *testing.T, count int) []byte {
	t.Helper()
	start := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)
	response := &shortsv1alpha1.GetDirectorTradesResponse{TotalCount: int32(count)}
	for i := range count {
		response.Trades = append(response.Trades, &shortsv1alpha1.DirectorTrade{
			Id:              fmt.Sprintf("0c005e50-0a28-45ba-963d-a6e4aace2d%02d", i),
			StockCode:       "BHP",
			DirectorName:    fmt.Sprintf("Director Name %02d", i),
			TradeType:       "buy",
			SharesTraded:    int64(1000 + i),
			PricePerShare:   60.5,
			TotalValue:      float64(60500 + i),
			TradeDate:       start.AddDate(0, 0, -i).Format("2006-01-02"),
			AnnouncementUrl: "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03139368",
		})
	}
	body, err := protojson.Marshal(response)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	return body
}

// directorTradesOutput is a get_director_trades result as the model and the chat table read it.
type directorTradesOutput struct {
	Trades []struct {
		DirectorName    string `json:"directorName"`
		TradeType       string `json:"tradeType"`
		TradeDate       string `json:"tradeDate"`
		SharesTraded    int64  `json:"sharesTraded"`
		AnnouncementURL string `json:"announcementUrl"`
	} `json:"trades"`
	TotalCount    int `json:"totalCount"`
	OmittedTrades int `json:"omittedTrades"`
}

// decodeDirectorTrades fails unless result is valid JSON within the budget, and returns it
// decoded.
func decodeDirectorTrades(t *testing.T, result string) directorTradesOutput {
	t.Helper()
	if len(result) > maxToolResultBytes {
		t.Fatalf("result is %d bytes, over the %d byte budget", len(result), maxToolResultBytes)
	}
	if !json.Valid([]byte(result)) {
		t.Fatalf("result is not valid JSON: %.200s", result)
	}
	var out directorTradesOutput
	if err := json.Unmarshal([]byte(result), &out); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	return out
}

// TestDirectorTradesKeepsEveryTradeThatFits: ten trades are well under the budget. None is
// dropped, the rows keep the API's order, and the shaped row carries the fields the table
// draws and not the per-row stock code or id.
func TestDirectorTradesKeepsEveryTradeThatFits(t *testing.T) {
	result, err := summarizeDirectorTrades(directorTradesBody(t, 10))
	if err != nil {
		t.Fatalf("summarizeDirectorTrades() error = %v", err)
	}
	out := decodeDirectorTrades(t, result)
	if len(out.Trades) != 10 || out.OmittedTrades != 0 || out.TotalCount != 10 {
		t.Fatalf("trades = %d, omitted = %d, totalCount = %d; want 10, 0 and 10", len(out.Trades), out.OmittedTrades, out.TotalCount)
	}
	for i, trade := range out.Trades {
		if want := fmt.Sprintf("Director Name %02d", i); trade.DirectorName != want {
			t.Errorf("trade %d = %s, want %s: trades must stay in the API's order", i, trade.DirectorName, want)
		}
	}
	first := out.Trades[0]
	if first.SharesTraded != 1000 || first.TradeType != "buy" || first.TradeDate != "2026-09-30" {
		t.Errorf("first trade = %+v, want its shares, type and date", first)
	}
	if strings.Contains(result, "stockCode") || strings.Contains(result, `"id"`) {
		t.Errorf("result carries a per-row stock code or id, which the table does not draw: %.200s", result)
	}
}

// TestDirectorTradesDropsTrailingTradesOverTheBudget: at the tool's 50-row limit the answer
// is over the budget. The trailing trades go, the rest keep the API's order, and
// omittedTrades counts them. totalCount is still the number the API returned.
func TestDirectorTradesDropsTrailingTradesOverTheBudget(t *testing.T) {
	body := directorTradesBody(t, 50)
	if len(body) <= maxToolResultBytes {
		t.Fatalf("fixture is %d bytes, want it over the budget so the test means something", len(body))
	}

	result, err := summarizeDirectorTrades(body)
	if err != nil {
		t.Fatalf("summarizeDirectorTrades() error = %v", err)
	}
	out := decodeDirectorTrades(t, result)
	if out.OmittedTrades == 0 {
		t.Fatalf("no trades omitted, so the fixture does not exercise the drop")
	}
	if len(out.Trades)+out.OmittedTrades != 50 {
		t.Errorf("kept %d trades and omitted %d, want 50 in all", len(out.Trades), out.OmittedTrades)
	}
	if out.TotalCount != 50 {
		t.Errorf("totalCount = %d, want the 50 the API returned", out.TotalCount)
	}
	// A row is about 220 bytes, so a budget of 8000 bytes keeps a few dozen trades.
	if len(out.Trades) < 25 {
		t.Errorf("kept %d trades, want at least 25 of the 50 to fit the budget", len(out.Trades))
	}
	for i, trade := range out.Trades {
		if want := fmt.Sprintf("Director Name %02d", i); trade.DirectorName != want {
			t.Errorf("trade %d = %s, want %s: trades must stay in the API's order", i, trade.DirectorName, want)
		}
	}
}

// TestDirectorTradesEmptyAnswerIsAnEmptyObject: the documented empty answer. No trades and no
// count is the same {} the tool returned before the budget.
func TestDirectorTradesEmptyAnswerIsAnEmptyObject(t *testing.T) {
	result, err := summarizeDirectorTrades([]byte("{}"))
	if err != nil {
		t.Fatalf("summarizeDirectorTrades() error = %v", err)
	}
	if result != "{}" {
		t.Errorf("result = %s, want {}", result)
	}
}
