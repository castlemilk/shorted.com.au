package main

import (
	"strings"
	"testing"
)

func qcFixtureData() *ReportData {
	return &ReportData{
		ReportType: "weekly",
		TopShorted: []TopStock{
			{Rank: 1, Code: "BHP", Name: "BHP Group", ShortPct: 15.23, WoWChange: 0.45, History: []float64{14.1, 14.55, 15.23}},
			{Rank: 2, Code: "PLS", Name: "Pilbara", ShortPct: 12.5, WoWChange: -0.2},
		},
		Risers: []Mover{
			{Code: "BOE", Name: "Boss Energy", CurrentPct: 9.1, PreviousPct: 8.0, Change: 1.1, History: []float64{7.75, 8.0, 9.1}},
		},
		Fallers: []Mover{
			{Code: "DMP", Name: "Domino's", CurrentPct: 5.0, PreviousPct: 6.4, Change: -1.4},
		},
		MarketStats: MarketStats{
			AvgShortPct:    1.87,
			MedianShortPct: 1.23,
			MaxShortPct:    15.23,
			MaxShortCode:   "BHP",
			WoWAvgChange:   -0.03,
		},
		IndustryBreakdown: []IndustryStat{
			{Industry: "Metals & Mining", AvgShortPct: 4.56, WoWChange: -0.33, StockCount: 42, TopStockCode: "MIN", TopStockPct: 11.11},
		},
		FinancialRefs: map[string][]FinancialReportRef{
			"BHP": {{Title: "BHP H1 FY2026 Results", URL: "https://bhp.com/investors/h1-fy2026.pdf", Date: "2026-02-18"}},
		},
	}
}

func TestBuildValidPercentageSetIncludesNewSignalSources(t *testing.T) {
	t.Parallel()
	set := buildValidPercentageSet(qcFixtureData())

	for _, want := range []float64{
		14.55, // top stock history point
		7.75,  // mover history point
		4.56,  // industry avg
		0.33,  // industry wow (narrative percentages are extracted unsigned)
		11.11, // industry top stock pct
		1.23,  // median short pct
	} {
		if !isPercentageInSet(want, set, 0.001) {
			t.Errorf("valid percentage set missing %v", want)
		}
	}
}

func TestPercentCheckIgnoresDaysToCoverValues(t *testing.T) {
	t.Parallel()
	q := NewQualityChecker("")
	data := qcFixtureData()

	// "8.3 days" is a days-to-cover figure, NOT a percentage — the percent
	// check must not flag it even though 8.3 is absent from the data.
	filler := strings.Repeat("The shorts held steady across the board this week. ", 15)
	narrative := &NarrativeResult{
		Headline: "BHP shorts hit 15.23%",
		Summary:  "BHP short interest reached 15.23% this week.",
		Narrative: Narrative{
			OpeningHook: "BHP (BHP) short interest reached 15.23% this week.",
			TopAnalysis: "Covering the position would take 8.3 days of average volume. " + filler,
			Outlook:     "Watch BHP next week.",
		},
		FAQs: []FAQ{{Question: "q1", Answer: "a"}, {Question: "q2", Answer: "a"}, {Question: "q3", Answer: "a"}},
	}

	issues := q.programmaticCheck(data, narrative)
	for _, issue := range issues {
		if strings.Contains(issue, "unverified percentage") {
			t.Errorf("percent check false-positive on days-to-cover text: %s", issue)
		}
	}
}

