package shortdatasync

// capture_test.go covers the forward point-in-time capture (architecture 9.1, 000154): one
// asic_report_ingests row per file the writer examines, a recount of loaded_rows after every
// write, and a shorts_revisions row per value ASIC changed. The completeness facts these feed
// (4.6, R23) are what the strategy engine reads, so each test states the fact it protects.
// The SQL side (first_ingested_at and mode kept on conflict, the recount itself) is pinned by
// strategy_capture_pg_test.go against a live Postgres.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// lastIngest returns the most recent ingest the fake recorded for a date.
func lastIngest(t *testing.T, store *fakeReconcileStore, date string) fakeIngest {
	t.Helper()
	for i := len(store.ingests) - 1; i >= 0; i-- {
		if store.ingests[i].Date == date {
			return store.ingests[i]
		}
	}
	t.Fatalf("no ingest recorded for %s; ingests=%+v", date, store.ingests)
	return fakeIngest{}
}

// TestReconcileRecordsOneIngestPerFileExamined: every file the pass examines and can check gets
// exactly one ingest row, clean or diverged, tagged as a reconcile load.
func TestReconcileRecordsOneIngestPerFileExamined(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2026-02-03", "BHP", "CBA") // clean
	store.holds("2026-02-04", "BHP")        // diverged: CBA missing
	bodies := map[int][]byte{
		20260203: asicCSV("BHP", "CBA"),
		20260204: asicCSV("BHP", "CBA"),
		20260205: asicCSV("BHP"), // nothing held: missing
	}
	if _, err := reconcileFiles(context.Background(), store, fetchFrom(bodies, nil), files(20260203, 20260204, 20260205), false); err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if len(store.ingests) != 3 {
		t.Fatalf("one ingest per examined file, got %d: %+v", len(store.ingests), store.ingests)
	}
	seen := map[string]bool{}
	for _, in := range store.ingests {
		if in.Mode != modeReconcile {
			t.Fatalf("a reconcile load must be recorded as %q, got %q", modeReconcile, in.Mode)
		}
		seen[in.Date] = true
	}
	if len(seen) != 3 {
		t.Fatalf("each date gets one ingest row, got dates %v", seen)
	}
}

// TestCleanReconcileOfCompleteReportLeavesItComplete: a report the table already holds in full
// writes nothing, and its recounted ingest is complete.
func TestCleanReconcileOfCompleteReportLeavesItComplete(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2026-02-03", "BHP", "CBA")
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20260203: asicCSV("BHP", "CBA")}, nil), files(20260203), false)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if len(store.upserts) != 0 || len(store.revisions) != 0 || rep.Clean != 1 {
		t.Fatalf("a clean reconcile writes no shorts row and no revision: upserts=%v revisions=%v rep=%+v", store.written(), store.revisions, rep)
	}
	in := lastIngest(t, store, "2026-02-03")
	if in.Loaded < in.FileRows || in.FileRows != 2 {
		t.Fatalf("a complete report must stay complete (loaded >= file rows): %+v", in)
	}
}

// TestReconcileRepairsAFailedDailyLoadToComplete: a daily load that wrote one of three rows is
// incomplete. Once reconcile writes the rest, the recounted ingest is complete.
func TestReconcileRepairsAFailedDailyLoadToComplete(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2026-02-03", "BHP") // the daily load's partial result
	body := asicCSV("BHP", "CBA", "PLS")
	if _, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20260203: body}, nil), files(20260203), false); err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	in := lastIngest(t, store, "2026-02-03")
	if in.FileRows != 3 || in.Loaded != 3 {
		t.Fatalf("a repaired report must recount to complete (loaded 3 of 3): %+v", in)
	}
}

// TestRevisedReportStaysComplete: ASIC changes a value on a report the table holds in full. The
// revised row is updated in place, so the report stays complete, and the old value is kept as a
// revision.
func TestRevisedReportStaysComplete(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2025-08-11", "BHP", "BPT")
	store.put("2025-08-11", storedRow{Code: "BPT", Short: new(float64(999)), Issue: new(float64(1000000)), Pct: new(0.0999)})
	body := asicCSV("BHP", "BPT")
	if _, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20250811: body}, nil), files(20250811), false); err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	in := lastIngest(t, store, "2025-08-11")
	if in.Loaded != in.FileRows || in.FileRows != 2 {
		t.Fatalf("a revised report stays complete: %+v", in)
	}
}

