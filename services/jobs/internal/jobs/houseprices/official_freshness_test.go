package houseprices

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestVGFreshnessPoliciesDoNotDrift(t *testing.T) {
	want := []vgFreshnessPolicy{
		{source: "vg_nsw", maxAgeDays: 550},
		{source: "vg_sa", maxAgeDays: 270},
		{source: "vg_vic", maxAgeDays: 550},
	}
	if !reflect.DeepEqual(vgFreshnessPolicies, want) {
		t.Fatalf("vgFreshnessPolicies = %#v, want %#v", vgFreshnessPolicies, want)
	}
}

func TestVGFreshnessQueryUsesPersistedMaxPeriodForEverySource(t *testing.T) {
	normalized := strings.Join(strings.Fields(vgFreshnessQuery), " ")
	want := "SELECT source, MAX(period) AS max_period FROM house_prices WHERE source IN ('vg_nsw', 'vg_sa', 'vg_vic') GROUP BY source ORDER BY source"
	if normalized != want {
		t.Fatalf("vgFreshnessQuery = %q, want %q", normalized, want)
	}
	if strings.Contains(strings.ToLower(normalized), "fetched_at") {
		t.Fatalf("freshness query must not use fetched_at: %s", normalized)
	}
}

func TestClassifyVGFreshnessTreatsThresholdBoundaryAsHealthy(t *testing.T) {
	now := time.Date(2026, time.August, 9, 0, 0, 0, 0, time.UTC)
	policy := vgFreshnessPolicy{source: "vg_nsw", maxAgeDays: 550}
	boundary := now.Add(-550 * 24 * time.Hour)

	if detail := classifyVGFreshness(now, policy, &boundary); detail != "" {
		t.Fatalf("boundary detail = %q, want healthy", detail)
	}
}

func TestClassifyVGFreshnessRejectsMissingAndOlderPeriods(t *testing.T) {
	now := time.Date(2026, time.August, 9, 0, 0, 0, 0, time.UTC)
	policy := vgFreshnessPolicy{source: "vg_sa", maxAgeDays: 270}
	stale := now.Add(-270*24*time.Hour - time.Nanosecond)

	if detail := classifyVGFreshness(now, policy, nil); !strings.Contains(detail, "has never succeeded") {
		t.Fatalf("missing detail = %q, want has never succeeded", detail)
	}
	if detail := classifyVGFreshness(now, policy, &stale); !strings.Contains(detail, "stale beyond 270-day threshold") {
		t.Fatalf("stale detail = %q, want threshold alarm", detail)
	}
}

func TestEnforceVGFreshnessRecordsEveryUnhealthySourceDeterministically(t *testing.T) {
	now := time.Date(2026, time.August, 9, 0, 0, 0, 0, time.UTC)
	nswStale := now.Add(-551 * 24 * time.Hour)
	vicHealthy := now.Add(-550 * 24 * time.Hour)
	policies := []vgFreshnessPolicy{
		{source: "vg_vic", maxAgeDays: 550},
		{source: "vg_sa", maxAgeDays: 270},
		{source: "vg_nsw", maxAgeDays: 550},
	}
	maxPeriods := map[string]*time.Time{
		"vg_nsw": &nswStale,
		"vg_vic": &vicHealthy,
	}
	type recordedRun struct {
		source     string
		lastPeriod *time.Time
		status     string
		detail     string
	}
	var recorded []recordedRun
	recorder := func(_ context.Context, source string, lastPeriod *time.Time, status, detail string) error {
		recorded = append(recorded, recordedRun{source, lastPeriod, status, detail})
		if source == "vg_nsw" {
			return errors.New("simulated write failure")
		}
		return nil
	}

	if code := enforceVGFreshness(context.Background(), now, policies, maxPeriods, recorder); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if len(recorded) != 2 {
		t.Fatalf("recorded %d runs, want 2: %#v", len(recorded), recorded)
	}
	if recorded[0].source != "vg_nsw" || recorded[1].source != "vg_sa" {
		t.Fatalf("record order = %q, %q; want vg_nsw, vg_sa", recorded[0].source, recorded[1].source)
	}
	if recorded[0].lastPeriod == nil || !recorded[0].lastPeriod.Equal(nswStale) {
		t.Fatalf("stale max period = %v, want %v", recorded[0].lastPeriod, nswStale)
	}
	if recorded[1].lastPeriod != nil {
		t.Fatalf("missing source last period = %v, want nil", recorded[1].lastPeriod)
	}
	for _, got := range recorded {
		if got.status != "error" {
			t.Errorf("%s status = %q, want error", got.source, got.status)
		}
	}
}

func TestEnforceVGFreshnessDoesNotWriteHealthySources(t *testing.T) {
	now := time.Date(2026, time.August, 9, 0, 0, 0, 0, time.UTC)
	period := now.Add(-270 * 24 * time.Hour)
	writes := 0
	recorder := func(context.Context, string, *time.Time, string, string) error {
		writes++
		return nil
	}

	code := enforceVGFreshness(
		context.Background(),
		now,
		[]vgFreshnessPolicy{{source: "vg_sa", maxAgeDays: 270}},
		map[string]*time.Time{"vg_sa": &period},
		recorder,
	)
	if code != 0 || writes != 0 {
		t.Fatalf("healthy result = code %d, writes %d; want code 0, no writes", code, writes)
	}
}

func TestAssertVGFreshnessReturnsOneWhenLoadingFails(t *testing.T) {
	loader := func(context.Context) (map[string]*time.Time, error) {
		return nil, errors.New("database unavailable")
	}
	recorder := func(context.Context, string, *time.Time, string, string) error {
		t.Fatal("recorder must not be called after load failure")
		return nil
	}

	if code := assertVGFreshness(context.Background(), time.Now(), vgFreshnessPolicies, loader, recorder); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
}
