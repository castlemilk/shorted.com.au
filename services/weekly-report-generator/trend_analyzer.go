package main

import (
	"fmt"
	"math"
	"strings"
)

// TrendInsight holds structured analysis for a single riser/faller
type TrendInsight struct {
	Code             string            `json:"code"`
	Direction        string            `json:"direction"` // "riser" or "faller"
	ShortChange      float64           `json:"short_change"`
	PriceCorrelation *PriceCorrelation `json:"price_correlation,omitempty"`
	KeyAnnouncements []string          `json:"key_announcements,omitempty"`
	FinancialSignals []string          `json:"financial_signals,omitempty"`
	MetricSignals    []string          `json:"metric_signals,omitempty"`
	CompositeSignal  string            `json:"composite_signal"`
}

// PriceCorrelation holds short-vs-price pattern data
type PriceCorrelation struct {
	WeeklyPriceChange  float64 `json:"weekly_price_change"`
	MonthlyPriceChange float64 `json:"monthly_price_change"`
	Pattern            string  `json:"pattern"` // "contrarian", "momentum", "covering", "unwinding"
}

// TrendAnalyzer builds TrendInsight for each riser/faller
type TrendAnalyzer struct{}

// NewTrendAnalyzer creates a new TrendAnalyzer
func NewTrendAnalyzer() *TrendAnalyzer {
	return &TrendAnalyzer{}
}

// Analyze builds TrendInsight for all risers and fallers in the report data
func (t *TrendAnalyzer) Analyze(data *ReportData) map[string]TrendInsight {
	insights := make(map[string]TrendInsight)

	for _, m := range data.Risers {
		insights[m.Code] = t.buildInsight(m, "riser", data)
	}
	for _, m := range data.Fallers {
		insights[m.Code] = t.buildInsight(m, "faller", data)
	}

	return insights
}

func (t *TrendAnalyzer) buildInsight(m Mover, direction string, data *ReportData) TrendInsight {
	code := m.Code
	insight := TrendInsight{
		Code:        code,
		Direction:   direction,
		ShortChange: m.Change,
	}

	// Price correlation
	if price, ok := data.PriceContext[code]; ok && price.CurrentPrice > 0 {
		pc := &PriceCorrelation{
			WeeklyPriceChange:  price.WeeklyChangePct,
			MonthlyPriceChange: price.MonthlyChangePct,
			Pattern:            classifyPattern(m.Change, price.WeeklyChangePct),
		}
		insight.PriceCorrelation = pc
	}

	// Key announcements (first 3 price-sensitive ones)
	if anns, ok := data.Announcements[code]; ok {
		for _, a := range anns {
			if len(insight.KeyAnnouncements) >= 3 {
				break
			}
			if a.IsPriceSensitive {
				insight.KeyAnnouncements = append(insight.KeyAnnouncements, fmt.Sprintf("[%s] %s", a.Date, a.Headline))
			}
		}
		// Fill with non-price-sensitive if we have fewer than 3
		if len(insight.KeyAnnouncements) < 3 {
			for _, a := range anns {
				if len(insight.KeyAnnouncements) >= 3 {
					break
				}
				if !a.IsPriceSensitive {
					insight.KeyAnnouncements = append(insight.KeyAnnouncements, fmt.Sprintf("[%s] %s", a.Date, a.Headline))
				}
			}
		}
	}

	// Financial signals from extracted reports
	if highlights, ok := data.FinancialHighlights[code]; ok {
		for _, h := range highlights {
			for metricName, entries := range h.Metrics {
				for _, attrs := range entries {
					signal := formatFinancialSignal(metricName, attrs, h.ReportTitle)
					if signal != "" {
						insight.FinancialSignals = append(insight.FinancialSignals, signal)
					}
				}
			}
			if len(insight.FinancialSignals) >= 5 {
				insight.FinancialSignals = insight.FinancialSignals[:5]
				break
			}
		}
	}

	// Metric signals from parsed key metrics
	if meta, ok := data.CompanyContext[code]; ok && meta.ParsedMetrics != nil {
		pm := meta.ParsedMetrics
		if pm.PERatio != nil {
			if *pm.PERatio > 30 {
				insight.MetricSignals = append(insight.MetricSignals, fmt.Sprintf("High P/E (%.1f) — expensive valuation", *pm.PERatio))
			} else if *pm.PERatio < 10 && *pm.PERatio > 0 {
				insight.MetricSignals = append(insight.MetricSignals, fmt.Sprintf("Low P/E (%.1f) — value or distressed", *pm.PERatio))
			}
		}
		if pm.Beta != nil && *pm.Beta > 1.5 {
			insight.MetricSignals = append(insight.MetricSignals, fmt.Sprintf("High beta (%.2f) — elevated volatility", *pm.Beta))
		}
		if pm.DividendYield != nil && *pm.DividendYield > 6 {
			insight.MetricSignals = append(insight.MetricSignals, fmt.Sprintf("High dividend yield (%.1f%%) — may signal market concern", *pm.DividendYield))
		}
	}

	// Composite signal (incorporates streak + z-score from the mover)
	insight.CompositeSignal = t.buildCompositeSignal(insight, m)

	return insight
}