// TestRevisionRowsOnlyForChangedValues: a revision is written for each row whose stored values
// ASIC changed, carrying the stored values beside the file's. A missing row is a repair, not a
// revision, and an identical row writes nothing.
func TestRevisionRowsOnlyForChangedValues(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2025-08-11", "BHP") // identical to the file
	store.put("2025-08-11", storedRow{Code: "BPT", Short: new(float64(999)), Issue: new(float64(1000000)), Pct: new(0.0999)})
	// WBT is not held: a missing row, not a revision.
	body := asicCSV("BHP", "BPT", "WBT")
	if _, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20250811: body}, nil), files(20250811), false); err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if len(store.revisions) != 1 {
		t.Fatalf("one revision for the one changed row, got %+v", store.revisions)
	}
	rev := store.revisions[0]
	_, wantIssue, wantPct := fileRow(1) // BPT is the second code in asicCSV
	wantShort, _, _ := fileRow(1)
	if rev.Code != "BPT" || rev.OldPositions == nil || *rev.OldPositions != 999 || rev.NewPositions != wantShort {
		t.Fatalf("the revision must hold the stored and the file's positions: %+v", rev)
	}
	if rev.OldPercent == nil || *rev.OldPercent != 0.0999 || rev.NewPercent != wantPct {
		t.Fatalf("the revision must hold the stored and the file's percent: %+v", rev)
	}
	if rev.OldShares == nil || *rev.OldShares != 1000000 || rev.NewShares != wantIssue {
		t.Fatalf("the revision must hold the stored and the file's shares: %+v", rev)
	}
	if rev.Date.Format("2006-01-02") != "2025-08-11" {
		t.Fatalf("the revision is dated to the report: %+v", rev)
	}
}

// TestRevisionOfANullStoredValueIsARepair: a stored NULL is a difference the table must be
// corrected for, so it is a revision with a NULL old value.
func TestRevisionOfANullStoredValueIsARepair(t *testing.T) {
	store := newFakeReconcileStore()
	store.put("2026-02-03", storedRow{Code: "BHP", Short: nil, Issue: new(float64(1000000)), Pct: nil})
	if _, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20260203: asicCSV("BHP")}, nil), files(20260203), false); err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if len(store.revisions) != 1 || store.revisions[0].OldPositions != nil || store.revisions[0].OldPercent != nil {
		t.Fatalf("a NULL stored value is recorded as a NULL old value: %+v", store.revisions)
	}
}

// TestDryRunRecordsNoIngestAndNoRevision: a dry run writes nothing, so it records neither a
// report's ingest nor a revision.
func TestDryRunRecordsNoIngestAndNoRevision(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2025-08-11", "BHP")
	store.put("2025-08-11", storedRow{Code: "BPT", Short: new(float64(999)), Issue: new(float64(1000000)), Pct: new(0.0999)})
	if _, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20250811: asicCSV("BHP", "BPT", "WBT")}, nil), files(20250811), true); err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if len(store.ingests) != 0 || len(store.revisions) != 0 {
		t.Fatalf("a dry run records no ingest (%+v) and no revision (%+v)", store.ingests, store.revisions)
	}
}

// TestIngestFailureDoesNotFailReconcile: the ingest log is observational. A missing table must
// not fail a pass whose rows landed, nor be reported as a failed file.
func TestIngestFailureDoesNotFailReconcile(t *testing.T) {
	store := newFakeReconcileStore()
	store.ingestErr = errors.New("relation asic_report_ingests does not exist") // as before 000154
	store.holds("2026-02-03", "BHP")
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20260203: asicCSV("BHP", "CBA")}, nil), files(20260203), false)
	if err != nil {
		t.Fatalf("an ingest error must not fail the pass: %v", err)
	}
	if rep.RowsWritten != 1 || len(rep.Failed) != 0 {
		t.Fatalf("the rows still land and the file is not failed: %+v", rep)
	}
}

// TestRecordIngestHonoursCancellation: a cancelled context stops the ingest write, without
// returning an error to the caller that would be logged as a failed ingest.
func TestRecordIngestHonoursCancellation(t *testing.T) {
	store := newFakeReconcileStore()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	recordIngest(ctx, store, "x.csv", time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC), nil, modeDaily, false)
	if len(store.ingests) != 0 {
		t.Fatalf("a cancelled ingest records nothing: %+v", store.ingests)
	}
}

