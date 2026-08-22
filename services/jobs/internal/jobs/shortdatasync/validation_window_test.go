package shortdatasync

// validation_window_test.go covers the ONE way a `-stocks` validation run
// diverges from the sync: its file window is the last N PUBLISHED ASIC dates,
// not (MAX("DATE") + 1 day → today).
//
// The two properties worth guarding are opposite in direction:
//
//   - a validation run must ALWAYS have files to compare, even when everything
//     is already ingested (that is the bug this fixes); and
//   - the sync and the plain `-shadow` parity run must be completely
//     unaffected, because the parity artefact is a pinned contract.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// --- window selection -------------------------------------------------------

func index() []asicFile {
	// Newest-first, as ASIC serves it, with the 15th republished as -002 and a
	// weekend gap between the 15th (Fri) and the 18th (Mon).
	return []asicFile{
		{Date: 20260819, Version: "001"},
		{Date: 20260818, Version: "001"},
		{Date: 20260815, Version: "002"},
		{Date: 20260815, Version: "001"},
		{Date: 20260814, Version: "001"},
		{Date: 20260813, Version: "001"},
	}
}

func TestSelectRecentFilesTakesTheLastNPublishedDates(t *testing.T) {
	got := selectRecentFiles(index(), 3)
	// 3 DISTINCT dates = 19th, 18th, 15th — and BOTH versions of the 15th, so
	// the duplicate-version semantics of a real run are preserved.
	want := []int{20260819, 20260818, 20260815, 20260815}
	if len(got) != len(want) {
		t.Fatalf("selected %d file(s), want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].Date != want[i] {
			t.Fatalf("selected[%d] = %d, want %d (index order must be preserved)", i, got[i].Date, want[i])
		}
	}
}

// TestSelectRecentFilesCountsDatesNotCalendarDays is the reason this is not a
// `today - N days` window: ASIC publishes on business days only, so a calendar
// window over a long weekend or an ASIC outage can legitimately select nothing
// — the exact "there was no window" failure the flag exists to remove.
func TestSelectRecentFilesCountsDatesNotCalendarDays(t *testing.T) {
	stale := []asicFile{{Date: 20260701}, {Date: 20260630}}
	got := selectRecentFiles(stale, 7)
	if len(got) != 2 {
		t.Fatalf("a stale index must still yield every file it has, got %d", len(got))
	}
}

func TestSelectRecentFilesEdges(t *testing.T) {
	if got := selectRecentFiles(index(), 99); len(got) != len(index()) {
		t.Fatalf("asking for more dates than exist must take them all, got %d", len(got))
	}
	if got := selectRecentFiles(nil, 7); got != nil {
		t.Fatalf("an empty index selects nothing, got %+v", got)
	}
	if got := selectRecentFiles(index(), 0); got != nil {
		t.Fatalf("a non-positive window selects nothing, got %+v", got)
	}
}

func TestWindowBounds(t *testing.T) {
	first, last, ok := windowBounds(selectRecentFiles(index(), 3))
	if !ok {
		t.Fatal("bounds must resolve for a normal index")
	}
	if first.Format("2006-01-02") != "2026-08-15" || last.Format("2006-01-02") != "2026-08-19" {
		t.Fatalf("bounds = %s → %s", first, last)
	}
	if _, _, ok := windowBounds([]asicFile{{Date: 99}}); ok {
		t.Fatal("an unparseable date must not produce bounds")
	}
}

// --- the parity guard -------------------------------------------------------

