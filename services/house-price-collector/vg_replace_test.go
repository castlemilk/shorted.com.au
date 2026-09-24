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

func TestPrunableYearsHoldsBackAYearOverThePruneCap(t *testing.T) {
	stats := []yearPruneStats{
		{Year: 2023, Total: 1808, Stale: 29},  // 1.6% — the real 2026-09-24 clean-up
		{Year: 2024, Total: 1848, Stale: 0},   // nothing to prune
		{Year: 2025, Total: 2295, Stale: 112}, // 4.9%
		{Year: 2022, Total: 1000, Stale: 201}, // 20.1% — a parser regression, not a clean-up
	}
	allowed, held := prunableYears(stats, replaceMaxPruneShare)
	if want := []int{2023, 2025}; !reflect.DeepEqual(allowed, want) {
		t.Fatalf("allowed = %v, want %v", allowed, want)
	}
	if len(held) != 1 || !strings.HasPrefix(held[0], "2022: 201 of 1000") {
		t.Fatalf("held = %v, want the 2022 year named", held)
	}

	// Exactly at the cap is allowed; a zero-total year can never be pruned.
	allowed, held = prunableYears([]yearPruneStats{{Year: 2021, Total: 10, Stale: 2}, {Year: 2020, Total: 0, Stale: 1}}, 0.20)
	if !reflect.DeepEqual(allowed, []int{2021}) || len(held) != 1 {
		t.Fatalf("allowed/held = %v/%v, want [2021] and the zero-total year held", allowed, held)
	}
}

func TestNSWReplaceScopeNeverPrunesAThinYear(t *testing.T) {
	scope := nswReplaceScope(map[int]int{2025: 109071, 2023: 92424, 2024: 1200}, nswReplaceMinSales)
	if scope.Source != nswSource || scope.Measure != "median_price" || scope.DwellingType != "house" || scope.PeriodFreq != "A" {
		t.Fatalf("scope = %+v, want vg_nsw annual house medians", scope)
	}
	// 2024 fetched a fraction of a year: upserted, never pruned.
	if want := []int{2023, 2025}; !reflect.DeepEqual(scope.Years, want) {
		t.Fatalf("years = %v, want %v", scope.Years, want)
	}
	// ...and says so where the exit code can see it, not only in the log.
	if len(scope.Withheld) != 1 || !strings.HasPrefix(scope.Withheld[0], "2024: only 1200 house sales") {
		t.Fatalf("withheld = %q, want the thin 2024 reported", scope.Withheld)
	}
	if got := nswReplaceScope(nil, nswReplaceMinSales).Years; len(got) != 0 {
		t.Fatalf("no counts must mean no authoritative year, got %v", got)
	}
}

func TestEmittedKeysOnlyCoverTheScope(t *testing.T) {
	p := time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)
	scope := replaceScope{Source: nswSource, Measure: "median_price", DwellingType: "house", PeriodFreq: "A"}
	regions, periods := emittedKeys([]Observation{
		{RegionCode: "SUBURB:NSW-BONDI", Source: nswSource, Measure: "median_price", DwellingType: "house", Period: p},
		{RegionCode: "SUBURB:NSW-BONDI", Source: nswSource, Measure: "transfer_count", DwellingType: "house", Period: p},
		{RegionCode: "SUBURB:VIC-FITZROY", Source: vicSource, Measure: "median_price", DwellingType: "house", Period: p},
	}, scope)
	if !reflect.DeepEqual(regions, []string{"SUBURB:NSW-BONDI"}) || !reflect.DeepEqual(periods, []string{"2025-12-31"}) {
		t.Fatalf("keys = %v/%v, want only the in-scope Bondi row", regions, periods)
	}
}

// The counts that decide pruning come from the same fetch as the medians.
func TestIngestNSWSuburbMediansCountedReportsPerYearSales(t *testing.T) {
	years := []int{2024, 2025}
	fetcher := fakeNSWFetcher{responses: map[string][]byte{}}
	for _, yr := range years {
		fetcher.responses[fmt.Sprintf("%s%d.zip", nswPSIBase, yr)] = nswYearZIPFixture(t, nswDATFixture)
	}
	_, counts, err := ingestNSWSuburbMediansCounted(context.Background(), fetcher, years)
	if err != nil {
		t.Fatal(err)
	}
	// The fixture keeps two established-house sales per year.
	if want := map[int]int{2024: 2, 2025: 2}; !reflect.DeepEqual(counts, want) {
		t.Fatalf("counts = %v, want %v", counts, want)
	}
}

func replaceJobIO(t *testing.T, calls *[]string) officialJobIO {
	t.Helper()
	return officialJobIO{
		lockSource:     func(context.Context, string) (func(), error) { return func() {}, nil },
		loadLastPeriod: func(context.Context, string) (*time.Time, error) { return nil, nil },
		upsertRegions:  func(context.Context, []Observation) error { return nil },
		upsertObservations: func(context.Context, []Observation) (int, error) {
			*calls = append(*calls, "upsert")
			return 1, nil
		},
		replaceObservations: func(_ context.Context, _ []Observation, scope replaceScope) (replaceResult, error) {
			*calls = append(*calls, fmt.Sprintf("replace%v", scope.Years))
			return replaceResult{Upserted: 1, Pruned: 3}, nil
		},
		updateRun: func(context.Context, string, *time.Time, int, string, string) error { return nil },
	}
}

