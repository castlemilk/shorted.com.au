package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

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
	for i := 0; i < 60; i++ {
		details.FinancialReports = append(details.FinancialReports, &stocksv1alpha1.FinancialReport{
			Url:   "https://example.test/report",
			Title: strings.Repeat("Annual report and results ", 12),
		})
	}
	for i := 0; i < 200; i++ {
		details.IndustryHistory = append(details.IndustryHistory, &stocksv1alpha1.IndustryObservation{
			Industry: "Materials", ObservedFrom: "2026-09-01", Source: "seed",
		})
	}
	for i := 0; i < 12; i++ {
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
	result, err := executor.Execute(context.Background(), "get_stock_details", map[string]interface{}{"stock_code": "bhp"})
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
	for i := 0; i < 8; i++ {
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
	for i := 0; i < 12; i++ {
		report.IndustryBreakdown = append(report.IndustryBreakdown, &shortsv1alpha1.WeeklyIndustryStat{
			Industry: fmt.Sprintf("Industry-%02d", i), AvgShortPct: 2, StockCount: 10,
		})
	}
	for i := 0; i < 3; i++ {
		report.Citations = append(report.Citations, &shortsv1alpha1.WeeklyReportCitation{
			Id: fmt.Sprintf("ref-%d", i+1), Source: "ASIC", Date: "2026-10-19", Url: "https://example.test/source", Type: "asic_data",
		})
	}
	for i := 0; i < 40; i++ {
		report.TrendInsights = append(report.TrendInsights, &shortsv1alpha1.WeeklyReportTrendInsight{
			Code: fmt.Sprintf("TI%d", i), KeyAnnouncements: []string{strings.Repeat("announcement ", 30)},
		})
	}
	for i := 0; i < 5; i++ {
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
	result, err := executor.Execute(context.Background(), "get_weekly_report", map[string]interface{}{"week": "2026-W43"})
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
