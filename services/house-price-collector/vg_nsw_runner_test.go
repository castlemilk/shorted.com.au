package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestScheduledOfficialJobsExcludeResidentialOnlyNSW(t *testing.T) {
	var names []string
	for _, job := range scheduledOfficialJobs() {
		names = append(names, job.name)
	}

	for _, name := range names {
		if name == nswSource {
			t.Fatalf("scheduled official jobs include %q; NSW PSI must run from residential egress only", nswSource)
		}
	}
	for _, want := range []string{"vg_sa", "vg_vic"} {
		found := false
		for _, name := range names {
			if name == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("scheduled official jobs = %v; missing %q", names, want)
		}
	}
}

func TestFreshnessPoliciesForOfficialJobsIncludeOnlyAttemptedVGSources(t *testing.T) {
	got := freshnessPoliciesForOfficialJobs(scheduledOfficialJobs(), vgFreshnessPolicies)
	want := []vgFreshnessPolicy{
		{source: "vg_sa", maxAgeDays: 270},
		{source: "vg_vic", maxAgeDays: 550},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scheduled freshness policies = %#v, want %#v", got, want)
	}

	// The helper derives applicability from jobs; it must not encode a permanent
	// source-name exclusion that would also hide an actually attempted rig source.
	nswOnly := freshnessPoliciesForOfficialJobs(
		[]officialJob{{name: nswSource}},
		vgFreshnessPolicies,
	)
	if len(nswOnly) != 1 || nswOnly[0].source != nswSource {
		t.Fatalf("NSW-only attempted policies = %#v, want vg_nsw", nswOnly)
	}
}

func TestRunNSWVGRigOrchestratesExitAndRefresh(t *testing.T) {
	tests := []struct {
		name          string
		ingestOK      bool
		freshnessCode int
		wantCode      int
		wantCalls     []string
	}{
		{
			name:      "ingest failure is terminal",
			ingestOK:  false,
			wantCode:  1,
			wantCalls: []string{"ingest"},
		},
		{
			name:          "persisted data is stale",
			ingestOK:      true,
			freshnessCode: 1,
			wantCode:      1,
			wantCalls:     []string{"ingest", "freshness", "refresh"},
		},
		{
			name:      "successful fresh ingest",
			ingestOK:  true,
			wantCode:  0,
			wantCalls: []string{"ingest", "freshness", "refresh"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			code := runNSWVGRig(
				func() bool {
					calls = append(calls, "ingest")
					return tc.ingestOK
				},
				func() int {
					calls = append(calls, "freshness")
					return tc.freshnessCode
				},
				func() {
					calls = append(calls, "refresh")
				},
			)

			if code != tc.wantCode {
				t.Fatalf("exit code = %d, want %d", code, tc.wantCode)
			}
			if !reflect.DeepEqual(calls, tc.wantCalls) {
				t.Fatalf("calls = %v, want %v", calls, tc.wantCalls)
			}
		})
	}
}

func TestCollectorTimeoutMinutesUsesNSWOverride(t *testing.T) {
	t.Setenv("VG_NSW_TIMEOUT_MIN", "17")
	t.Setenv("CRAWL_TIMEOUT_MIN", "99")

	if got := collectorTimeoutMinutes("vg-nsw"); got != 17 {
		t.Fatalf("vg-nsw timeout = %d, want VG_NSW_TIMEOUT_MIN value 17", got)
	}
	if got := collectorTimeoutMinutes("official"); got != 99 {
		t.Fatalf("official timeout = %d, want CRAWL_TIMEOUT_MIN value 99", got)
	}
}

func TestRunOfficialJobRejectsRegressedPeriodBeforeWrites(t *testing.T) {
	persisted := time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)
	incoming := time.Date(2024, 12, 31, 0, 0, 0, 0, time.UTC)
	var calls []string
	var recordedPeriod *time.Time
	var recordedStatus, recordedDetail string

	job := officialJob{
		name: vicSource,
		fn: func(context.Context) ([]Observation, error) {
			calls = append(calls, "fetch")
			return []Observation{{Source: vicSource, Period: incoming}}, nil
		},
	}
	io := officialJobIO{
		lockSource: func(context.Context, string) (func(), error) {
			calls = append(calls, "lock")
			return func() { calls = append(calls, "unlock") }, nil
		},
		loadLastPeriod: func(context.Context, string) (*time.Time, error) {
			calls = append(calls, "load-cursor")
			return &persisted, nil
		},
		upsertRegions: func(context.Context, []Observation) error {
			calls = append(calls, "upsert-regions")
			return nil
		},
		upsertObservations: func(context.Context, []Observation) (int, error) {
			calls = append(calls, "upsert-facts")
			return 1, nil
		},
		updateRun: func(_ context.Context, _ string, lastPeriod *time.Time, _ int, status, detail string) error {
			calls = append(calls, "record")
			recordedPeriod, recordedStatus, recordedDetail = lastPeriod, status, detail
			return nil
		},
	}

	for attempt := 1; attempt <= 2; attempt++ {
		if runOfficialJobWith(context.Background(), job, io) {
			t.Fatalf("regressed official run attempt %d reported success", attempt)
		}
	}
	wantCalls := []string{
		"lock", "load-cursor", "fetch", "record", "unlock",
		"lock", "load-cursor", "fetch", "record", "unlock",
	}
	if !reflect.DeepEqual(calls, wantCalls) {
		t.Fatalf("calls = %v, want %v (no fact writes)", calls, wantCalls)
	}
	if recordedPeriod == nil || !recordedPeriod.Equal(persisted) {
		t.Fatalf("recorded period = %v, want persisted cursor %v", recordedPeriod, persisted)
	}
	if recordedStatus != "error" || !strings.Contains(recordedDetail, "regressed") {
		t.Fatalf("recorded status/detail = %q/%q, want regression error", recordedStatus, recordedDetail)
	}
}

