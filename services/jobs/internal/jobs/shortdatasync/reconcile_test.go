package shortdatasync

// reconcile_test.go covers the pass that keeps the table converged on ASIC's
// current archive (reconcile.go). The failures it exists for: dates that lost
// rows, and dates ASIC corrected after they were ingested, were never offered
// to the pipeline again — reported as WBT's short data "stopping".

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const reconcileHeader = "Product,Product Code,Reported Short Positions,Total Product in Issue,% of Total Product in Issue Reported as Short Positions\r\n"

// asicCSV renders a modern ASIC daily file with one row per code; values are
// derived from the code's position so tests can predict them (see fileRow).
func asicCSV(codes ...string) []byte {
	var b strings.Builder
	b.WriteString(reconcileHeader)
	for i, c := range codes {
		s, issue, pct := fileRow(i)
		fmt.Fprintf(&b, "%s LTD ORDINARY,%s,%.0f,%.0f,%.8f\r\n", strings.TrimSpace(c), c, s, issue, pct)
	}
	return []byte(b.String())
}

// fileRow is the value asicCSV writes for the i-th code.
func fileRow(i int) (short, issue, pct float64) {
	return float64(1000 * (i + 1)), 1000000, float64(i+1) / 10
}

func ptr(f float64) *float64 { return &f }

// fakeReconcileStore is an in-memory shorts table: date → code AS STORED → row.
type fakeReconcileStore struct {
	rows    map[string]map[string]storedRow
	readErr map[string]error
	upserts [][]shortsRow
}

func newFakeReconcileStore() *fakeReconcileStore {
	return &fakeReconcileStore{rows: map[string]map[string]storedRow{}, readErr: map[string]error{}}
}

// holds stores codes with the values asicCSV would give them at the same
// positions, i.e. a row the file agrees with.
func (f *fakeReconcileStore) holds(date string, codes ...string) {
	for i, c := range codes {
		s, issue, pct := fileRow(i)
		f.put(date, storedRow{Code: c, Short: ptr(s), Issue: ptr(issue), Pct: ptr(pct)})
	}
}

func (f *fakeReconcileStore) put(date string, st storedRow) {
	if f.rows[date] == nil {
		f.rows[date] = map[string]storedRow{}
	}
	f.rows[date][st.Code] = st
}

// RowsOnDate mirrors pgStore.RowsOnDate's keying: trimmed code, exact wins.
func (f *fakeReconcileStore) RowsOnDate(ctx context.Context, d time.Time) (map[string]storedRow, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := d.Format("2006-01-02")
	if err := f.readErr[key]; err != nil {
		return nil, err
	}
	out := map[string]storedRow{}
	for _, st := range f.rows[key] {
		k := strings.TrimSpace(st.Code)
		if prev, ok := out[k]; ok && prev.Code == k {
			continue
		}
		out[k] = st
	}
	return out, nil
}

// UpsertRows mirrors the upsert: keyed on the EXACT code.
func (f *fakeReconcileStore) UpsertRows(ctx context.Context, rows []shortsRow) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	f.upserts = append(f.upserts, rows)
	for _, r := range rows {
		f.put(r.Date.Format("2006-01-02"), storedRow{
			Code: r.ProductCode, Short: ptr(r.ReportedShortPositions),
			Issue: ptr(r.TotalProductInIssue), Pct: ptr(r.Percent),
		})
	}
	return len(rows), nil
}

func (f *fakeReconcileStore) written() []string {
	var out []string
	for _, batch := range f.upserts {
		for _, r := range batch {
			out = append(out, r.Date.Format("2006-01-02")+"|"+r.ProductCode)
		}
	}
	return out
}

// fetchFrom serves file bodies by observation date (yyyymmdd).
func fetchFrom(bodies map[int][]byte, errs map[int]error) fetchFunc {
	return func(ctx context.Context, f asicFile) ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := errs[f.Date]; err != nil {
			return nil, err
		}
		b, ok := bodies[f.Date]
		if !ok {
			return nil, errors.New("status 404")
		}
		return b, nil
	}
}

func files(dates ...int) []asicFile {
	out := make([]asicFile, 0, len(dates))
	for _, d := range dates {
		out = append(out, asicFile{Date: d, Version: "001"})
	}
	return out
}

