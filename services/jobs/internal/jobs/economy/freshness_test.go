package economy

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestFreshnessCadencesCoverExactlyRegisteredEconomySources(t *testing.T) {
	registered := make(map[string]bool)
	for _, source := range sourceDefs {
		if source.SignalKind == "economic_series" {
			registered[source.Key] = true
		}
	}

	if len(sourceFreshnessCadences) != len(registered) {
		t.Fatalf("freshness cadence entries = %d, registered economy sources = %d", len(sourceFreshnessCadences), len(registered))
	}
	for key := range registered {
		if _, ok := sourceFreshnessCadences[key]; !ok {
			t.Errorf("freshness cadence table missing registered economy source %q", key)
		}
	}
	for key := range sourceFreshnessCadences {
		if !registered[key] {
			t.Errorf("freshness cadence table contains unregistered economy source %q", key)
		}
	}

	if got := sourceFreshnessCadences["abs-cpi"]; got.Cadence != "quarterly" {
		t.Errorf("abs-cpi cadence = %q, want loosest source cadence quarterly", got.Cadence)
	}
	if got := sourceFreshnessCadences["derived-shorted-economy"]; got.Cadence != "quarterly" {
		t.Errorf("derived-shorted-economy cadence = %q, want slowest meaningful source cadence quarterly", got.Cadence)
	}

	wantThresholds := map[string]int{
		"rba-key-indicators":          75,
		"rba-commodity-prices":        75,
		"rba-credit-aggregates":       75,
		"abs-cpi":                     260,
		"abs-labour-force":            140,
		"abs-job-vacancies":           260,
		"abs-wage-price-index":        260,
		"abs-household-spending":      140,
		"abs-lending-indicators":      260,
		"abs-construction-work-done":  260,
		"abs-business-indicators":     260,
		"abs-recorded-crime-victims":  1010,
		"abs-merch-trade-state":       140,
		"abs-state-accounts":          260,
		"abs-building-approvals":      140,
		"abs-retail-trade":            110,
		"abs-population":              400,
		"abs-government-finance":      280,
		"dcceew-petroleum-statistics": 140,
		"derived-shorted-markets":     75,
		"derived-shorted-economy":     260,
	}
	for key, want := range wantThresholds {
		if got := sourceFreshnessCadences[key].thresholdDays(); got != want {
			t.Errorf("%s threshold = %d, want %d", key, got, want)
		}
	}
}

func TestFreshnessThresholdArithmetic(t *testing.T) {
	tests := []struct {
		name   string
		policy freshnessCadence
		want   int
	}{
		{name: "rba daily/monthly", policy: rbaFreshnessCadence, want: 75},
		{name: "monthly", policy: monthlyFreshnessCadence, want: 140},
		{name: "quarterly", policy: quarterlyFreshnessCadence, want: 260},
		{name: "population", policy: populationFreshnessCadence, want: 400},
		{name: "government finance", policy: governmentFinanceFreshnessCadence, want: 280},
		{name: "annual crime", policy: annualFreshnessCadence, want: 1010},
		{name: "correlations", policy: correlationFreshnessCadence, want: 40},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.policy.thresholdDays(); got != tt.want {
				t.Errorf("thresholdDays() = %d, want %d (expected=%d grace=%d)",
					got, tt.want, tt.policy.ExpectedDays, tt.policy.GraceDays)
			}
		})
	}
}

func TestClassifyFreshness(t *testing.T) {
	now := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	atThreshold := now.Add(-140 * 24 * time.Hour)
	olderThanThreshold := now.Add(-141 * 24 * time.Hour)

	tests := []struct {
		name       string
		maxPeriod  *time.Time
		wantAge    int
		wantHasAge bool
		wantStale  bool
	}{
		{name: "threshold is still ok", maxPeriod: &atThreshold, wantAge: 140, wantHasAge: true},
		{name: "older than threshold is stale", maxPeriod: &olderThanThreshold, wantAge: 141, wantHasAge: true, wantStale: true},
		{name: "missing observation is stale", wantStale: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyFreshness("test-source", tt.maxPeriod, now, monthlyFreshnessCadence)
			if got.Stale != tt.wantStale {
				t.Errorf("Stale = %v, want %v", got.Stale, tt.wantStale)
			}
			if (got.AgeDays != nil) != tt.wantHasAge {
				t.Fatalf("AgeDays present = %v, want %v", got.AgeDays != nil, tt.wantHasAge)
			}
			if tt.wantHasAge && *got.AgeDays != tt.wantAge {
				t.Errorf("AgeDays = %d, want %d", *got.AgeDays, tt.wantAge)
			}
			if got.ThresholdDays != 140 {
				t.Errorf("ThresholdDays = %d, want 140", got.ThresholdDays)
			}
		})
	}
}

func TestClassifyFrozenSourceNeverMarksItStale(t *testing.T) {
	now := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	ended := time.Date(2025, 6, 1, 0, 0, 0, 0, time.UTC)

	got := classifyFreshness("abs-retail-trade", &ended, now, sourceFreshnessCadences["abs-retail-trade"])
	if got.Stale {
		t.Error("frozen source must not be stale")
	}
	if !got.Frozen {
		t.Error("frozen source was not classified FROZEN")
	}
	if got.Note != "upstream discontinued 2025-06, superseded by abs-household-spending" {
		t.Errorf("frozen note = %q", got.Note)
	}
}

