package main

import (
	"encoding/json"
	"sort"
	"testing"
)

// The shorts service reads weekly_reports JSONB columns by json.Unmarshal-ing
// directly into generated proto structs, whose encoding/json tags are the
// snake_case proto field names. These tests pin the exact keys this generator
// writes so a rename can never silently break that read path.
//
// logo_url is intentionally ABSENT: it is hydrated at read time, never stored.

func marshalKeys(t *testing.T, v interface{}) []string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal into map: %v", err)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func assertExactKeys(t *testing.T, got, want []string) {
	t.Helper()
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("keys = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("keys = %v, want %v", got, want)
		}
	}
}

func TestTopStockJSONContract(t *testing.T) {
	t.Parallel()
	s := TopStock{
		Rank: 1, Code: "BHP", Name: "BHP Group", ShortPct: 5.5, WoWChange: 0.2,
		DaysToCover: 3.1, IsNewEntrant: true, Industry: "Metals & Mining",
		History: []float64{5.0, 5.5},
	}
	assertExactKeys(t, marshalKeys(t, s), []string{
		"rank", "code", "name", "short_pct", "wow_change",
		"days_to_cover", "is_new_entrant", "industry", "history",
	})
}

func TestMoverJSONContract(t *testing.T) {
	t.Parallel()
	m := Mover{
		Code: "BOE", Name: "Boss Energy", CurrentPct: 9.1, PreviousPct: 8.0, Change: 1.1,
		DaysToCover: 6.5, ZScore: 2.8, StreakWeeks: 3, Industry: "Energy",
		History: []float64{8.0, 9.1}, Significance: 1.62,
	}
	assertExactKeys(t, marshalKeys(t, m), []string{
		"code", "name", "current_pct", "previous_pct", "change",
		"days_to_cover", "z_score", "streak_weeks", "industry", "history", "significance",
	})
}

func TestIndustryStatJSONContract(t *testing.T) {
	t.Parallel()
	s := IndustryStat{
		Industry: "Energy", AvgShortPct: 3.05, WoWChange: -0.22,
		StockCount: 18, TopStockCode: "BOE", TopStockPct: 12.5,
	}
	assertExactKeys(t, marshalKeys(t, s), []string{
		"industry", "avg_short_pct", "wow_change", "stock_count",
		"top_stock_code", "top_stock_pct",
	})
}

func TestMarketStatsJSONContract(t *testing.T) {
	t.Parallel()
	s := MarketStats{
		TotalStocksShorted: 612, AvgShortPct: 1.87, MaxShortPct: 15.23,
		MaxShortCode: "PLS", WoWAvgChange: -0.03, MedianShortPct: 0.94,
		StocksAbove10Pct: 14, StocksAbove5Pct: 58, RiserCount: 231, FallerCount: 204,
	}
	assertExactKeys(t, marshalKeys(t, s), []string{
		"total_stocks_shorted", "avg_short_pct", "max_short_pct", "max_short_code",
		"wow_avg_change", "median_short_pct", "stocks_above_10pct", "stocks_above_5pct",
		"riser_count", "faller_count",
	})
}

// history has omitempty (compact snapshots) — verify empty history simply
// drops the key rather than emitting null, which the proto unmarshal treats
// identically to absent.
func TestHistoryOmittedWhenEmpty(t *testing.T) {
	t.Parallel()
	b, err := json.Marshal(TopStock{Rank: 1, Code: "AAA"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := m["history"]; present {
		t.Error("empty history should be omitted from the snapshot JSON")
	}
}