func TestRunOfficialJobUsesTheAuthoritativeWriteOnlyWithAScope(t *testing.T) {
	period := time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)
	fn := func(context.Context) ([]Observation, error) {
		return []Observation{{Source: nswSource, Period: period}}, nil
	}

	var calls []string
	withScope := officialJob{name: nswSource, fn: fn, replace: func() *replaceScope {
		return &replaceScope{Source: nswSource, Years: []int{2025}}
	}}
	if !runOfficialJobWith(context.Background(), withScope, replaceJobIO(t, &calls)) {
		t.Fatal("scoped job failed")
	}
	plain := officialJob{name: vicSource, fn: fn}
	if !runOfficialJobWith(context.Background(), plain, replaceJobIO(t, &calls)) {
		t.Fatal("plain job failed")
	}
	if want := []string{"replace[2025]", "upsert"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %v, want %v", calls, want)
	}
}

func TestRunOfficialJobNeverAsksForAScopeWhenTheFetchFailed(t *testing.T) {
	var calls []string
	asked := false
	job := officialJob{
		name:    nswSource,
		fn:      func(context.Context) ([]Observation, error) { return nil, errors.New("incomplete NSW PSI coverage") },
		replace: func() *replaceScope { asked = true; return &replaceScope{Years: []int{2025}} },
	}
	if runOfficialJobWith(context.Background(), job, replaceJobIO(t, &calls)) {
		t.Fatal("failed fetch reported success")
	}
	if asked || len(calls) != 0 {
		t.Fatalf("asked=%v calls=%v; a failed fetch must write and prune nothing", asked, calls)
	}
}

func TestRunOfficialJobRecordsZeroRowsWhenTheReplaceRollsBack(t *testing.T) {
	var rows int
	var status string
	io := replaceJobIO(t, new([]string))
	io.replaceObservations = func(context.Context, []Observation, replaceScope) (replaceResult, error) {
		return replaceResult{Upserted: 5782}, errors.New("prune failed")
	}
	io.updateRun = func(_ context.Context, _ string, _ *time.Time, n int, s, _ string) error {
		rows, status = n, s
		return nil
	}
	job := officialJob{
		name:    nswSource,
		fn:      func(context.Context) ([]Observation, error) { return []Observation{{Source: nswSource}}, nil },
		replace: func() *replaceScope { return &replaceScope{Years: []int{2025}} },
	}
	if runOfficialJobWith(context.Background(), job, io) {
		t.Fatal("failed replace reported success")
	}
	if rows != 0 || status != "error" {
		t.Fatalf("recorded %d rows / %q; a rolled-back transaction wrote nothing", rows, status)
	}
}

// A held-back prune commits the upsert and advances the cursor, but must reach
// the caller: logging it and returning plain success is how the rig used to
// exit 0 on a parser regression.
func TestRunOfficialJobSurfacesAHeldBackPrune(t *testing.T) {
	var status, detail string
	var rows int
	io := replaceJobIO(t, new([]string))
	io.replaceObservations = func(_ context.Context, _ []Observation, scope replaceScope) (replaceResult, error) {
		return replaceResult{Upserted: 5782, HeldBack: append(scope.Withheld, "2025: 459 of 2295 rows unemitted (over 20% prune cap)")}, nil
	}
	io.updateRun = func(_ context.Context, _ string, _ *time.Time, n int, s, d string) error {
		rows, status, detail = n, s, d
		return nil
	}
	job := officialJob{
		name: nswSource,
		fn: func(context.Context) ([]Observation, error) {
			return []Observation{{Source: nswSource, Period: time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)}}, nil
		},
		replace: func() *replaceScope {
			return &replaceScope{Years: []int{2025}, Withheld: []string{"2024: only 1200 house sales (under the 50000 floor)"}}
		},
	}
	ok, held := runOfficialJobOutcome(context.Background(), job, io)
	if !ok {
		t.Fatal("a committed replace must report success")
	}
	if len(held) != 2 {
		t.Fatalf("held = %q, want the thin 2024 and the capped 2025", held)
	}
	if rows != 5782 || status != "ok" || !strings.Contains(detail, "prune held back") || !strings.Contains(detail, "2024:") {
		t.Fatalf("recorded %d/%q/%q, want the committed rows, ok, and the held years in detail", rows, status, detail)
	}

	// A clean replace records no detail and reports nothing held.
	io.replaceObservations = func(context.Context, []Observation, replaceScope) (replaceResult, error) {
		return replaceResult{Upserted: 5782, Pruned: 169}, nil
	}
	job.replace = func() *replaceScope { return &replaceScope{Years: []int{2025}} }
	if ok, held := runOfficialJobOutcome(context.Background(), job, io); !ok || len(held) != 0 || detail != "" {
		t.Fatalf("clean replace = %v/%q/detail %q, want ok, none held, empty detail", ok, held, detail)
	}
}
