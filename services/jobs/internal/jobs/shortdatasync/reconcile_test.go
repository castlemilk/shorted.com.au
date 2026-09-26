package shortdatasync

// reconcile_test.go covers the pass that repairs dates the forward window has
// already moved past (reconcile.go). The failure it exists for: a date that
// lost rows was never offered to the pipeline again, so every stock silently
// lost history — reported as WBT's short data "stopping".

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

const reconcileHeader = "Product,Product Code,Reported Short Positions,Total Product in Issue,% of Total Product in Issue Reported as Short Positions\r\n"

// asicCSV renders a modern ASIC daily file with one row per code.
func asicCSV(codes ...string) []byte {
	var b strings.Builder
	b.WriteString(reconcileHeader)
	for i, c := range codes {
		fmt.Fprintf(&b, "%s LTD ORDINARY,%s,%d,1000000,%.8f\r\n", strings.TrimSpace(c), c, 1000*(i+1), float64(i+1)/10)
	}
	return []byte(b.String())
}

// fakeReconcileStore is an in-memory shorts table keyed by date then code.
type fakeReconcileStore struct {
	codes    map[string]map[string]struct{}
	codesErr map[string]error
	upserts  [][]shortsRow
}

func newFakeReconcileStore() *fakeReconcileStore {
	return &fakeReconcileStore{codes: map[string]map[string]struct{}{}, codesErr: map[string]error{}}
}

func (f *fakeReconcileStore) holds(date string, codes ...string) {
	if f.codes[date] == nil {
		f.codes[date] = map[string]struct{}{}
	}
	for _, c := range codes {
		f.codes[date][c] = struct{}{}
	}
}

func (f *fakeReconcileStore) CodesOnDate(ctx context.Context, d time.Time) (map[string]struct{}, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := d.Format("2006-01-02")
	if err := f.codesErr[key]; err != nil {
		return nil, err
	}
	out := map[string]struct{}{}
	for c := range f.codes[key] {
		out[c] = struct{}{}
	}
	return out, nil
}

func (f *fakeReconcileStore) UpsertRows(ctx context.Context, rows []shortsRow) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	f.upserts = append(f.upserts, rows)
	for _, r := range rows {
		f.holds(r.Date.Format("2006-01-02"), r.ProductCode)
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

// --- the window -------------------------------------------------------------

// TestReconcileWindowStopsAtTheStartingMaxDate is the split between the two
// passes: dates AFTER the MAX("DATE") a run started with belong to the forward
// window, so the reconcile window never reports (or writes) them twice.
func TestReconcileWindowStopsAtTheStartingMaxDate(t *testing.T) {
	index := []asicFile{
		{Date: 20260921, Version: "001"}, // published since the last run — forward window's
		{Date: 20260918, Version: "001"},
		{Date: 20260917, Version: "001"},
		{Date: 20260916, Version: "001"},
		{Date: 20260915, Version: "001"},
	}
	got := reconcileWindow(index, 3, time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC))
	want := []int{20260916, 20260917, 20260918}
	if len(got) != len(want) {
		t.Fatalf("window = %+v, want dates %v", got, want)
	}
	for i := range want {
		if got[i].Date != want[i] {
			t.Fatalf("window[%d] = %d, want %d (oldest first, at or before the starting MAX)", i, got[i].Date, want[i])
		}
	}
}

// TestReconcileWindowCountsPublishedDates: like the validation window, N counts
// dates ASIC actually published, so a holiday or an ASIC outage never shrinks it.
func TestReconcileWindowCountsPublishedDates(t *testing.T) {
	index := files(20260105, 20251231, 20251224, 20251223) // holidays between
	got := reconcileWindow(index, 3, time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC))
	if len(got) != 3 || got[0].Date != 20251224 || got[2].Date != 20260105 {
		t.Fatalf("window = %+v, want the three published dates 20251224..20260105", got)
	}
}

// TestReconcileWindowTakesTheNewestVersionOnce keeps a republished date from
// being checked twice (and double-reported on a dry run).
func TestReconcileWindowTakesTheNewestVersionOnce(t *testing.T) {
	index := []asicFile{
		{Date: 20260815, Version: "001"},
		{Date: 20260815, Version: "002"},
		{Date: 20260814, Version: "001"},
	}
	got := reconcileWindow(index, 5, time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC))
	if len(got) != 2 {
		t.Fatalf("one file per date, got %+v", got)
	}
	if got[1].Date != 20260815 || got[1].Version != "002" {
		t.Fatalf("a republished date must reconcile from its newest version, got %+v", got[1])
	}
}

// --- the repair -------------------------------------------------------------