func TestCheckHallucinatedTickers(t *testing.T) {
	t.Parallel()
	data := qcFixtureData()

	tests := []struct {
		name       string
		text       string
		wantIssues int
	}{
		{"legit paren ticker", "BHP Group (BHP) stayed on top.", 0},
		{"legit industry top stock", "Mineral Resources (MIN) leads the sector.", 0},
		{"hallucinated paren ticker", "Acme Corp (ZZZ) collapsed.", 1},
		{"hallucinated cashtag", "Shorts piled into $QQQ this week.", 1},
		{"allowlisted acronyms", "The regulator (ASIC) and the exchange (ASX) both weighed in. The CEO resigned.", 0},
		{"financial abbreviations not flagged", "Earnings per share (EPS) fell 12% while net profit after tax (NPAT) shrank; return on equity (ROE), funds under management (FUM) and net tangible assets (NTA) all slid in USD terms, a weak CAGR for a NSW-based lender ($USD).", 0},
		{"two-letter parenthetical never flagged", "The price-to-earnings (PE) multiple compressed and enterprise value (EV) fell.", 0},
		{"bare uppercase not flagged", "ASIC data shows ASX shorts steady. CSL was not mentioned in parens.", 0},
		{"duplicate mentions flagged once", "Acme (ZZZ) and again (ZZZ).", 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			issues := checkHallucinatedTickers(data, tt.text)
			if len(issues) != tt.wantIssues {
				t.Errorf("issues = %v, want %d", issues, tt.wantIssues)
			}
		})
	}
}

func TestCheckHallucinatedURLs(t *testing.T) {
	t.Parallel()
	data := qcFixtureData()

	t.Run("known URL in text passes", func(t *testing.T) {
		narrative := &NarrativeResult{}
		issues := checkHallucinatedURLs(data, narrative, "See https://bhp.com/investors/h1-fy2026.pdf for details.")
		if len(issues) != 0 {
			t.Errorf("issues = %v, want none", issues)
		}
	})

	t.Run("unknown URL in text flagged", func(t *testing.T) {
		narrative := &NarrativeResult{}
		issues := checkHallucinatedURLs(data, narrative, "Per https://made-up.example.com/report the numbers are bad.")
		if len(issues) != 1 || !strings.Contains(issues[0], "made-up.example.com") {
			t.Errorf("issues = %v, want 1 hallucinated URL", issues)
		}
	})

	t.Run("unknown citation URL flagged", func(t *testing.T) {
		narrative := &NarrativeResult{
			Citations: []Citation{{ID: "ref-1", Source: "x", URL: "https://fake.example.org/annual-report"}},
		}
		issues := checkHallucinatedURLs(data, narrative, "No links in the text.")
		if len(issues) != 1 {
			t.Errorf("issues = %v, want 1", issues)
		}
	})

	t.Run("known citation URL passes with trailing punctuation in text", func(t *testing.T) {
		narrative := &NarrativeResult{
			Citations: []Citation{{ID: "ref-1", Source: "x", URL: "https://bhp.com/investors/h1-fy2026.pdf"}},
		}
		issues := checkHallucinatedURLs(data, narrative, "Results here: https://bhp.com/investors/h1-fy2026.pdf.")
		if len(issues) != 0 {
			t.Errorf("issues = %v, want none", issues)
		}
	})
}

func TestProgrammaticCheckFlagsHallucinations(t *testing.T) {
	t.Parallel()
	q := NewQualityChecker("")
	data := qcFixtureData()

	filler := strings.Repeat("The data shows a steady week for short sellers across the board. ", 12)
	narrative := &NarrativeResult{
		Headline: "BHP shorts hit 15.23%",
		Summary:  "BHP short interest reached 15.23%.",
		Narrative: Narrative{
			OpeningHook:    "BHP (BHP) leads at 15.23% while Acme (ZZZ) collapsed.",
			TopAnalysis:    filler,
			MoversAnalysis: "Details at https://totally-invented.example.com/report [ref-1].",
		},
		FAQs:      []FAQ{{Question: "q1", Answer: "a"}, {Question: "q2", Answer: "a"}, {Question: "q3", Answer: "a"}},
		Citations: []Citation{{ID: "ref-1", Source: "ASIC short data", Type: "asic_data"}},
	}

	issues := q.programmaticCheck(data, narrative)
	var tickerIssue, urlIssue bool
	for _, issue := range issues {
		if strings.Contains(issue, "hallucinated ticker ZZZ") {
			tickerIssue = true
		}
		if strings.Contains(issue, "hallucinated URL") {
			urlIssue = true
		}
	}
	if !tickerIssue {
		t.Errorf("expected hallucinated ticker issue, got: %v", issues)
	}
	if !urlIssue {
		t.Errorf("expected hallucinated URL issue, got: %v", issues)
	}
}