// TestDailyLoadRecordsItsModeAndDistinctCodes: the daily and poll loads record their own mode, and
// file_rows counts each product code once, however many times the file lists it.
func TestDailyLoadRecordsItsModeAndDistinctCodes(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2026-02-03", "BHP", "CBA")
	rows := []shortsRow{
		{Date: time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC), ProductCode: "BHP"},
		{Date: time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC), ProductCode: "CBA"},
		{Date: time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC), ProductCode: "BHP"}, // a repeated code
	}
	recordIngest(context.Background(), store, "2026-02-03.csv", time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC), rows, modeDaily, false)
	recordIngest(context.Background(), store, "2026-02-03.csv", time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC), rows, modePoll, false)
	if len(store.ingests) != 2 {
		t.Fatalf("one ingest per call: %+v", store.ingests)
	}
	if store.ingests[0].Mode != modeDaily || store.ingests[1].Mode != modePoll {
		t.Fatalf("each load records its own mode: %+v", store.ingests)
	}
	if store.ingests[0].FileRows != 2 || store.ingests[0].Loaded != 2 {
		t.Fatalf("file_rows is the distinct codes, all present: %+v", store.ingests[0])
	}
}

// TestDistinctCodesKeepsFileOrder: codes come back once each, in the order the file lists them.
func TestDistinctCodesKeepsFileOrder(t *testing.T) {
	got := distinctCodes([]shortsRow{{ProductCode: "CBA"}, {ProductCode: "BHP"}, {ProductCode: "CBA"}})
	if len(got) != 2 || got[0] != "CBA" || got[1] != "BHP" {
		t.Fatalf("distinctCodes = %v", got)
	}
}

// TestRecountTrimsLikeRowsOnDate: the recount and RowsOnDate both trim with strings.TrimSpace, so
// a code padded with a tab or a non-breaking space counts as present, as a padded space does.
func TestRecountTrimsLikeRowsOnDate(t *testing.T) {
	got := countPresent(
		[]string{"BHP", "WBT", "TAB", "PLS", "WBT"},
		[]string{"BHP ", "WBT\t", "TAB ", "XYZ"},
	)
	if got != 3 {
		t.Fatalf("countPresent = %d, want 3 (BHP, WBT and TAB present; PLS absent; WBT counted once)", got)
	}
}

// TestUnparsedFileRecordsNullFileRows: a file that parsed to no codes records file_rows NULL, so
// the report's completeness is unknown rather than complete (0 >= 0).
func TestUnparsedFileRecordsNullFileRows(t *testing.T) {
	db := &fakeDB{}
	if err := (&pgStore{db: db}).RecordIngest(context.Background(), ingestRecord{
		ReportDate: time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC), SourceFile: "x.csv", Mode: modeDaily,
	}); err != nil {
		t.Fatalf("RecordIngest: %v", err)
	}
	if len(db.calls) != 1 {
		t.Fatalf("an unparsed file runs no recount, only the upsert: %+v", db.calls)
	}
	if fileRows, ok := db.calls[0].Args[1].(*int); !ok || fileRows != nil {
		t.Fatalf("file_rows must be NULL for a file with no codes, got %#v", db.calls[0].Args[1])
	}
}

// TestCaptureSQLNeverWritesShortsOrFirstObservation pins the statements' shape: the ingest upsert
// keeps first_ingested_at and the first mode, the recount is read-only, and the revision insert
// is a plain insert into its own table.
func TestCaptureSQLNeverWritesShortsOrFirstObservation(t *testing.T) {
	for _, forbidden := range []string{"first_ingested_at = EXCLUDED", "mode = EXCLUDED.mode", "UPDATE shorts"} {
		if containsSQL(upsertIngestSQL, forbidden) {
			t.Fatalf("the ingest upsert must not overwrite %q", forbidden)
		}
	}
	if !containsSQL(upsertIngestSQL, "ON CONFLICT (report_date) DO UPDATE") {
		t.Fatalf("the ingest upsert must conflict on the report date")
	}
	if containsSQL(loadedCodesSQL, "INSERT") || containsSQL(loadedCodesSQL, "UPDATE") || containsSQL(loadedCodesSQL, "DELETE") {
		t.Fatalf("the recount must be read-only")
	}
	if !containsSQL(loadedCodesSQL, "array_agg(DISTINCT \"PRODUCT_CODE\")") {
		t.Fatalf("the recount reads the distinct stored codes, trimmed in Go")
	}
	if containsSQL(insertRevisionSQL, "shorts ") && !containsSQL(insertRevisionSQL, "shorts_revisions") {
		t.Fatalf("a revision is written to shorts_revisions only")
	}
}

// containsSQL reports whether a statement contains a fragment, ignoring whitespace runs.
func containsSQL(sql, fragment string) bool {
	return strings.Contains(collapseSpace(sql), collapseSpace(fragment))
}

func collapseSpace(s string) string { return strings.Join(strings.Fields(s), " ") }