// TestSyncFileWindowIsCutoffBased pins the window a SYNC, a `-dry-run` and a
// plain `-shadow` parity run all use: derived from MAX("DATE"), short-circuiting
// when the table already holds today. -validate-days must never reach here.
func TestSyncFileWindowIsCutoffBased(t *testing.T) {
	today := day(20)

	// Ingested up to the 17th → the window starts on the 18th, NOT today-7.
	cutoff, upToDate := syncFileWindow(7, today, day(17), true)
	if upToDate {
		t.Fatal("the 17th is behind today; the run must not short-circuit")
	}
	if cutoff.Format("2006-01-02") != "2026-08-18" {
		t.Fatalf("cutoff = %s, want 2026-08-18 (last ingested date + 1)", cutoff)
	}

	// Already holding today → short-circuit, and the recorded window falls back
	// to today-days so a summary never carries the zero time.
	cutoff, upToDate = syncFileWindow(7, today, today, true)
	if !upToDate {
		t.Fatal("a table already holding today must short-circuit")
	}
	if cutoff.Format("2006-01-02") != "2026-08-13" {
		t.Fatalf("fallback cutoff = %s, want today-7", cutoff)
	}

	// Empty table → the initial-load window.
	cutoff, upToDate = syncFileWindow(30, today, time.Time{}, false)
	if upToDate || cutoff.Format("2006-01-02") != "2026-07-21" {
		t.Fatalf("empty-table cutoff = %s upToDate = %v", cutoff, upToDate)
	}
}

// TestValidationModeOnlyForStocks is the fork itself: a plain shadow run takes
// the cutoff path, a `-stocks` run takes the index path, and a run with no
// summary (a live sync) can never take the validation path at all.
func TestValidationModeOnlyForStocks(t *testing.T) {
	sum := newShadowSummary(time.Now(), 7)
	if validationMode(config{shadow: true}, &sum) {
		t.Fatal("a plain -shadow run must use the sync's cutoff window")
	}
	if !validationMode(config{shadow: true, stocks: []string{"BHP"}}, &sum) {
		t.Fatal("a -stocks run must use the validation window")
	}
	if validationMode(config{stocks: []string{"BHP"}}, nil) {
		t.Fatal("no summary means no validation path (a live sync must be unreachable from here)")
	}
}

// --- flag contract ----------------------------------------------------------

func TestValidateDaysFlag(t *testing.T) {
	cfg, err := parseConfig(context.Background(), []string{"-shadow", "-stocks", "BHP"})
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.validateDays != defaultValidateDays {
		t.Fatalf("validate-days default = %d, want %d", cfg.validateDays, defaultValidateDays)
	}

	cfg, err = parseConfig(context.Background(), []string{"-shadow", "-stocks", "BHP", "-validate-days", "14"})
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.validateDays != 14 {
		t.Fatalf("validate-days = %d, want 14", cfg.validateDays)
	}
}

func TestValidateDaysIsBounded(t *testing.T) {
	for _, arg := range []string{"0", "-1", "31", "9999"} {
		if _, err := parseConfig(context.Background(), []string{"-shadow", "-stocks", "BHP", "-validate-days", arg}); err == nil {
			t.Fatalf("-validate-days %s must be refused (1-%d)", arg, maxValidateDays)
		}
	}
	if _, err := parseConfig(context.Background(), []string{"-shadow", "-stocks", "BHP", "-validate-days", "30"}); err != nil {
		t.Fatalf("the cap itself must be legal: %v", err)
	}
}

// TestValidateDaysRequiresStocks keeps the flag from silently doing nothing on
// a sync or a parity run — the same posture as -stocks requiring -shadow.
func TestValidateDaysRequiresStocks(t *testing.T) {
	for _, args := range [][]string{
		{"-validate-days", "14"},
		{"-shadow", "-validate-days", "14"},
	} {
		_, err := parseConfig(context.Background(), args)
		if err == nil {
			t.Fatalf("parseConfig(%v) must refuse: the flag has no effect there", args)
		}
		if !strings.Contains(err.Error(), "-stocks") {
			t.Fatalf("the error must name -stocks, got %v", err)
		}
	}
}