func utcDay(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

func dates(fs []asicFile) []int {
	out := make([]int, 0, len(fs))
	for _, f := range fs {
		out = append(out, f.Date)
	}
	return out
}

// --- which dates a run checks ----------------------------------------------

// TestReconcileSelectionStopsAtTheStartingMaxDate is the split between the two
// passes: dates AFTER the MAX("DATE") a run started with belong to the forward
// window, so the reconcile pass never reports (or writes) them twice.
func TestReconcileSelectionStopsAtTheStartingMaxDate(t *testing.T) {
	index := files(20260921, 20260918, 20260917, 20260916, 20260915) // newest first, as served
	got, _ := reconcileSelection(index, config{reconcileDays: 3}, utcDay(2026, 9, 18), utcDay(2026, 9, 26))
	if fmt.Sprint(dates(got)) != "[20260916 20260917 20260918]" {
		t.Fatalf("window = %v, want the last 3 published dates up to the starting MAX, oldest first", dates(got))
	}
}

// TestReconcileSelectionCountsPublishedDates: N counts dates ASIC published, so
// a holiday or an ASIC outage never shrinks the window.
func TestReconcileSelectionCountsPublishedDates(t *testing.T) {
	index := files(20260105, 20251231, 20251224, 20251223)
	got, _ := reconcileSelection(index, config{reconcileDays: 3}, utcDay(2026, 1, 5), utcDay(2026, 1, 9))
	if fmt.Sprint(dates(got)) != "[20251224 20251231 20260105]" {
		t.Fatalf("window = %v", dates(got))
	}
}

// TestCurrentFilesTakesTheNewestVersionOnce: a republished date is checked once,
// against the version ASIC currently publishes.
func TestCurrentFilesTakesTheNewestVersionOnce(t *testing.T) {
	index := []asicFile{
		{Date: 20250811, Version: "001"},
		{Date: 20250811, Version: "002"},
		{Date: 20250808, Version: "010"},
	}
	got := currentFiles(index, utcDay(2025, 8, 11))
	if len(got) != 2 || got[1].Version != "002" || got[0].Version != "010" {
		t.Fatalf("current files = %+v, want one per date at its newest version", got)
	}
}

// longIndex is n consecutive published dates, newest first as ASIC serves them.
func longIndex(n int) ([]asicFile, time.Time) {
	start := utcDay(2010, 6, 16)
	var out []asicFile
	for i := 0; i < n; i++ {
		out = append([]asicFile{{Date: yyyymmdd(start.AddDate(0, 0, i)), Version: "001"}}, out...)
	}
	return out, start.AddDate(0, 0, n-1)
}

// TestReconcileRotationCoversTheWholeArchive is the guarantee the rotation
// exists for: over any K consecutive days, every published date is checked
// exactly once, at ~1/K of the archive a day. This is what heals damage older
// than the recent window and republications of old dates without any state.
func TestReconcileRotationCoversTheWholeArchive(t *testing.T) {
	index, upTo := longIndex(4116)
	const k = 28
	seen := map[int]int{}
	for day := 0; day < k; day++ {
		got, _ := reconcileSelection(index, config{reconcileRotation: k}, upTo, utcDay(2026, 9, 26).AddDate(0, 0, day))
		if n := len(got); n < 4116/k || n > 4116/k+1 {
			t.Fatalf("day %d checked %d dates, want ~%d", day, n, 4116/k)
		}
		for _, f := range got {
			seen[f.Date]++
		}
	}
	if len(seen) != 4116 {
		t.Fatalf("%d of 4116 dates checked over %d days — the rotation must cover the whole archive", len(seen), k)
	}
	for d, n := range seen {
		if n != 1 {
			t.Fatalf("date %d checked %d times in one rotation, want exactly once", d, n)
		}
	}
}

// TestReconcileRotationSlotIsStableAsDatesAppend: a new date appends to the
// end, so every older date keeps its day in the rotation.
func TestReconcileRotationSlotIsStableAsDatesAppend(t *testing.T) {
	index, upTo := longIndex(500)
	today := utcDay(2026, 9, 26)
	before, _ := reconcileSelection(index, config{reconcileRotation: 28}, upTo, today)
	grown := append([]asicFile{{Date: yyyymmdd(upTo.AddDate(0, 0, 1)), Version: "001"}}, index...)
	after, _ := reconcileSelection(grown, config{reconcileRotation: 28}, upTo.AddDate(0, 0, 1), today)
	b := fmt.Sprint(dates(before))
	a := fmt.Sprint(dates(after))
	if !strings.HasPrefix(strings.TrimSuffix(a, "]"), strings.TrimSuffix(b, "]")) {
		t.Fatalf("appending a date moved existing dates between slots:\nbefore %s\nafter  %s", b, a)
	}
}

// TestReconcileSelectionUnionsRecentAndRotation: the recent window is always
// covered in full, whatever the rotation slot.
func TestReconcileSelectionUnionsRecentAndRotation(t *testing.T) {
	index, upTo := longIndex(200)
	got, desc := reconcileSelection(index, config{reconcileDays: 20, reconcileRotation: 28}, upTo, utcDay(2026, 9, 26))
	set := map[int]bool{}
	for _, d := range dates(got) {
		set[d] = true
	}
	for _, f := range currentFiles(index, upTo)[180:] {
		if !set[f.Date] {
			t.Fatalf("recent date %d missing from the window", f.Date)
		}
	}
	if len(got) < 20+200/28-1 || !strings.Contains(desc, "rotation slice") {
		t.Fatalf("window of %d (%s) must add the rotation slice to the recent 20", len(got), desc)
	}
}

// TestReconcileRangeReplacesTheRollingWindows is the one-off repair of history:
// exactly the published dates in range, clamped at the starting MAX("DATE").
func TestReconcileRangeReplacesTheRollingWindows(t *testing.T) {
	index := files(20260921, 20260918, 20211105, 20211104, 20211103, 20100616)
	cfg := config{reconcileDays: 20, reconcileRotation: 28, reconcileFrom: utcDay(2021, 11, 4)}
	got, desc := reconcileSelection(index, cfg, utcDay(2026, 9, 18), utcDay(2026, 9, 26))
	if fmt.Sprint(dates(got)) != "[20211104 20211105 20260918]" {
		t.Fatalf("range = %v (%s), want every date from 2021-11-04 up to the starting MAX", dates(got), desc)
	}
	cfg.reconcileTo = utcDay(2021, 11, 4)
	got, _ = reconcileSelection(index, cfg, utcDay(2026, 9, 18), utcDay(2026, 9, 26))
	if fmt.Sprint(dates(got)) != "[20211104]" {
		t.Fatalf("bounded range = %v, want only 2021-11-04", dates(got))
	}
}

// --- what counts as a difference -------------------------------------------

func TestDiffDateClassifiesEveryCase(t *testing.T) {
	d0 := utcDay(2025, 8, 11)
	file := []shortsRow{
		{Date: d0, ProductCode: "AAA", ReportedShortPositions: 10, TotalProductInIssue: 100, Percent: 10},                     // missing
		{Date: d0, ProductCode: "BPT", ReportedShortPositions: 72962562, TotalProductInIssue: 2281333656, Percent: 3.1982416}, // corrected by ASIC
		{Date: d0, ProductCode: "ULP", ReportedShortPositions: 1, TotalProductInIssue: 3, Percent: 33.33333333},               // one ULP away
		{Date: d0, ProductCode: "NUL", ReportedShortPositions: 5, TotalProductInIssue: 50, Percent: 10},                       // stored NULL
		{Date: d0, ProductCode: "NAN", ReportedShortPositions: 5, TotalProductInIssue: 50, Percent: 10},                       // stored NaN
		{Date: d0, ProductCode: "WBT", ReportedShortPositions: 7, TotalProductInIssue: 70, Percent: 10},                       // stored padded, differs
		{Date: d0, ProductCode: "SAM", ReportedShortPositions: 1, TotalProductInIssue: 2, Percent: 50},                        // identical
	}
	have := map[string]storedRow{
		"BPT": {Code: "BPT", Short: ptr(119385515), Issue: ptr(2281333656), Pct: ptr(5.23314574)},
		"ULP": {Code: "ULP", Short: ptr(1), Issue: ptr(3), Pct: ptr(math.Nextafter(33.33333333, 100))},
		"NUL": {Code: "NUL", Short: ptr(5), Issue: ptr(50), Pct: nil},
		"NAN": {Code: "NAN", Short: ptr(5), Issue: ptr(50), Pct: ptr(math.NaN())},
		"WBT": {Code: "WBT ", Short: ptr(8), Issue: ptr(70), Pct: ptr(11.4)},
		"SAM": {Code: "SAM", Short: ptr(1), Issue: ptr(2), Pct: ptr(50)},
		"OLD": {Code: "OLD", Short: ptr(1), Issue: ptr(2), Pct: ptr(50)}, // not in the current file
		// Listed by the file with a "-" percentage (total in issue 0), which
		// parseFileListing drops from the rows but keeps in the listing.
		"SP1": {Code: "SP1", Short: ptr(1473939), Issue: ptr(0), Pct: nil},
	}
	listed := map[string]struct{}{"SP1": {}}
	for _, r := range file {
		listed[r.ProductCode] = struct{}{}
	}
	d := diffDate(file, listed, have)
	codes := func(rs []shortsRow) string {
		var s []string
		for _, r := range rs {
			s = append(s, r.ProductCode)
		}
		return strings.Join(s, ",")
	}
	if got := codes(d.missing); got != "AAA" {
		t.Fatalf("missing = %s, want AAA", got)
	}
	if got := codes(d.changed); got != "BPT,NUL,NAN" {
		t.Fatalf("changed = %s, want BPT (ASIC's correction), NUL and NAN (unreadable), and NOT the ULP", got)
	}
	if d.changed[0].ReportedShortPositions != 72962562 || d.changed[0].Percent != 3.1982416 {
		t.Fatalf("a changed row must carry the FILE's values: %+v", d.changed[0])
	}
	if d.padded != 1 || len(d.extra) != 1 || d.extra[0].Code != "OLD" || *d.extra[0].Short != 1 {
		t.Fatalf("padded = %d, extra = %+v; want 1, and OLD with the values the table holds", d.padded, d.extra)
	}
}

// --- the repair -------------------------------------------------------------

// TestReconcileWritesMissingAndChangedRows is the production audit in
// miniature: a date holding half its rows (Feb 2026), a date holding none
// (2026-04-09), a date ASIC corrected after ingest (2025-08-11), and a
// complete date that must not be rewritten.
func TestReconcileWritesMissingAndChangedRows(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2026-02-03", "BHP", "CBA")               // partial: PLS, WBT missing
	store.holds("2026-02-04", "BHP", "CBA", "PLS", "WBT") // complete
	store.holds("2025-08-11", "BHP", "BPT")               // BPT then corrected below
	store.put("2025-08-11", storedRow{Code: "BPT", Short: ptr(999), Issue: ptr(1000000), Pct: ptr(0.0999)})
	// 2026-04-09: nothing at all.

	bodies := map[int][]byte{
		20250811: asicCSV("BHP", "BPT"),
		20260203: asicCSV("BHP", "CBA", "PLS", "WBT"),
		20260204: asicCSV("BHP", "CBA", "PLS", "WBT"),
		20260409: asicCSV("BHP", "WBT"),
	}
	window := files(20250811, 20260203, 20260204, 20260409)
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(bodies, nil), window, false)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}

	got := strings.Join(store.written(), ",")
	want := "2025-08-11|BPT,2026-02-03|PLS,2026-02-03|WBT,2026-04-09|BHP,2026-04-09|WBT"
	if got != want {
		t.Fatalf("wrote %s\nwant  %s", got, want)
	}
	if rep.Files != 4 || rep.Clean != 1 || rep.Diverged != 3 || rep.RowsMissing != 4 || rep.RowsChanged != 1 || rep.RowsWritten != 5 {
		t.Fatalf("report = %+v", rep)
	}

	// Second pass: the table now matches, so a healthy table sees no writes.
	before := len(store.upserts)
	rep, err = reconcileFiles(context.Background(), store, fetchFrom(bodies, nil), window, false)
	if err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if len(store.upserts) != before || rep.Clean != 4 || rep.Diverged != 0 {
		t.Fatalf("a repaired window must reconcile to zero writes: %+v", rep)
	}
}