// TestReconcileWritesOnlyTheMissingRows is the production incident in
// miniature: a date holding half its rows (Feb 2026), a date holding none
// (2026-04-09), and a complete date that must not be rewritten.
func TestReconcileWritesOnlyTheMissingRows(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2026-02-03", "BHP", "CBA")               // partial: WBT, PLS missing
	store.holds("2026-02-04", "BHP", "CBA", "PLS", "WBT") // complete
	// 2026-04-09: nothing at all.

	bodies := map[int][]byte{
		20260203: asicCSV("BHP", "CBA", "PLS", "WBT"),
		20260204: asicCSV("BHP", "CBA", "PLS", "WBT"),
		20260409: asicCSV("BHP", "WBT"),
	}
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(bodies, nil), files(20260203, 20260204, 20260409), false)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}

	got := strings.Join(store.written(), ",")
	want := "2026-02-03|PLS,2026-02-03|WBT,2026-04-09|BHP,2026-04-09|WBT"
	if got != want {
		t.Fatalf("wrote %s\nwant  %s", got, want)
	}
	if rep.Files != 3 || rep.Complete != 1 || rep.Short != 2 || rep.RowsMissing != 4 || rep.RowsWritten != 4 {
		t.Fatalf("report = %+v", rep)
	}
	if strings.Join(rep.ShortDates, ",") != "2026-02-03 2/4,2026-04-09 2/2" {
		t.Fatalf("short dates = %v", rep.ShortDates)
	}

	// Second pass: everything is present, so a healthy table sees no writes.
	before := len(store.upserts)
	rep, err = reconcileFiles(context.Background(), store, fetchFrom(bodies, nil), files(20260203, 20260204, 20260409), false)
	if err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if len(store.upserts) != before || rep.Complete != 3 || rep.Short != 0 {
		t.Fatalf("a repaired window must reconcile to zero writes: %+v", rep)
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
		Date:                   time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC),
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

// TestReconcileTreatsAPaddedStoredCodeAsPresent: pre-2023 files padded some
// codes ("WBT "). CodesOnDate trims the stored side and parseFile the file
// side, so a padded row is found rather than duplicated under a trimmed code.
func TestReconcileTreatsAPaddedStoredCodeAsPresent(t *testing.T) {
	store := newFakeReconcileStore()
	store.holds("2021-11-04", "WBT") // what btrim("WBT ") returns
	body := asicCSV("WBT ")          // the legacy file's padded code
	rep, err := reconcileFiles(context.Background(), store, fetchFrom(map[int][]byte{20211104: body}, nil), files(20211104), false)
	if err != nil {
		t.Fatalf("reconcileFiles: %v", err)
	}
	if len(store.upserts) != 0 || rep.Complete != 1 {
		t.Fatalf("a padded code must count as present, wrote %v (%+v)", store.written(), rep)
	}
	if !strings.Contains(codesOnDateSQL, `btrim("PRODUCT_CODE")`) {
		t.Fatal("CodesOnDate must trim the stored codes it compares")
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
	if rep.Short != 1 || rep.RowsMissing != 1 || rep.RowsWritten != 0 {
		t.Fatalf("a dry run must still report what it would write: %+v", rep)
	}
}

// TestReconcileSkipsFilesItCannotCheck: one bad file must not cost the rest of
// the window, and must never fail the run — the next run's window retries it.
func TestReconcileSkipsFilesItCannotCheck(t *testing.T) {
	store := newFakeReconcileStore()
	store.codesErr["2026-02-05"] = errors.New("pooler hiccup")
	bodies := map[int][]byte{
		20260203: []byte("not,an,asic,file\r\n1,2,3,4\r\n"),
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

// TestCodesOnDateSQLIsADayRange pins the half-open range: equality on a
// timestamp column would miss a row carrying a time-of-day component.
func TestCodesOnDateSQLIsADayRange(t *testing.T) {
	if !strings.Contains(codesOnDateSQL, `"DATE" >= $1 AND "DATE" < $2`) {
		t.Fatalf("CodesOnDate must select a half-open day range:\n%s", codesOnDateSQL)
	}
}

// --- the flag ---------------------------------------------------------------

func TestReconcileDaysDefaultsAndEnv(t *testing.T) {
	cfg, err := parseConfig(context.Background(), nil)
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.reconcileDays != defaultReconcileDays {
		t.Fatalf("reconcile-days default = %d, want %d — the pass must be ON by default", cfg.reconcileDays, defaultReconcileDays)
	}

	t.Setenv("SYNC_RECONCILE_DAYS", "250")
	cfg, err = parseConfig(context.Background(), nil)
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.reconcileDays != 250 {
		t.Fatalf("SYNC_RECONCILE_DAYS not honoured: %d", cfg.reconcileDays)
	}

	cfg, err = parseConfig(context.Background(), []string{"-reconcile-days", "0"})
	if err != nil || cfg.reconcileDays != 0 {
		t.Fatalf("0 must be accepted as 'disabled': cfg=%+v err=%v", cfg, err)
	}
}

func TestReconcileDaysIsBounded(t *testing.T) {
	for _, arg := range []string{"-1", "751", "7500"} {
		if _, err := parseConfig(context.Background(), []string{"-reconcile-days", arg}); err == nil {
			t.Fatalf("-reconcile-days %s must be refused (0-%d)", arg, maxReconcileDays)
		}
	}
	if _, err := parseConfig(context.Background(), []string{"-reconcile-days", "750"}); err != nil {
		t.Fatalf("the cap itself must be legal: %v", err)
	}
}

// TestReconcileDaysFlagRefusedOnShadow: a shadow run never reconciles, so the
// flag there would silently do nothing. The ENV var must still be tolerated —
// the admin console's -shadow validation runs inherit the job's environment.
func TestReconcileDaysFlagRefusedOnShadow(t *testing.T) {
	_, err := parseConfig(context.Background(), []string{"-shadow", "-reconcile-days", "30"})
	if err == nil || !strings.Contains(err.Error(), "-dry-run") {
		t.Fatalf("-reconcile-days on -shadow must be refused and point at -dry-run, got %v", err)
	}

	t.Setenv("SYNC_RECONCILE_DAYS", "30")
	if _, err := parseConfig(context.Background(), []string{"-shadow", "-stocks", "WBT"}); err != nil {
		t.Fatalf("the job env must not break a console validation run: %v", err)
	}
}
