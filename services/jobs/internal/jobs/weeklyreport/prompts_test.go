package weeklyreport

import (
	"strings"
	"testing"
)

func promptFixtureData() *ReportData {
	return &ReportData{
		WeekSlug:     "2026-W27",
		ReportDate:   "2026-07-03",
		PreviousDate: "2026-06-26",
		ReportType:   "weekly",
		TopShorted: []TopStock{
			{
				Rank: 1, Code: "PLS", Name: "Pilbara Minerals", ShortPct: 15.23, WoWChange: 0.45,
				DaysToCover: 8.3, IsNewEntrant: false, Industry: "Metals & Mining",
				History: []float64{14.1, 14.55, 15.23},
			},
			{
				Rank: 2, Code: "BOE", Name: "Boss Energy", ShortPct: 12.5, WoWChange: 2.1,
				DaysToCover: 11.4, IsNewEntrant: true, Industry: "Energy",
			},
		},
		Risers: []Mover{
			{
				Code: "SYR", Name: "Syrah Resources", CurrentPct: 9.1, PreviousPct: 8.0, Change: 1.1,
				DaysToCover: 6.5, ZScore: 2.8, StreakWeeks: 3, Industry: "Metals & Mining",
				History: []float64{7.5, 7.75, 8.0, 9.1}, Significance: 1.62,
			},
		},
		Fallers: []Mover{
			{
				Code: "DMP", Name: "Domino's Pizza", CurrentPct: 5.0, PreviousPct: 6.4, Change: -1.4,
				ZScore: -1.1, StreakWeeks: 1, Industry: "Consumer Discretionary", Significance: 1.51,
			},
		},
		MarketStats: MarketStats{
			TotalStocksShorted: 612,
			AvgShortPct:        1.87,
			MedianShortPct:     0.94,
			MaxShortPct:        15.23,
			MaxShortCode:       "PLS",
			WoWAvgChange:       -0.03,
			StocksAbove10Pct:   14,
			StocksAbove5Pct:    58,
			RiserCount:         231,
			FallerCount:        204,
		},
		IndustryBreakdown: []IndustryStat{
			{Industry: "Metals & Mining", AvgShortPct: 4.12, WoWChange: 0.15, StockCount: 42, TopStockCode: "PLS", TopStockPct: 15.23},
			{Industry: "Energy", AvgShortPct: 3.05, WoWChange: -0.22, StockCount: 18, TopStockCode: "BOE", TopStockPct: 12.5},
		},
	}
}

func TestBuildUserPromptRendersNewSections(t *testing.T) {
	t.Parallel()
	prompt := buildUserPrompt(promptFixtureData(), "")

	wantFragments := []string{
		// 2dp formatting discipline
		"15.23% short (WoW change: +0.45%)",
		"12.50% short (WoW change: +2.10%)",
		// Per-stock signal lines
		"days-to-cover: 8.3",
		"NEW TO TOP 10",
		"13w history: 14.10 → 14.55 → 15.23",
		"industry: Metals & Mining",
		// Mover signal lines
		"z-score: +2.80",
		"streak: 3 wks",
		"z-score: -1.10",
		"streak: 1 wk",
		"- Syrah Resources (SYR): 8.00% → 9.10% (change: +1.10%)",
		"- Domino's Pizza (DMP): 6.40% → 5.00% (change: -1.40%)",
	}
	wantFragments = append(wantFragments,
		// Market stats extras
		"Median short %: 0.94%",
		"Stocks above 10% short: 14",
		"Stocks above 5% short: 58",
		"Market breadth: 231 risers vs 204 fallers",
		// Industry breakdown section
		"INDUSTRY BREAKDOWN (aggregate short interest by industry — the ONLY valid basis for industry_analysis):",
		"- Metals & Mining: avg 4.12% short (WoW +0.15%), 42 stocks, most shorted: PLS at 15.23%",
		"- Energy: avg 3.05% short (WoW -0.22%), 18 stocks, most shorted: BOE at 12.50%",
	)

	for _, want := range wantFragments {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing fragment %q", want)
		}
	}
}

func TestBuildUserPromptOmitsUnknownSignals(t *testing.T) {
	t.Parallel()
	data := promptFixtureData()
	data.TopShorted = []TopStock{{Rank: 1, Code: "AAA", Name: "Alpha", ShortPct: 5.0}}
	data.Risers = []Mover{{Code: "BBB", Name: "Beta", CurrentPct: 2.0, PreviousPct: 1.0, Change: 1.0}}
	data.Fallers = nil
	data.IndustryBreakdown = nil

	prompt := buildUserPrompt(data, "")
	if strings.Contains(prompt, "days-to-cover: 0.0") {
		t.Error("prompt must omit unknown (zero) days-to-cover")
	}
	if strings.Contains(prompt, "z-score: +0.00") {
		t.Error("prompt must omit zero z-scores")
	}
	if strings.Contains(prompt, "INDUSTRY BREAKDOWN") {
		t.Error("prompt must omit the industry breakdown section when empty")
	}
}

func TestSystemPromptsIncludeSignalGuideAndStyleCore(t *testing.T) {
	t.Parallel()
	prompts := map[string]string{
		"analytical":   analyticalSystemPrompt,
		"columnist":    geminiNarrativePrompt,
		"amalgamation": amalgamationSystemPrompt,
	}
	for name, p := range prompts {
		if !strings.Contains(p, "DATA SIGNALS GUIDE") {
			t.Errorf("%s prompt missing DATA SIGNALS GUIDE", name)
		}
		if !strings.Contains(p, "CRITICAL ACCURACY RULES") {
			t.Errorf("%s prompt missing accuracy rules", name)
		}
		if !strings.Contains(p, `"it's important to note"`) {
			t.Errorf("%s prompt missing banned AI-ism list", name)
		}
		if !strings.Contains(p, "Return ONLY valid JSON") {
			t.Errorf("%s prompt missing JSON structure block", name)
		}
		if !strings.Contains(p, "Australian English") {
			t.Errorf("%s prompt missing Australian English rule", name)
		}
		// Signal-specific instructions
		for _, sig := range []string{"z-score", "streak", "days-to-cover", "NEW TO TOP 10", "INDUSTRY BREAKDOWN", "13-week history"} {
			if !strings.Contains(p, sig) {
				t.Errorf("%s prompt signals guide missing %q", name, sig)
			}
		}
	}
	// Role differentiation survived the refactor
	if !strings.Contains(analyticalSystemPrompt, "AFR or Livewire Markets") {
		t.Error("analytical prompt lost its persona")
	}
	if !strings.Contains(geminiNarrativePrompt, "Marcus Padley or Alan Kohler") {
		t.Error("columnist prompt lost its persona")
	}
	if !strings.Contains(amalgamationSystemPrompt, "chief editor") {
		t.Error("amalgamation prompt lost its persona")
	}
}

func TestFormatHistorySeries(t *testing.T) {
	t.Parallel()
	got := formatHistorySeries([]float64{1.2, 1.35, 1.5})
	want := "1.20 → 1.35 → 1.50"
	if got != want {
		t.Errorf("formatHistorySeries = %q, want %q", got, want)
	}
}