func TestRunNSWVGRigPartialCoverageRecordsErrorAndSkipsRefresh(t *testing.T) {
	years := []int{2023, 2024, 2025}
	fetcher := fakeNSWFetcher{
		responses: map[string][]byte{
			fmt.Sprintf("%s%d.zip", nswPSIBase, 2023): nswYearZIPFixture(t, nswDATFixture),
			fmt.Sprintf("%s%d.zip", nswPSIBase, 2024): []byte("Cloudflare challenge"),
			fmt.Sprintf("%s%d.zip", nswPSIBase, 2025): []byte("Cloudflare challenge"),
		},
	}
	var status, detail string
	freshnessCalls, refreshCalls := 0, 0

	code := runNSWVGRig(func() bool {
		return runOfficialJobWith(context.Background(), officialJob{
			name: nswSource,
			fn: func(ctx context.Context) ([]Observation, error) {
				return ingestNSWSuburbMediansWithFetcher(ctx, fetcher, years)
			},
		}, officialJobIO{
			lockSource:     func(context.Context, string) (func(), error) { return func() {}, nil },
			loadLastPeriod: func(context.Context, string) (*time.Time, error) { return nil, nil },
			upsertRegions: func(context.Context, []Observation) error {
				t.Fatal("partial coverage must not upsert regions")
				return nil
			},
			upsertObservations: func(context.Context, []Observation) (int, error) {
				t.Fatal("partial coverage must not upsert facts")
				return 0, nil
			},
			updateRun: func(_ context.Context, _ string, _ *time.Time, _ int, gotStatus, gotDetail string) error {
				status, detail = gotStatus, gotDetail
				return nil
			},
		})
	}, func() int {
		freshnessCalls++
		return 0
	}, func() {
		refreshCalls++
	})

	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if freshnessCalls != 0 || refreshCalls != 0 {
		t.Fatalf("freshness/refresh calls = %d/%d, want 0/0", freshnessCalls, refreshCalls)
	}
	if status != "error" || !strings.Contains(detail, "incomplete NSW PSI coverage") {
		t.Fatalf("recorded status/detail = %q/%q, want incomplete-coverage error", status, detail)
	}
}

func TestRunOfficialJobFailsWhenCursorCannotBeLoadedOrPersisted(t *testing.T) {
	period := time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)
	job := officialJob{
		name: nswSource,
		fn: func(context.Context) ([]Observation, error) {
			return []Observation{{Source: nswSource, Period: period}}, nil
		},
	}

	t.Run("load failure does not erase unknown cursor", func(t *testing.T) {
		unlocked := false
		ok := runOfficialJobWith(context.Background(), job, officialJobIO{
			lockSource: func(context.Context, string) (func(), error) {
				return func() { unlocked = true }, nil
			},
			loadLastPeriod: func(context.Context, string) (*time.Time, error) {
				return nil, errors.New("cursor read failed")
			},
			updateRun: func(context.Context, string, *time.Time, int, string, string) error {
				t.Fatal("cursor-load failure must not write an unknown NULL cursor")
				return nil
			},
		})
		if ok || !unlocked {
			t.Fatalf("result = ok %v, unlocked %v; want false/true", ok, unlocked)
		}
	})

	t.Run("final cursor write is part of success", func(t *testing.T) {
		ok := runOfficialJobWith(context.Background(), job, officialJobIO{
			lockSource:     func(context.Context, string) (func(), error) { return func() {}, nil },
			loadLastPeriod: func(context.Context, string) (*time.Time, error) { return nil, nil },
			upsertRegions:  func(context.Context, []Observation) error { return nil },
			upsertObservations: func(context.Context, []Observation) (int, error) {
				return 1, nil
			},
			updateRun: func(context.Context, string, *time.Time, int, string, string) error {
				return errors.New("cursor write failed")
			},
		})
		if ok {
			t.Fatal("job reported success after final cursor write failed")
		}
	})
}