// TestReconcileAppliesAsicCorrection is the republication case with the real
// numbers: the table held version 001, ASIC now publishes 002.
func TestReconcileAppliesAsicCorrection(t *testing.T) {
	store := newFakeReconcileStore()
	store.put("2025-08-11", storedRow{Code: "BPT", Short: ptr(119385515), Issue: ptr(2281333656), Pct: ptr(5.23314574)})
	v002 := []byte(reconcileHeader + "BEACH ENERGY LIMITED ORDINARY,BPT,72962562,2281333656,3.1982416\r\n")
	window := []asicFile{{Date: 20250811, Version: "002"}}
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20250811: v002}, nil), window, false)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	st := store.rows["2025-08-11"]["BPT"]
	if rep.RowsChanged != 1 || *st.Short != 72962562 || *st.Pct != 3.1982416 {
		t.Fatalf("the table must now hold ASIC's corrected figure: %+v / short=%v pct=%v", rep, *st.Short, *st.Pct)
	}
}

// TestReconcileMissingRowsKeepTheFileValues: a repaired row is the ASIC row,
// byte for byte — the same parse the sync uses, not a reconstruction.
func TestReconcileMissingRowsKeepTheFileValues(t *testing.T) {
	store := newFakeReconcileStore()
	body := []byte(reconcileHeader + "WEEBIT NANO LTD ORDINARY,WBT,4014060,210455709,1.90731818\r\n")
	if _, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20260203: body}, nil), files(20260203), false); err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if len(store.upserts) != 1 || len(store.upserts[0]) != 1 {
		t.Fatalf("upserts = %+v", store.upserts)
	}
	want := shortsRow{
		Date:                   utcDay(2026, 2, 3),
		Product:                "WEEBIT NANO LTD ORDINARY",
		ProductCode:            "WBT",
		ReportedShortPositions: 4014060,
		TotalProductInIssue:    210455709,
		Percent:                1.90731818,
	}
	if got := store.upserts[0][0]; got != want {
		t.Fatalf("row = %+v\nwant  %+v", got, want)
	}
}

