package shortdatasync

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"
)

func rowsFor(codes ...string) []shortsRow {
	out := make([]shortsRow, 0, len(codes))
	for _, c := range codes {
		out = append(out, shortsRow{ProductCode: c})
	}
	return out
}

// TestChangeSetNamesWhatWasWritten: codes are trimmed, upper-cased and
// deduplicated across dates, and both lists come back sorted.
func TestChangeSetNamesWhatWasWritten(t *testing.T) {
	c := &changeSet{}
	c.add(utcDay(2026, time.November, 3), rowsFor("CBA", " bhp", "WBT "))
	c.add(utcDay(2026, time.October, 28), rowsFor("BHP"))
	codes, dates, reason := c.narrow()
	if reason != "" {
		t.Fatalf("a routine set is narrow, got %q", reason)
	}
	if !slices.Equal(codes, []string{"BHP", "CBA", "WBT"}) {
		t.Fatalf("codes = %v", codes)
	}
	if !slices.Equal(dates, []string{"2026-10-28", "2026-11-03"}) {
		t.Fatalf("dates = %v", dates)
	}
}

// TestChangeSetGoesBroadWhenItCannotName: no set, an empty set, a broad mark
// and either ceiling all fall back to the broad contract.
func TestChangeSetGoesBroadWhenItCannotName(t *testing.T) {
	var none *changeSet
	if _, _, reason := none.narrow(); reason == "" {
		t.Fatal("a nil set must be broad")
	}
	none.add(utcDay(2026, time.November, 3), rowsFor("BHP")) // nil-safe
	none.markBroad()

	if _, _, reason := (&changeSet{}).narrow(); reason == "" {
		t.Fatal("an empty set must be broad")
	}

	marked := &changeSet{}
	marked.add(utcDay(2026, time.November, 3), rowsFor("BHP"))
	marked.markBroad()
	if _, _, reason := marked.narrow(); reason == "" {
		t.Fatal("a set marked broad must be broad")
	}

	many := &changeSet{}
	codes := make([]string, maxNarrowCodes+1)
	for i := range codes {
		codes[i] = fmt.Sprintf("C%d", i)
	}
	many.add(utcDay(2026, time.November, 3), rowsFor(codes...))
	if _, _, reason := many.narrow(); reason == "" {
		t.Fatal("more codes than the ceiling must be broad")
	}

	long := &changeSet{}
	for i := 0; i <= maxNarrowDates; i++ {
		long.add(utcDay(2026, time.January, 1).AddDate(0, 0, i), rowsFor("BHP"))
	}
	if _, _, reason := long.narrow(); reason == "" {
		t.Fatal("more dates than the ceiling must be broad")
	}
}

// TestChangeSetMergeCarriesBroad: the reconcile pass's set folds into the
// forward window's, including a broad mark.
func TestChangeSetMergeCarriesBroad(t *testing.T) {
	forward := &changeSet{}
	forward.add(utcDay(2026, time.November, 3), rowsFor("BHP"))
	var reconciled changeSet
	reconciled.add(utcDay(2026, time.October, 28), rowsFor("CBA"))
	forward.merge(reconciled)
	codes, dates, reason := forward.narrow()
	if reason != "" || !slices.Equal(codes, []string{"BHP", "CBA"}) || !slices.Equal(dates, []string{"2026-10-28", "2026-11-03"}) {
		t.Fatalf("merged = %v %v %q", codes, dates, reason)
	}

	empty := &changeSet{}
	empty.merge(changeSet{broad: true})
	if _, _, reason := empty.narrow(); reason == "" {
		t.Fatal("a merged broad mark must make the run broad")
	}
}

// TestForwardWindowRecordsItsWrites: every file that wrote rows adds its date
// and codes; a dry run records nothing.
func TestForwardWindowRecordsItsWrites(t *testing.T) {
	changes := &changeSet{}
	if _, err := processFiles(context.Background(), config{}, &pgStore{db: loadedDB([]string{"BHP", "CBA"})}, csvClient(asicCSV("BHP", "CBA")),
		files(20260203), time.Time{}, nil, modeDaily, changes); err != nil {
		t.Fatalf("processFiles: %v", err)
	}
	codes, dates, reason := changes.narrow()
	if reason != "" || !slices.Equal(codes, []string{"BHP", "CBA"}) || !slices.Equal(dates, []string{"2026-02-03"}) {
		t.Fatalf("recorded %v %v %q", codes, dates, reason)
	}

	dry := &changeSet{}
	if _, err := processFiles(context.Background(), config{dryRun: true}, &pgStore{db: loadedDB(nil)}, csvClient(asicCSV("BHP")),
		files(20260203), time.Time{}, nil, modeDaily, dry); err != nil {
		t.Fatalf("processFiles: %v", err)
	}
	if len(dry.codes) != 0 {
		t.Fatalf("a dry run writes nothing, so records nothing: %v", dry.codes)
	}
}

// TestReconcileRecordsOnlyWhatItWrote: a corrected date names the rows the pass
// wrote (the missing CBA), not the rows the table already held (BHP), and a
// clean date names nothing.
func TestReconcileRecordsOnlyWhatItWrote(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2026-02-03", "BHP")
	store.holds("2026-02-04", "BHP")
	bodies := map[int][]byte{20260203: asicCSV("BHP", "CBA"), 20260204: asicCSV("BHP")}
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(bodies, nil), files(20260203, 20260204), false)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	codes, dates, reason := rep.changed.narrow()
	if reason != "" || !slices.Equal(codes, []string{"CBA"}) || !slices.Equal(dates, []string{"2026-02-03"}) {
		t.Fatalf("recorded %v %v %q", codes, dates, reason)
	}

	dryStore := newFakeReconcileStore()
	dryStore.holds("2026-02-03", "BHP")
	dryRep, err := reconcileFiles(context.Background(), dryStore, fetchFrom(map[int][]byte{20260203: asicCSV("BHP", "CBA")}, nil), files(20260203), true)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if len(dryRep.changed.codes) != 0 {
		t.Fatalf("a dry pass writes nothing, so records nothing: %v", dryRep.changed.codes)
	}
}
