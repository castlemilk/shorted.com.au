package shortdatasync

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
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

func manyCodes(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("C%04d", i)
	}
	return out
}

// TestNarrowRequestsAreChunked: 600 stocks go as three requests. Only the first
// carries the tag, the newest-snapshot paths and the KV flush; every chunk
// carries every date; together they name each stock once.
func TestNarrowRequestsAreChunked(t *testing.T) {
	changes := &changeSet{}
	changes.add(utcDay(2026, time.November, 3), rowsFor(manyCodes(600)...))
	changes.add(utcDay(2026, time.October, 28), rowsFor("C0001"))
	reqs := revalidateRequests(changes)
	if len(reqs) != 3 {
		t.Fatalf("600 stocks in chunks of %d = 3 requests, got %d", narrowChunkCodes, len(reqs))
	}
	var named []string
	for i, req := range reqs {
		body, ok := req.Body.(shortsChangeBody)
		if !ok {
			t.Fatalf("request %d has no change set", i+1)
		}
		if len(body.Shorts.Codes) > narrowChunkCodes {
			t.Fatalf("request %d names %d stocks", i+1, len(body.Shorts.Codes))
		}
		if !slices.Equal(body.Shorts.Dates, []string{"2026-10-28", "2026-11-03"}) {
			t.Fatalf("request %d dates = %v", i+1, body.Shorts.Dates)
		}
		named = append(named, body.Shorts.Codes...)
		if i == 0 {
			if req.Tag != "scan-results" || req.Flush != "shorts" || len(req.Paths) == 0 {
				t.Fatalf("the first request carries the tag, paths and flush: %+v", req)
			}
		} else if req.Tag != "" || req.Flush != "" || len(req.Paths) != 0 {
			t.Fatalf("request %d must carry only its stocks (one KV flush per run): %+v", i+1, req)
		}
	}
	if !slices.Equal(named, manyCodes(600)) {
		t.Fatalf("the chunks must name each stock once, in order")
	}

	small := &changeSet{}
	small.add(utcDay(2026, time.November, 3), rowsFor("BHP"))
	if got := revalidateRequests(small); len(got) != 1 || got[0].Flush != "shorts" {
		t.Fatalf("a small set is one request: %+v", got)
	}
}

// TestFailedNarrowChunkFallsBackToBroad: when any chunk is refused, the broad
// request follows and nothing after the failed chunk is sent.
func TestFailedNarrowChunkFallsBackToBroad(t *testing.T) {
	changes := &changeSet{}
	changes.add(utcDay(2026, time.November, 3), rowsFor(manyCodes(600)...))
	var sent []string
	pingRevalidation(changes, func(req platform.RevalidateRequest) bool {
		sent = append(sent, req.Reason+"|"+req.Tag)
		return !strings.HasSuffix(req.Reason, "2/3")
	})
	want := []string{
		"short-data-sync 1/3|scan-results",
		"short-data-sync 2/3|",
		"short-data-sync|shorts-data,scan-results",
	}
	if !slices.Equal(sent, want) {
		t.Fatalf("sent %v, want %v", sent, want)
	}
}

// TestNarrowPingSendsEveryChunkWhenAllSucceed, and a broad set sends exactly
// the broad request once.
func TestNarrowPingSendsEveryChunkWhenAllSucceed(t *testing.T) {
	changes := &changeSet{}
	changes.add(utcDay(2026, time.November, 3), rowsFor(manyCodes(600)...))
	n := 0
	pingRevalidation(changes, func(req platform.RevalidateRequest) bool {
		n++
		if req.Body == nil {
			t.Fatalf("no broad request when every chunk succeeds: %+v", req)
		}
		return true
	})
	if n != 3 {
		t.Fatalf("sent %d requests, want 3", n)
	}

	var broad []platform.RevalidateRequest
	pingRevalidation(nil, func(req platform.RevalidateRequest) bool {
		broad = append(broad, req)
		return false
	})
	if len(broad) != 1 || broad[0].Tag != "shorts-data,scan-results" {
		t.Fatalf("a broad run sends the broad request once, even when it fails: %+v", broad)
	}
}