func TestWriteFreshnessReportSortsEntriesAndEmitsSummary(t *testing.T) {
	now := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	recent := now.Add(-10 * 24 * time.Hour)
	old := now.Add(-1100 * 24 * time.Hour)
	ended := time.Date(2025, 6, 1, 0, 0, 0, 0, time.UTC)
	results := []freshnessResult{
		classifyFreshness("z-source", &recent, now, monthlyFreshnessCadence),
		classifyFreshness("a-source", &old, now, annualFreshnessCadence),
		classifyFreshness("abs-retail-trade", &ended, now, sourceFreshnessCadences["abs-retail-trade"]),
	}

	var out bytes.Buffer
	stale := writeFreshnessReport(&out, results)
	if stale != 1 {
		t.Fatalf("stale count = %d, want 1", stale)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("report lines = %d, want 4:\n%s", len(lines), out.String())
	}
	if !strings.HasPrefix(lines[0], "source_key=a-source ") ||
		!strings.Contains(lines[0], "max_period=2023-07-21 age_days=1100 threshold=1010 status=STALE") {
		t.Errorf("first entry = %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "source_key=abs-retail-trade ") ||
		!strings.Contains(lines[1], `threshold=110 status=FROZEN note="upstream discontinued 2025-06, superseded by abs-household-spending"`) {
		t.Errorf("second entry = %q", lines[1])
	}
	if !strings.HasPrefix(lines[2], "source_key=z-source ") ||
		!strings.Contains(lines[2], "status=OK") {
		t.Errorf("third entry = %q", lines[2])
	}
	if lines[3] != "freshness: total=3 stale=1 warn=0 frozen=1" {
		t.Errorf("summary = %q, want %q", lines[3], "freshness: total=3 stale=1 warn=0 frozen=1")
	}
}

// A source drifting toward its threshold must say so BEFORE it goes red — the
// thresholds are calibrated against measured publisher lags, so a publisher
// slipping its release is exactly the drift this is meant to surface.
func TestFreshnessWarnsWithinThresholdHeadroom(t *testing.T) {
	now := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	// monthlyFreshnessCadence threshold = 140 days; the warn floor is 126.
	comfortable := now.Add(-126 * 24 * time.Hour)
	insideHeadroom := now.Add(-127 * 24 * time.Hour)
	atThreshold := now.Add(-140 * 24 * time.Hour)
	past := now.Add(-141 * 24 * time.Hour)

	tests := []struct {
		name      string
		maxPeriod time.Time
		cadence   freshnessCadence
		wantWarn  bool
		wantStale bool
	}{
		{name: "exactly at the floor is not yet a warning", maxPeriod: comfortable, cadence: monthlyFreshnessCadence},
		{name: "inside the last 10% warns", maxPeriod: insideHeadroom, cadence: monthlyFreshnessCadence, wantWarn: true},
		{name: "at the threshold still warns", maxPeriod: atThreshold, cadence: monthlyFreshnessCadence, wantWarn: true},
		{name: "past the threshold is STALE, not WARN", maxPeriod: past, cadence: monthlyFreshnessCadence, wantStale: true},
		// A frozen source sits past its threshold by design; warning about it
		// every month is the noise the FROZEN status exists to remove.
		{name: "frozen never warns", maxPeriod: past, cadence: sourceFreshnessCadences["abs-retail-trade"]},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyFreshness("test-source", &tt.maxPeriod, now, tt.cadence)
			if got.Warn != tt.wantWarn {
				t.Errorf("Warn = %v, want %v (age=%d threshold=%d)", got.Warn, tt.wantWarn, *got.AgeDays, got.ThresholdDays)
			}
			if got.Stale != tt.wantStale {
				t.Errorf("Stale = %v, want %v", got.Stale, tt.wantStale)
			}
		})
	}
}

// The WARN must reach the report — a warning nobody prints is not a warning —
// and must not move the stale count that decides the sentinel's exit code.
func TestWriteFreshnessReportEmitsWarnWithoutFailing(t *testing.T) {
	now := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	insideHeadroom := now.Add(-130 * 24 * time.Hour)
	results := []freshnessResult{
		classifyFreshness("w-source", &insideHeadroom, now, monthlyFreshnessCadence),
	}

	var out bytes.Buffer
	if stale := writeFreshnessReport(&out, results); stale != 0 {
		t.Fatalf("stale count = %d, want 0 — a WARN must not fail the sentinel", stale)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if !strings.Contains(lines[0], "age_days=130 threshold=140 status=WARN") {
		t.Errorf("entry = %q, want status=WARN", lines[0])
	}
	if lines[1] != "freshness: total=1 stale=0 warn=1 frozen=0" {
		t.Errorf("summary = %q", lines[1])
	}
}

func TestFreshnessSQLShape(t *testing.T) {
	sourceSQL := strings.ToLower(strings.Join(strings.Fields(sourceFreshnessQuery), " "))
	for _, want := range []string{
		"from economic_series",
		"join economic_observations",
		"max(obs.period)",
		"group by series.source_key",
	} {
		if !strings.Contains(sourceSQL, want) {
			t.Errorf("source freshness query missing %q:\n%s", want, sourceFreshnessQuery)
		}
	}

	correlationSQL := strings.ToLower(strings.Join(strings.Fields(correlationFreshnessQuery), " "))
	if !strings.Contains(correlationSQL, "max(computed_at)") ||
		!strings.Contains(correlationSQL, "from economic_correlations") {
		t.Errorf("correlation freshness query has wrong shape:\n%s", correlationFreshnessQuery)
	}
}