// TestReconcileNeverDuplicatesAPaddedCode: pre-2023 files padded some codes
// ("WBT "). A padded row counts as present, and even when its values differ it
// is left alone — upserting the trimmed code would add a second row.
func TestReconcileNeverDuplicatesAPaddedCode(t *testing.T) {
	store := newFakeReconcileStore()
	store.put("2021-11-04", storedRow{Code: "WBT ", Short: ptr(1000), Issue: ptr(1000000), Pct: ptr(0.1)})
	store.put("2021-11-05", storedRow{Code: "WBT ", Short: ptr(1), Issue: ptr(2), Pct: ptr(50)})
	bodies := map[int][]byte{20211104: asicCSV("WBT "), 20211105: asicCSV("WBT ")}
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(bodies, nil), files(20211104, 20211105), false)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if len(store.upserts) != 0 {
		t.Fatalf("a padded code must never be rewritten under its trimmed form, wrote %v", store.written())
	}
	if rep.Clean != 2 || rep.RowsPadded != 1 {
		t.Fatalf("report = %+v, want both dates clean and one padded difference reported", rep)
	}
}

// TestReconcileKeepsRowsTheFileListsWithoutAPercentage: the seven "extra" rows
// the 2026-09-26 full-archive preview reported were all like SP1 here. ASIC's
// current file still carries them, with total in issue 0 and "-" as the
// percentage; the parser drops that record, and the pass counted the stored
// row as one ASIC no longer publishes. Only a code the file does not list at
// all is extra.
func TestReconcileKeepsRowsTheFileListsWithoutAPercentage(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2023-02-06", "BHP")
	store.put("2023-02-06", storedRow{Code: "SP1", Short: ptr(1473939), Issue: ptr(0), Pct: nil})
	store.put("2023-02-06", storedRow{Code: "OLD", Short: ptr(1), Issue: ptr(2), Pct: ptr(50)})
	body := append(asicCSV("BHP"), []byte("SOUTHERN X PAYMENTS ORDINARY,SP1,1473939,0,-\r\n")...)

	rep, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20230206: body}, nil), files(20230206), false)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if rep.RowsExtra != 1 || rep.Clean != 1 || len(store.upserts) != 0 {
		t.Fatalf("report = %+v, writes = %v; want OLD alone extra, nothing written", rep, store.written())
	}
	if len(rep.Dates) != 1 || len(rep.Dates[0].ExtraRows) != 1 || rep.Dates[0].ExtraRows[0].Code != "OLD" {
		t.Fatalf("dates = %+v, want only OLD named", rep.Dates)
	}
}

