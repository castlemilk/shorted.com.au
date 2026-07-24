package shorts

import (
	"strings"
	"testing"
)

func TestNormalizeMaxObservations(t *testing.T) {
	tests := []struct {
		input int32
		want  int32
	}{
		{input: -10, want: 1},
		{input: 0, want: 600},
		{input: 1, want: 1},
		{input: 42, want: 42},
		{input: 601, want: 600},
	}
	for _, test := range tests {
		if got := normalizeMaxObservations(test.input); got != test.want {
			t.Errorf("normalizeMaxObservations(%d) = %d, want %d", test.input, got, test.want)
		}
	}
}

func TestNormalizeCorrelationLimit(t *testing.T) {
	tests := []struct {
		input int32
		want  int32
	}{
		{input: -1, want: 100},
		{input: 0, want: 100},
		{input: 1, want: 1},
		{input: 100, want: 100},
		{input: 250, want: 250},
		{input: 251, want: 250},
	}
	for _, test := range tests {
		if got := normalizeCorrelationLimit(test.input); got != test.want {
			t.Errorf("normalizeCorrelationLimit(%d) = %d, want %d", test.input, got, test.want)
		}
	}
}

func TestListSeriesCorrelationsQueryUsesCatalogJoinAndAbsoluteRanking(t *testing.T) {
	for _, fragment := range []string{
		"FROM economic_correlations c",
		"JOIN economic_series es ON es.series_key = c.overlay_series_key",
		"c.abs_r >= $3",
		"ORDER BY c.abs_r DESC",
		"LIMIT $4",
	} {
		if !strings.Contains(listSeriesCorrelationsQuery, fragment) {
			t.Errorf("listSeriesCorrelationsQuery missing %q", fragment)
		}
	}
}

func TestGetEconomicSeriesQueryUsesRequestLimit(t *testing.T) {
	if !strings.Contains(getEconomicSeriesQuery, "LIMIT $3") {
		t.Fatalf("getEconomicSeriesQuery must use max_observations parameter")
	}
}