// TestStocksStillRefusesWithoutShadow re-pins the write-path guard alongside
// the widened window: validation now re-parses already-ingested dates, so the
// "this can never write" property is worth asserting in this file too.
func TestStocksStillRefusesWithoutShadow(t *testing.T) {
	if _, err := parseConfig(context.Background(), []string{"-stocks", "BHP", "-validate-days", "30"}); err == nil {
		t.Fatal("-stocks without -shadow must be refused however the window is set")
	}
	cfg, err := parseConfig(context.Background(), []string{"-shadow", "-stocks", "BHP", "-validate-days", "30"})
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if !cfg.dryRun {
		t.Fatal("a validation run must always be dry-run")
	}
}

// --- what the operator sees -------------------------------------------------

// TestValidationOfAnIngestedStockReportsUnchanged is the whole point of the
// change: over a window that is already ingested, a healthy pipeline reports
// `unchanged` for every row — "the file says 1.35%, the DB says 1.35%" — rather
// than the empty `not_found` an operator used to get.
func TestValidationOfAnIngestedStockReportsUnchanged(t *testing.T) {
	var files []stockFileRows
	db := map[string]shortsRow{}
	for d := 14; d <= 18; d++ {
		row := shortsRow{
			Date: day(d), Product: "BHP LTD", ProductCode: "BHP",
			ReportedShortPositions: 1350, TotalProductInIssue: 100000, Percent: 1.35,
		}
		files = append(files, stockFileRows{Date: day(d), File: "RR2026081" + string(rune('0'+d-10)) + "-001.csv", Rows: []shortsRow{row}})
		db[rowKey(day(d), "BHP")] = row
	}

	rep := buildStocksReport([]string{"BHP"}, files, db)

	if rep.WindowEmpty || rep.FilesInWindow != 5 {
		t.Fatalf("the window must be reported as populated: %+v", rep)
	}
	if len(rep.NotFound) != 0 {
		t.Fatalf("an ingested, published stock must NOT be not_found: %v", rep.NotFound)
	}
	if rep.Counts[statusUnchanged] != 5 || len(rep.Observations) != 5 {
		t.Fatalf("every already-ingested row must read `unchanged`: counts=%v", rep.Counts)
	}
	for _, o := range rep.Observations {
		if o.FileValues == nil || o.DBValues == nil {
			t.Fatalf("both sides must be visible so the agreement is legible: %+v", o)
		}
		if o.WouldInsert {
			t.Fatalf("an unchanged row is never an insert: %+v", o)
		}
	}
	if rep.DBRowsInWindow != 5 {
		t.Fatalf("db_rows_in_window = %d, want 5 (requested codes only)", rep.DBRowsInWindow)
	}
}

// TestValidationSectionOmittedOnPlainShadow keeps the parity artefact
// byte-identical: `validation`, like `stocks` and `artifact`, exists only on a
// `-stocks` run.
func TestValidationSectionOmittedOnPlainShadow(t *testing.T) {
	var buf strings.Builder
	if err := newShadowSummary(time.Now(), 7).writeJSON(&buf); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}
	for _, forbidden := range []string{`"validation"`, `"stocks"`, `"artifact"`} {
		if strings.Contains(buf.String(), forbidden) {
			t.Fatalf("a plain shadow summary must not carry %s:\n%s", forbidden, buf.String())
		}
	}
}

// TestValidationWindowSerialises pins the shape the console renders, including
// the empty-window `problem` string that must never be confused with a
// not-found code.
func TestValidationWindowSerialises(t *testing.T) {
	sum := newShadowSummary(time.Now(), 7)
	sum.Validation = &validationWindow{
		Days:          7,
		Files:         []string{},
		IgnoredCutoff: "2026-08-18",
		Problem:       "no ASIC files could be scanned: the ASIC file index is empty",
	}
	b, err := json.Marshal(sum)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back struct {
		Validation *validationWindow `json:"validation"`
	}
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.Validation == nil || back.Validation.Days != 7 || back.Validation.Problem == "" {
		t.Fatalf("validation section lost in transit: %s", b)
	}
	if back.Validation.From != "" {
		t.Fatalf("an empty window must not claim a from-date: %+v", back.Validation)
	}
}
