package main

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestNewABSImportersAreRegisteredSources(t *testing.T) {
	want := map[string]bool{
		"abs-building-approvals": false,
		"abs-retail-trade":       false,
		"abs-population":         false,
	}
	for _, source := range sourceDefs {
		if _, ok := want[source.Key]; !ok {
			continue
		}
		want[source.Key] = true
		if source.Publisher != "Australian Bureau of Statistics" || source.Licence != "CC-BY-4.0" || source.URL == "" {
			t.Errorf("incomplete ABS source metadata for %q: %#v", source.Key, source)
		}
	}
	for key, found := range want {
		if !found {
			t.Errorf("sourceDefs missing %q", key)
		}
	}
}

func TestAllModeIncludesNewABSImporters(t *testing.T) {
	want := []string{
		"rba", "cpi", "labour", "trade", "gdp", "approvals", "retail", "population",
		"petroleum", "govfin", "markets",
	}
	if !reflect.DeepEqual(allJobModes, want) {
		t.Fatalf("allJobModes=%#v, want exact deterministic order %#v", allJobModes, want)
	}
	seen := make(map[string]bool, len(allJobModes))
	for _, mode := range allJobModes {
		if seen[mode] {
			t.Errorf("allJobModes contains duplicate %q; failures would be counted twice", mode)
		}
		seen[mode] = true
	}
	if got := allJobModes[len(allJobModes)-1]; got != "markets" {
		t.Errorf("markets must run last, got final mode %q", got)
	}
}

func assertSDMXRowError(t *testing.T, err error, parser string, csvRow int) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s row validation error, got nil", parser)
	}
	for _, want := range []string{parser, fmt.Sprintf("CSV row %d", csvRow)} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
}
