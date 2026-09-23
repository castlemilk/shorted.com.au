package main

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCouncilFreshnessPoliciesDoNotDrift(t *testing.T) {
	want := []vgFreshnessPolicy{
		{source: "abs_ba_lga", maxAgeDays: 120, table: "lga_series"},
		{source: "abs_erp_lga", maxAgeDays: 700, table: "lga_series"},
	}
	if !reflect.DeepEqual(councilFreshnessPolicies, want) {
		t.Fatalf("councilFreshnessPolicies = %#v, want %#v", councilFreshnessPolicies, want)
	}
	// Every scheduled council job has a policy, and every policy a job: a
	// scheduled source nobody checks is how a feed goes quietly stale.
	jobs := map[string]bool{}
	for _, j := range scheduledCouncilJobs() {
		jobs[j.name] = true
	}
	for _, p := range councilFreshnessPolicies {
		if !jobs[p.source] {
			t.Errorf("policy %s has no scheduled job", p.source)
		}
		if !strings.Contains(councilFreshnessQuery, "'"+p.source+"'") {
			t.Errorf("councilFreshnessQuery does not read %s", p.source)
		}
		delete(jobs, p.source)
	}
	for j := range jobs {
		t.Errorf("scheduled council job %s has no freshness policy", j)
	}
	normalized := strings.Join(strings.Fields(councilFreshnessQuery), " ")
	if !strings.Contains(normalized, "MAX(period) AS max_period FROM lga_series") || strings.Contains(normalized, "fetched_at") {
		t.Errorf("council freshness must read the newest PERIOD in lga_series: %s", normalized)
	}
}

func TestCouncilFreshnessNamesItsTable(t *testing.T) {
	now := time.Date(2026, time.September, 23, 0, 0, 0, 0, time.UTC)
	stale := now.AddDate(0, 0, -121)
	detail := classifyVGFreshness(now, councilFreshnessPolicies[0], &stale)
	if !strings.Contains(detail, "abs_ba_lga lga_series MAX(period)") {
		t.Errorf("detail = %q", detail)
	}
	fresh := now.AddDate(0, 0, -54) // July 2026 approvals, as published on 2026-09-23
	if d := classifyVGFreshness(now, councilFreshnessPolicies[0], &fresh); d != "" {
		t.Errorf("the current release must be healthy: %q", d)
	}
	// VG policies keep their original wording.
	if d := classifyVGFreshness(now, vgFreshnessPolicies[0], nil); !strings.Contains(d, "vg_nsw house_prices has never") {
		t.Errorf("VG detail = %q", d)
	}
}

func TestRunScheduledCouncilCountsFailures(t *testing.T) {
	var ran []string
	job := func(name string, err error) scheduledCouncilJob {
		return scheduledCouncilJob{name, func(context.Context, *pgxpool.Pool) error {
			ran = append(ran, name)
			return err
		}}
	}
	total, failures := runScheduledCouncil(context.Background(), nil, []scheduledCouncilJob{
		job("a", nil), job("b", errors.New("boom")), job("c", nil),
	})
	if total != 3 || failures != 1 || !reflect.DeepEqual(ran, []string{"a", "b", "c"}) {
		t.Errorf("total=%d failures=%d ran=%v: a failure must not stop the next job", total, failures, ran)
	}
}
