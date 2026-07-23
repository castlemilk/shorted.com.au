package main

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestNewABSImportersAreRegisteredSources(t *testing.T) {
	type expectedSource struct {
		url     string
		cadence string
		found   bool
	}
	want := map[string]expectedSource{
		"abs-building-approvals":     {url: "https://www.abs.gov.au/statistics/industry/building-and-construction/building-approvals-australia/latest-release", cadence: "Monthly"},
		"abs-retail-trade":           {url: "https://www.abs.gov.au/statistics/industry/retail-and-wholesale-trade/retail-trade-australia/latest-release", cadence: "Monthly"},
		"abs-population":             {url: "https://www.abs.gov.au/statistics/people/population/national-state-and-territory-population/latest-release", cadence: "Quarterly"},
		"abs-job-vacancies":          {url: "https://www.abs.gov.au/statistics/labour/jobs/job-vacancies-australia/latest-release", cadence: "Quarterly"},
		"abs-wage-price-index":       {url: "https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/wage-price-index-australia/latest-release", cadence: "Quarterly"},
		"abs-household-spending":     {url: "https://www.abs.gov.au/statistics/economy/finance/monthly-household-spending-indicator/latest-release", cadence: "Monthly"},
		"abs-lending-indicators":     {url: "https://www.abs.gov.au/statistics/economy/finance/lending-indicators/latest-release", cadence: "Quarterly"},
		"abs-construction-work-done": {url: "https://www.abs.gov.au/statistics/industry/building-and-construction/construction-work-done-australia-preliminary/latest-release", cadence: "Quarterly"},
		"abs-business-indicators":    {url: "https://www.abs.gov.au/statistics/economy/business-indicators/business-indicators-australia/latest-release", cadence: "Quarterly"},
	}
	for _, source := range sourceDefs {
		expected, ok := want[source.Key]
		if !ok {
			continue
		}
		expected.found = true
		want[source.Key] = expected
		if source.Publisher != "Australian Bureau of Statistics" || source.Licence != "CC-BY-4.0" ||
			source.URL != expected.url || source.Cadence != expected.cadence {
			t.Errorf("incomplete ABS source metadata for %q: %#v", source.Key, source)
		}
	}
	for key, expected := range want {
		if !expected.found {
			t.Errorf("sourceDefs missing %q", key)
		}
	}
}

func TestAllModeIncludesNewABSImporters(t *testing.T) {
	want := []string{
		"rba", "cpi", "labour", "trade", "gdp", "approvals", "retail", "population",
		"petroleum", "govfin", "vacancies", "wages", "spending", "lending", "construction", "business", "markets", "derived",
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
	if got := allJobModes[len(allJobModes)-1]; got != "derived" {
		t.Errorf("derived must run last, got final mode %q", got)
	}
	if got := allJobModes[len(allJobModes)-2]; got != "markets" {
		t.Errorf("markets must run immediately before derived, got penultimate mode %q", got)
	}
}

func TestBusinessSourceDocumentsANZSICIsNotGICS(t *testing.T) {
	for _, source := range sourceDefs {
		if source.Key != "abs-business-indicators" {
			continue
		}
		for _, phrase := range []string{"ANZSIC", "GICS", "never"} {
			if !strings.Contains(source.Notes, phrase) {
				t.Errorf("business source notes omit %q distinction: %q", phrase, source.Notes)
			}
		}
		return
	}
	t.Fatal("sourceDefs missing abs-business-indicators")
}

func TestDerivedEconomySourceIsRegistered(t *testing.T) {
	for _, source := range sourceDefs {
		if source.Key != "derived-shorted-economy" {
			continue
		}
		if source.Method != "derived" || source.Licence != "derived" || source.Cadence != "Monthly + quarterly" {
			t.Errorf("derived source metadata = %#v", source)
		}
		if !strings.Contains(source.Notes, "national CPI") {
			t.Errorf("derived source notes omit national-CPI caveat: %q", source.Notes)
		}
		return
	}
	t.Fatal("sourceDefs missing derived-shorted-economy")
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