// TestReconcileNeverDeletes: rows ASIC's current file no longer carries are
// counted and left in place. The store interface has no delete at all; this
// pins that the count reaches the report.
func TestReconcileNeverDeletes(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2025-08-19", "BHP", "OLD")
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20250819: asicCSV("BHP")}, nil), files(20250819), false)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if rep.RowsExtra != 1 || rep.Clean != 1 || len(store.rows["2025-08-19"]) != 2 {
		t.Fatalf("report = %+v, rows = %v", rep, store.rows["2025-08-19"])
	}
}

func TestReconcileDryRunWritesNothing(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2026-02-03", "BHP")
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20260203: asicCSV("BHP", "WBT")}, nil), files(20260203), true)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if len(store.upserts) != 0 {
		t.Fatalf("a dry run wrote %v", store.written())
	}
	if rep.Diverged != 1 || rep.RowsMissing != 1 || rep.RowsWritten != 0 {
		t.Fatalf("a dry run must still report what it would write: %+v", rep)
	}
}

// TestReconcileSkipsFilesItCannotCheck: one bad file must not cost the rest of
// the window, and must never fail the run — a later run retries it.
func TestReconcileSkipsFilesItCannotCheck(t *testing.T) {
	store := newFakeReconcileStore()
	store.readErr["2026-02-05"] = errors.New("pooler hiccup")
	bodies := map[int][]byte{
		20260203: []byte("<!DOCTYPE html><html>not a csv</html>\r\n"), // ASIC served HTML for 2015-03-17
		20260205: asicCSV("BHP"),
		20260206: asicCSV("BHP"),
	}
	errs := map[int]error{20260204: errors.New("status 503")}
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(bodies, errs), files(20260203, 20260204, 20260205, 20260206), false)
	if err != nil {
		t.Fatalf("a bad file must not fail the pass: %v", err)
	}
	if len(rep.Failed) != 3 {
		t.Fatalf("failed = %v, want the parse, download and read failures", rep.Failed)
	}
	if got := strings.Join(store.written(), ","); got != "2026-02-06|BHP" {
		t.Fatalf("the good file must still be repaired, wrote %s", got)
	}
}

func TestReconcileStopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store := newFakeReconcileStore()
	_, err := reconcileFiles(ctx, store, fetchFrom(map[int][]byte{20260203: asicCSV("BHP")}, nil), files(20260203), false)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(store.upserts) != 0 {
		t.Fatalf("a cancelled pass wrote %v", store.written())
	}
}

// --- the store read ---------------------------------------------------------

// scriptedRows is a minimal pgx.Rows over fixed values (code, short, issue, pct).
type scriptedRows struct {
	vals [][]any
	i    int
}

func (r *scriptedRows) Close()                                       {}
func (r *scriptedRows) Err() error                                   { return nil }
func (r *scriptedRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *scriptedRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *scriptedRows) Next() bool                                   { r.i++; return r.i <= len(r.vals) }
func (r *scriptedRows) Values() ([]any, error)                       { return r.vals[r.i-1], nil }
func (r *scriptedRows) RawValues() [][]byte                          { return nil }
func (r *scriptedRows) Conn() *pgx.Conn                              { return nil }
func (r *scriptedRows) Scan(dest ...any) error {
	row := r.vals[r.i-1]
	*dest[0].(*string) = row[0].(string)
	for j := 1; j < 4; j++ {
		v, _ := row[j].(*float64)
		*dest[j].(**float64) = v
	}
	return nil
}

type queryDB struct {
	fakeDB
	rows    [][]any
	lastSQL string
	args    []any
}

func (q *queryDB) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	q.lastSQL, q.args = sql, args
	return &scriptedRows{vals: q.rows}, nil
}