// classifyPattern determines the short-vs-price pattern
func classifyPattern(shortChange, weeklyPriceChange float64) string {
	shortsRising := shortChange > 0
	priceRising := weeklyPriceChange > 0

	switch {
	case shortsRising && priceRising:
		return "contrarian" // bearish conviction despite price gains
	case shortsRising && !priceRising:
		return "momentum" // shorts following price decline
	case !shortsRising && priceRising:
		return "covering" // closing positions on price recovery
	default:
		return "unwinding" // reducing positions despite price weakness
	}
}

func formatFinancialSignal(metricName string, attrs map[string]string, reportTitle string) string {
	label := strings.ReplaceAll(metricName, "_", " ")

	var parts []string
	if v, ok := attrs["value_millions"]; ok {
		parts = append(parts, fmt.Sprintf("$%sM", v))
	} else if v, ok := attrs["value_cents"]; ok {
		parts = append(parts, fmt.Sprintf("%sc", v))
	} else if v, ok := attrs["value"]; ok {
		parts = append(parts, v)
	}
	if v, ok := attrs["period"]; ok {
		parts = append(parts, v)
	}

	if len(parts) == 0 {
		return ""
	}
	return fmt.Sprintf("%s: %s (%s)", label, strings.Join(parts, ", "), reportTitle)
}

// ordinal renders 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th", ...
func ordinal(n int) string {
	switch {
	case n%100 >= 11 && n%100 <= 13:
		return fmt.Sprintf("%dth", n)
	case n%10 == 1:
		return fmt.Sprintf("%dst", n)
	case n%10 == 2:
		return fmt.Sprintf("%dnd", n)
	case n%10 == 3:
		return fmt.Sprintf("%drd", n)
	default:
		return fmt.Sprintf("%dth", n)
	}
}

func (t *TrendAnalyzer) buildCompositeSignal(insight TrendInsight, m Mover) string {
	var parts []string

	// Streak: consecutive weekly moves in the same direction (incl. current week)
	if m.StreakWeeks >= 2 {
		riseFall := "weekly rise"
		if insight.ShortChange < 0 {
			riseFall = "weekly fall"
		}
		parts = append(parts, fmt.Sprintf("%s consecutive %s", ordinal(m.StreakWeeks), riseFall))
	}

	// Statistical unusualness vs the stock's own 13-week weekly-delta history
	if math.Abs(m.ZScore) >= 2 {
		parts = append(parts, fmt.Sprintf("%.1f sigma vs its 13-week norm", m.ZScore))
	}

	// Pattern description
	if insight.PriceCorrelation != nil {
		pc := insight.PriceCorrelation
		patternDesc := map[string]string{
			"contrarian": "shorts rising despite price gains",
			"momentum":   "shorts following price weakness",
			"covering":   "short covering on price recovery",
			"unwinding":  "positions unwinding despite price weakness",
		}
		desc := patternDesc[pc.Pattern]
		// 2dp so any figure the model copies from this signal passes the
		// quality checker's exact-value validation.
		parts = append(parts, fmt.Sprintf("%s (price %+.2f%% weekly)", desc, pc.WeeklyPriceChange))
	}

	// Announcement count
	if len(insight.KeyAnnouncements) > 0 {
		parts = append(parts, fmt.Sprintf("%d price-sensitive announcement(s)", len(insight.KeyAnnouncements)))
	}

	// Metric flags
	if len(insight.MetricSignals) > 0 {
		parts = append(parts, insight.MetricSignals[0])
	}

	shortDir := "rose"
	if insight.ShortChange < 0 {
		shortDir = "fell"
	}

	if len(parts) == 0 {
		return fmt.Sprintf("Short interest %s %+.2f%% with limited contextual data", shortDir, math.Abs(insight.ShortChange))
	}

	return fmt.Sprintf("Short interest %s %+.2f%%: %s", shortDir, insight.ShortChange, strings.Join(parts, "; "))
}
