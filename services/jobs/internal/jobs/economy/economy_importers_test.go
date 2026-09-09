package economy

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
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
		"abs-recorded-crime-victims": {url: "https://www.abs.gov.au/statistics/people/crime-and-justice/recorded-crime-victims/latest-release", cadence: "Annual"},
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
		"rba", "fred", "pinksheet", "cpi", "labour", "trade", "gdp", "approvals", "population",
		"petroleum", "govfin", "vacancies", "wages", "spending", "lending", "construction", "business", "crime", "markets", "derived", "correlations",
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
	if got := allJobModes[len(allJobModes)-1]; got != "correlations" {
		t.Errorf("correlations must run last, got final mode %q", got)
	}
	if got := allJobModes[len(allJobModes)-4]; got != "crime" {
		t.Errorf("crime must run immediately before markets, got mode %q", got)
	}
	if got := allJobModes[len(allJobModes)-3]; got != "markets" {
		t.Errorf("markets must run immediately before derived, got mode %q", got)
	}
	if got := allJobModes[len(allJobModes)-2]; got != "derived" {
		t.Errorf("derived must run immediately before correlations, got mode %q", got)
	}
}

// abs-retail-trade was discontinued upstream in 2025-06. Walking it monthly can
// only re-fetch a static series or fail on an unmaintained flow — but the mode
// and the source must survive, so a backfill or an upstream revival needs no
// code change.
func TestRetiredRetailModeIsDispatchableButNotWalked(t *testing.T) {
	for _, mode := range allJobModes {
		if mode == "retail" {
			t.Fatal("allJobModes still walks the FROZEN abs-retail-trade source")
		}
	}
	if _, ok := (&collector{}).jobs()["retail"]; !ok {
		t.Error("`-mode retail` must stay dispatchable for backfills")
	}
	if cadence, ok := sourceFreshnessCadences["abs-retail-trade"]; !ok || !cadence.Frozen {
		t.Error("abs-retail-trade must stay registered and FROZEN in the freshness table")
	}
}

// Cloud Run reports every non-zero exit identically, so the exit CODE is the
// only channel that distinguishes "one upstream drifted" from "nothing ran".
func TestAllModesOutcomeDistinguishesDegradedFromDown(t *testing.T) {
	total := len(allJobModes)

	if err := allModesOutcome(nil, total); err != nil {
		t.Errorf("no failures → %v, want nil", err)
	}

	partial := allModesOutcome([]string{"cpi", "petroleum"}, total)
	if partial == nil {
		t.Fatal("partial failure returned nil — a silent drift becomes a stale series")
	}
	if got := runner.ExitCodeOf(partial); got != exitCodeDegraded {
		t.Errorf("partial failure exit code = %d, want %d", got, exitCodeDegraded)
	}
	if msg := partial.Error(); !strings.Contains(msg, "economy: DEGRADED 2/") ||
		!strings.Contains(msg, "[cpi petroleum]") {
		t.Errorf("partial message = %q, want a greppable DEGRADED summary naming the sources", msg)
	}

	down := allModesOutcome(allJobModes, total)
	if got := runner.ExitCodeOf(down); got != 1 {
		t.Errorf("total failure exit code = %d, want 1 (an outage is an ordinary failure)", got)
	}
	if msg := down.Error(); !strings.Contains(msg, "economy: DOWN") {
		t.Errorf("total-failure message = %q, want a DOWN summary", msg)
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
		if source.Method != "derived" || source.Licence != "derived" || source.Cadence != "Annual + monthly + quarterly" {
			t.Errorf("derived source metadata = %#v", source)
		}
		if !strings.Contains(source.Notes, "national CPI") {
			t.Errorf("derived source notes omit national-CPI caveat: %q", source.Notes)
		}
		return
	}
	t.Fatal("sourceDefs missing derived-shorted-economy")
}

func TestCrimeSourceDocumentsCrossStateComparabilityCaveat(t *testing.T) {
	for _, source := range sourceDefs {
		if source.Key != "abs-recorded-crime-victims" {
			continue
		}
		for _, phrase := range []string{"assault", "sexual-assault", "not comparable across states", "recording practices"} {
			if !strings.Contains(strings.ToLower(source.Notes), phrase) {
				t.Errorf("crime source notes omit %q caveat: %q", phrase, source.Notes)
			}
		}
		return
	}
	t.Fatal("sourceDefs missing abs-recorded-crime-victims")
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


// Every importer registered in jobs() must be reachable from `-mode all`, or it
// is dispatchable by hand and never actually collected in production.
//
// This gap is not hypothetical: fred-us-macro was added to jobs() and to the
// freshness table but NOT to allJobModes. It would have imported once by hand,
// then sat in the catalog going stale forever while its freshness cadence
// alarmed about a source the monthly job never walked. Every existing test
// passed — TestAllModeIncludesNewABSImporters pins allJobModes to a literal, so
// an importer missing from BOTH stays invisible to it.
//
// "retail" is the one deliberate exclusion, documented at allJobModes: the
// upstream flow was discontinued in 2025-06 and the mode is kept dispatchable
// for a backfill or an upstream revival.
func TestEveryRegisteredImporterRunsInAllMode(t *testing.T) {
	deliberatelyExcluded := map[string]string{
		"retail": "abs-retail-trade discontinued upstream 2025-06; kept dispatchable only",
	}

	inAll := make(map[string]bool, len(allJobModes))
	for _, mode := range allJobModes {
		inAll[mode] = true
	}

	c := &collector{}
	for mode := range c.jobs() {
		if reason, ok := deliberatelyExcluded[mode]; ok {
			if inAll[mode] {
				t.Errorf("%q is in allJobModes but recorded as excluded (%s) — one of the two is wrong", mode, reason)
			}
			continue
		}
		if !inAll[mode] {
			t.Errorf("importer %q is registered in jobs() but absent from allJobModes: "+
				"it would never run in production, while its freshness cadence alarms", mode)
		}
	}

	// And the converse: a mode in the walk with no importer behind it would
	// panic on a nil lookup mid-run, after earlier sources had already written.
	for _, mode := range allJobModes {
		if mode == "correlations" {
			continue // handled inline in runAll, not via jobs()
		}
		if _, ok := c.jobs()[mode]; !ok {
			t.Errorf("allJobModes contains %q with no importer registered in jobs()", mode)
		}
	}
}

// modeList is the error text a bad -mode prints. A mode missing from it is
// dispatchable but undiscoverable, and the error message actively misleads.
func TestModeListNamesEveryDispatchableMode(t *testing.T) {
	c := &collector{}
	for mode := range c.jobs() {
		if !strings.Contains(modeList, "|"+mode+"|") && !strings.HasSuffix(modeList, "|"+mode) {
			t.Errorf("mode %q is dispatchable but missing from modeList: a typo's error message would omit it", mode)
		}
	}
}