// TestRowsOnDateTrimsAndPrefersTheExactCode: keys are trimmed like parseFile's
// codes, NULLs survive as nil, and when a date holds "WBT " and "WBT" the exact
// row — the one an upsert touches — is the one compared.
func TestRowsOnDateTrimsAndPrefersTheExactCode(t *testing.T) {
	db := &queryDB{rows: [][]any{
		{"WBT ", ptr(1), ptr(2), ptr(3)},
		{"WBT", ptr(4), ptr(5), ptr(6)},
		{"1PG ", ptr(7), ptr(8), (*float64)(nil)},
	}}
	got, err := (&pgStore{db: db}).RowsOnDate(context.Background(), time.Date(2021, 11, 4, 13, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("RowsOnDate: %v", err)
	}
	if got["WBT"].Code != "WBT" || *got["WBT"].Short != 4 {
		t.Fatalf("the exact code must win: %+v", got["WBT"])
	}
	if got["1PG"].Code != "1PG " || got["1PG"].Pct != nil {
		t.Fatalf("padded row must be keyed trimmed and keep its NULL: %+v", got["1PG"])
	}
	from, to := db.args[0].(time.Time), db.args[1].(time.Time)
	if from != utcDay(2021, 11, 4) || to != utcDay(2021, 11, 5) {
		t.Fatalf("range = %s → %s, want the whole observation day", from, to)
	}
	if !strings.Contains(db.lastSQL, `"DATE" >= $1 AND "DATE" < $2`) {
		t.Fatalf("RowsOnDate must select a half-open day range:\n%s", db.lastSQL)
	}
}

// --- the flags --------------------------------------------------------------

func TestReconcileFlagsDefaultsAndEnv(t *testing.T) {
	cfg, err := parseConfig(context.Background(), nil)
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.reconcileDays != defaultReconcileDays || cfg.reconcileRotation != defaultReconcileRotation || !cfg.reconcileFrom.IsZero() {
		t.Fatalf("defaults = %+v — both windows must be ON by default and no range set", cfg)
	}

	t.Setenv("SYNC_RECONCILE_DAYS", "250")
	t.Setenv("SYNC_RECONCILE_ROTATION", "14")
	cfg, err = parseConfig(context.Background(), nil)
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.reconcileDays != 250 || cfg.reconcileRotation != 14 {
		t.Fatalf("env not honoured: days=%d rotation=%d", cfg.reconcileDays, cfg.reconcileRotation)
	}

	cfg, err = parseConfig(context.Background(), []string{"-reconcile-days", "0", "-reconcile-rotation", "0"})
	if err != nil || cfg.reconcileDays != 0 || cfg.reconcileRotation != 0 {
		t.Fatalf("0 must be accepted as 'disabled': cfg=%+v err=%v", cfg, err)
	}
}

func TestReconcileFlagsAreBounded(t *testing.T) {
	for _, args := range [][]string{
		{"-reconcile-days", "-1"}, {"-reconcile-days", "751"},
		{"-reconcile-rotation", "-1"}, {"-reconcile-rotation", "366"},
	} {
		if _, err := parseConfig(context.Background(), args); err == nil {
			t.Fatalf("parseConfig(%v) must refuse", args)
		}
	}
	for _, args := range [][]string{{"-reconcile-days", "750"}, {"-reconcile-rotation", "365"}} {
		if _, err := parseConfig(context.Background(), args); err != nil {
			t.Fatalf("the cap itself must be legal (%v): %v", args, err)
		}
	}
}

func TestReconcileRangeFlags(t *testing.T) {
	cfg, err := parseConfig(context.Background(), []string{"-reconcile-from", "2010-01-01", "-reconcile-to", "2014-12-31"})
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.reconcileFrom != utcDay(2010, 1, 1) || cfg.reconcileTo != utcDay(2014, 12, 31) {
		t.Fatalf("range = %s → %s", cfg.reconcileFrom, cfg.reconcileTo)
	}
	for _, args := range [][]string{
		{"-reconcile-from", "01/01/2010"},
		{"-reconcile-to", "2014-12-31"},
		{"-reconcile-from", "2015-01-01", "-reconcile-to", "2014-12-31"},
		// A range REPLACES the rolling windows; both set would ignore one.
		{"-reconcile-from", "2010-01-01", "-reconcile-days", "30"},
		{"-reconcile-from", "2010-01-01", "-reconcile-rotation", "7"},
	} {
		if _, err := parseConfig(context.Background(), args); err == nil {
			t.Fatalf("parseConfig(%v) must refuse", args)
		}
	}
}

// TestReconcileFlagsRefusedOnShadow: a shadow run never reconciles, so the
// flags there would silently do nothing. The ENV vars must still be tolerated
// — the admin console's -shadow validation runs inherit the job's environment.
func TestReconcileFlagsRefusedOnShadow(t *testing.T) {
	for _, flagArgs := range [][]string{
		{"-reconcile-days", "30"}, {"-reconcile-rotation", "7"}, {"-reconcile-from", "2010-01-01"},
	} {
		_, err := parseConfig(context.Background(), append([]string{"-shadow"}, flagArgs...))
		if err == nil || !strings.Contains(err.Error(), "-dry-run") {
			t.Fatalf("%v on -shadow must be refused and point at -dry-run, got %v", flagArgs, err)
		}
	}
	t.Setenv("SYNC_RECONCILE_DAYS", "30")
	t.Setenv("SYNC_RECONCILE_ROTATION", "7")
	if _, err := parseConfig(context.Background(), []string{"-shadow", "-stocks", "WBT"}); err != nil {
		t.Fatalf("the job env must not break a console validation run: %v", err)
	}
}

// --- the stored report (range runs) ------------------------------------------

func TestReconcileObjectPath(t *testing.T) {
	if got := reconcileObjectPath("shorts-data-sync-v4l1d"); got != "reconcile/shorts-data-sync-v4l1d.json" {
		t.Fatalf("object path = %q — the repair workflow reads exactly this key", got)
	}
}

// TestReconcileReportListsEveryDate: the stored report is the audit trail of a
// repair, so it lists every date that differed — not the 20 the log line shows
// — including dates that only hold extra rows.
func TestReconcileReportListsEveryDate(t *testing.T) {
	store := newFakeReconcileStore()
	bodies := map[int][]byte{}
	var window []asicFile
	for i := 0; i < 30; i++ {
		d := yyyymmdd(utcDay(2026, 1, 1).AddDate(0, 0, i))
		bodies[d] = asicCSV("BHP")
		window = append(window, asicFile{Date: d, Version: "001"})
	}
	store.holds("2026-02-01", "BHP", "OLD") // complete, plus one row ASIC no longer carries
	bodies[20260201] = asicCSV("BHP")
	window = append(window, asicFile{Date: 20260201, Version: "001"})

	rep, err := reconcileFiles(context.Background(), store, fetchFrom(bodies, nil), window, true)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if rep.Diverged != 30 || len(rep.Dates) != 31 {
		t.Fatalf("diverged = %d, dates = %d; want 30 needing writes and 31 listed", rep.Diverged, len(rep.Dates))
	}

	w := &recordingWriter{}
	publishReconcileArtifact(context.Background(), rep, true, "range 20260101 → 20260201", w,
		"shorted-short-selling-data-prod", "shorts-data-sync-abcde")
	if w.calls != 1 || w.bucket != "shorted-short-selling-data-prod" || w.object != "reconcile/shorts-data-sync-abcde.json" {
		t.Fatalf("wrote %d object(s) to gs://%s/%s", w.calls, w.bucket, w.object)
	}
	var got reconcileArtifactReport
	if err := json.Unmarshal(w.body, &got); err != nil {
		t.Fatalf("stored report is not JSON: %v", err)
	}
	if !got.DryRun || got.Diverged != 30 || got.RowsMissing != 30 || len(got.Dates) != 31 || got.Failed == nil {
		t.Fatalf("stored report = %+v", got)
	}
	last := got.Dates[len(got.Dates)-1]
	if last.Date != "2026-02-01" || last.Extra != 1 || last.Missing != 0 {
		t.Fatalf("the extra-only date must be listed with its count: %+v", last)
	}
	// A count alone gives a person nothing to decide with: the report names
	// the row and the values the table holds (OLD sits at position 1, so
	// holds() stored fileRow(1) for it).
	if len(last.ExtraRows) != 1 {
		t.Fatalf("extra_rows = %+v, want the one row", last.ExtraRows)
	}
	x := last.ExtraRows[0]
	if x.Code != "OLD" || x.Short == nil || *x.Short != 2000 || *x.Issue != 1000000 || *x.Pct != 0.2 {
		t.Fatalf("extra row = %s, want \"OLD\" 2000/1000000/0.2%%", x)
	}
	if !strings.Contains(string(w.body), `"extra_rows":[{"code":"OLD","short":2000,"issue":1000000,"pct":0.2}]`) {
		t.Fatalf("stored report does not name the extra row: %s", w.body)
	}
	for _, d := range got.Dates[:30] {
		if d.ExtraRows != nil {
			t.Fatalf("%s has no extra rows but lists %+v", d.Date, d.ExtraRows)
		}
	}
}

// TestExtraRowStringShowsPaddingAndNulls: the log line is the only place a
// scheduled run names extra rows, so it must show a padded code and a NULL as
// what they are.
func TestExtraRowStringShowsPaddingAndNulls(t *testing.T) {
	got := extraRow{Code: "WBT ", Short: ptr(1500), Issue: ptr(3000000), Pct: nil}.String()
	if got != `"WBT " 1500/3000000/NULL%` {
		t.Fatalf("String() = %s", got)
	}
}

// TestReconcileReportSkipsAndFailsSoft: no coordinates means no write, and a
// refused write never fails the run — the repair already happened.
func TestReconcileReportSkipsAndFailsSoft(t *testing.T) {
	w := &recordingWriter{}
	for _, c := range [][2]string{{"", "shorts-data-sync-abcde"}, {"bucket", ""}, {"bucket", "Not An Execution"}} {
		publishReconcileArtifact(context.Background(), reconcileReport{}, false, "", w, c[0], c[1])
	}
	if w.calls != 0 {
		t.Fatalf("a run without a bucket or an execution id must not write, got %d write(s)", w.calls)
	}
	w.err = errors.New("403")
	publishReconcileArtifact(context.Background(), reconcileReport{}, false, "", w, "bucket", "shorts-data-sync-abcde")
	if w.calls != 1 {
		t.Fatalf("the write must be attempted once, got %d", w.calls)
	}
}

// TestRepairWorkflowReadsTheReconcileObject pins the cross-file contract: the
// workflow that runs a repair reads back exactly the object the job writes,
// from the job it executes, with the flag this package defines.
func TestRepairWorkflowReadsTheReconcileObject(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", ".github", "workflows", "shorts-data-repair.yml"))
	if err != nil {
		t.Fatalf("read workflow: %v", err)
	}
	wf := string(b)
	for _, want := range []string{
		`gs://$BUCKET/` + reconcileObjectPrefix + `$EXECUTION.json`,
		"JOB: shorts-data-sync",
		`args="short-data-sync"`,
		"-reconcile-from",
		"-reconcile-to",
		"-dry-run",
		// The log line is all a caller without the step summary can read.
		"extra_rows: [.dates[]",
	} {
		if !strings.Contains(wf, want) {
			t.Fatalf("shorts-data-repair.yml must contain %q", want)
		}
	}
}
