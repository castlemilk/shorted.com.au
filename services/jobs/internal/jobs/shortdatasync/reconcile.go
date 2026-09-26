package shortdatasync

// reconcile.go keeps the shorts table converged on ASIC's CURRENT archive: it
// goes back over dates the forward window has already moved past, and writes
// every row that is missing or whose values no longer match what ASIC
// publishes for that date.
//
// # Why the forward window alone drifts from ASIC for good
//
// The sync window is MAX("DATE") + 1 day → today (syncFileWindow). That is the
// right window for NEW data and a trap for anything that happens to OLD data:
// once any row of a date lands, MAX("DATE") moves past it and the date is never
// offered to the pipeline again. So each of these stays wrong forever:
//
//   - a file that failed to download or parse and was skipped while a NEWER
//     file in the same window loaded (files run newest first);
//   - a run interrupted after the newest file committed but before older ones;
//   - rows that failed to write and were counted rather than fatal (UpsertRows,
//     the Python's posture, kept deliberately);
//   - a file ASIC REPUBLISHED with corrections after it was ingested. The index
//     then lists a newer version for the date (002, 003, 010…) and nothing
//     looked at it again: on 2025-08-11 the table still says BPT was 5.23%
//     short, from version 001, where ASIC's corrected 002 says 3.20%.
//
// None of these fails a run, so none alerted. Found by auditing every ASIC file
// since 2010 against prod on 2026-09-26 (package README §Reconcile).
//
// # What the pass does
//
// For each date in the window it downloads the date's CURRENT file (the version
// the index lists), reads the rows the table holds for that date, and writes
// the rows that are missing or whose values differ, through the same UpsertRows
// the sync uses. Nothing that already matches is rewritten, and nothing is ever
// deleted: rows the table holds that the current file does not are counted and
// reported, for a person to decide about.
//
// Every live run checks the union of two windows:
//
//   - the most recent N published dates (-reconcile-days, default 20), so recent
//     damage heals the next day;
//   - a ROTATING slice of the whole archive (-reconcile-rotation, default 28):
//     the i-th published date is checked on days where i ≡ day (mod 28), so every
//     date since 2010 is re-verified once every four weeks at about 1/28 of the
//     archive a day. That is what catches a republication of an old date, or
//     damage older than the recent window, without storing any state.
//
// Both stop at the MAX("DATE") the run STARTED with. Later dates belong to the
// forward window, which keeps a dry run from reporting a new date twice.
//
// -reconcile-from/-reconcile-to replace both with an explicit range: the
// one-off repair of history. -dry-run previews any of it and writes nothing.

import (
	"context"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
)

// storedRow is one row the table already holds for a date.
type storedRow struct {
	// Code is the code as STORED. Legacy loads kept the padding some pre-2023
	// files put on a code ("WBT "); such a row counts as present, but it cannot
	// be corrected in place without creating a trimmed duplicate.
	Code string
	// Pointers because a NULL is itself a difference worth repairing: the read
	// paths skip rows whose percentage is NULL.
	Short, Issue, Pct *float64
}

// reconcileStore is the slice of pgStore the pass needs, narrowed so the pass
// is testable without Postgres.
type reconcileStore interface {
	RowsOnDate(ctx context.Context, d time.Time) (map[string]storedRow, error)
	UpsertRows(ctx context.Context, rows []shortsRow) (int, error)
}

// fetchFunc returns one ASIC file's bytes.
type fetchFunc func(ctx context.Context, f asicFile) ([]byte, error)

// maxDatesLogged bounds the per-date detail in the summary line, so a full
// repair cannot turn one log line into thousands.
const maxDatesLogged = 20

// reconcileReport is what one pass found and did.
type reconcileReport struct {
	// Files is how many published dates were examined.
	Files int
	// Clean counts dates with nothing to write.
	Clean int
	// Diverged counts dates with at least one missing or changed row.
	Diverged int
	// RowsMissing and RowsChanged are what the files carry that the table does
	// not, or holds with different values.
	RowsMissing, RowsChanged int
	// RowsWritten is how many were written — always 0 on a dry run.
	RowsWritten int
	// RowsExtra counts rows the table holds that the current files do not.
	// Reported, never deleted.
	RowsExtra int
	// RowsPadded counts rows whose values differ but that are stored under a
	// padded legacy code, and so are left alone rather than duplicated.
	RowsPadded int
	// Dates names the diverged dates, oldest first, capped at maxDatesLogged.
	Dates []string
	// Failed names the files that could not be fetched, parsed or compared.
	// They are retried by a later run, whose window covers them again.
	Failed []string
}

// reconcileRecent runs the pass over this run's reconcile window. upTo is the
// MAX("DATE") read BEFORE the forward window wrote anything; today picks the
// rotation slice.
//
// It never fails the run over a bad file or a failed comparison: the forward
// sync has already succeeded, and a date it cannot check today is checked
// again later. Only cancellation is returned, so a SIGTERM stops the pass the
// way it stops the sync.
func reconcileRecent(ctx context.Context, cfg config, store reconcileStore, client *http.Client, upTo, today time.Time) (reconcileReport, error) {
	if cfg.reconcileFrom.IsZero() && cfg.reconcileDays < 1 && cfg.reconcileRotation < 1 {
		log.Printf("🩹 Reconcile disabled (-reconcile-days 0 -reconcile-rotation 0)")
		return reconcileReport{}, nil
	}
	// A second fetch of the ~140KB index rather than threading the forward
	// window's copy out of syncShorts, which the shadow path shares.
	index, err := fetchIndex(ctx, client)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return reconcileReport{}, ctxErr
		}
		log.Printf("⚠️  Reconcile skipped: could not fetch the ASIC file list: %v", err)
		return reconcileReport{}, nil
	}
	files, desc := reconcileSelection(index, cfg, upTo, today)
	log.Printf("🩹 RECONCILE: checking %d published date(s) against their current ASIC files — %s", len(files), desc)

	fetch := func(ctx context.Context, f asicFile) ([]byte, error) {
		return downloadFile(ctx, client, f.downloadURL())
	}
	rep, err := reconcileFiles(ctx, store, fetch, files, cfg.dryRun)
	// Logged on a cancelled pass too: whatever it wrote before the signal is
	// committed, and the run log should say so.
	rep.logSummary(cfg.dryRun)
	return rep, err
}

// reconcileSelection picks the files one run reconciles, oldest first, and
// describes the choice for the log.
func reconcileSelection(index []asicFile, cfg config, upTo, today time.Time) ([]asicFile, string) {
	all := currentFiles(index, upTo)
	if !cfg.reconcileFrom.IsZero() {
		from, to := yyyymmdd(cfg.reconcileFrom), yyyymmdd(upTo)
		if !cfg.reconcileTo.IsZero() && yyyymmdd(cfg.reconcileTo) < to {
			to = yyyymmdd(cfg.reconcileTo)
		}
		var out []asicFile
		for _, f := range all {
			if f.Date >= from && f.Date <= to {
				out = append(out, f)
			}
		}
		return out, fmt.Sprintf("range %d → %d", from, to)
	}

	pick := make(map[int]struct{}, cfg.reconcileDays+len(all)/28+1)
	recent := cfg.reconcileDays
	if recent > len(all) {
		recent = len(all)
	}
	for _, f := range all[len(all)-recent:] {
		pick[f.Date] = struct{}{}
	}
	rotated, slot := 0, 0
	if cfg.reconcileRotation > 0 {
		slot = int((today.Unix() / 86400) % int64(cfg.reconcileRotation))
		for i, f := range all {
			if i%cfg.reconcileRotation == slot {
				pick[f.Date] = struct{}{}
				rotated++
			}
		}
	}
	out := make([]asicFile, 0, len(pick))
	for _, f := range all {
		if _, ok := pick[f.Date]; ok {
			out = append(out, f)
		}
	}
	desc := fmt.Sprintf("the last %d up to %s", recent, upTo.Format("2006-01-02"))
	if cfg.reconcileRotation > 0 {
		desc += fmt.Sprintf(", plus rotation slice %d/%d of the archive (%d dates)", slot, cfg.reconcileRotation, rotated)
	}
	return out, desc
}

// currentFiles is the index reduced to ONE file per date — the highest version,
// which is the one ASIC currently publishes for it — at or before upTo, oldest
// first.
//
// Oldest first keeps the i-th date's rotation slot stable as new dates are
// appended, and makes the log read as a timeline. No date here moves
// MAX("DATE"), so the order is immaterial to correctness.
func currentFiles(index []asicFile, upTo time.Time) []asicFile {
	limit := yyyymmdd(upTo)
	byDate := map[int]asicFile{}
	for _, f := range index {
		if f.Date > limit {
			continue
		}
		if cur, ok := byDate[f.Date]; !ok || f.Version > cur.Version {
			byDate[f.Date] = f
		}
	}
	out := make([]asicFile, 0, len(byDate))
	for _, f := range byDate {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date < out[j].Date })
	return out
}

// reconcileFiles compares each file with the table and writes the difference.
func reconcileFiles(ctx context.Context, store reconcileStore, fetch fetchFunc, files []asicFile, dryRun bool) (reconcileReport, error) {
	var rep reconcileReport
	for _, f := range files {
		if err := ctx.Err(); err != nil {
			return rep, err
		}
		name := f.fileName()
		rep.Files++

		body, err := fetch(ctx, f)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return rep, ctxErr
			}
			rep.fail(name, "download", err)
			continue
		}
		rows, err := parseFile(name, body)
		if err != nil {
			rep.fail(name, "parse", err)
			continue
		}
		// parseFile has already derived every row's date from this name, so
		// this cannot fail for a file that parsed; it is the date to compare
		// against even when the file parsed to zero rows.
		obsDate, err := dateFromFileName(name)
		if err != nil {
			rep.fail(name, "date", err)
			continue
		}
		have, err := store.RowsOnDate(ctx, obsDate)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return rep, ctxErr
			}
			rep.fail(name, "read existing rows", err)
			continue
		}

		d := diffDate(rows, have)
		rep.RowsExtra += d.extra
		rep.RowsPadded += d.padded
		write := append(d.missing, d.changed...)
		if len(write) == 0 {
			rep.Clean++
			continue
		}
		rep.Diverged++
		rep.RowsMissing += len(d.missing)
		rep.RowsChanged += len(d.changed)
		day := obsDate.Format("2006-01-02")
		if len(rep.Dates) < maxDatesLogged {
			rep.Dates = append(rep.Dates, fmt.Sprintf("%s %d missing/%d changed of %d", day, len(d.missing), len(d.changed), len(rows)))
		}
		if dryRun {
			log.Printf("  [dry-run] %s: %d missing, %d changed of %d row(s) — would write them", day, len(d.missing), len(d.changed), len(rows))
			continue
		}
		written, err := store.UpsertRows(ctx, write)
		rep.RowsWritten += written
		if err != nil {
			// UpsertRows returns only cancellation; a failed row is counted,
			// logged by UpsertRows, and retried by a later run's window.
			return rep, err
		}
		log.Printf("  🩹 %s: %d missing, %d changed of %d row(s) — wrote %d", day, len(d.missing), len(d.changed), len(rows), written)
	}
	return rep, nil
}

// dateDiff is how one date's stored rows differ from its current file.
type dateDiff struct {
	missing []shortsRow // in the file, not in the table
	changed []shortsRow // in both with different values — the FILE's values
	padded  int         // differ, but stored under a padded legacy code
	extra   int         // in the table, not in the file
}

// diffDate compares one date's file rows (codes trimmed by parseFile) with the
// rows the table holds (keyed by trimmed code by RowsOnDate).
func diffDate(file []shortsRow, have map[string]storedRow) dateDiff {
	var d dateDiff
	inFile := make(map[string]struct{}, len(file))
	for _, r := range file {
		inFile[r.ProductCode] = struct{}{}
		st, ok := have[r.ProductCode]
		switch {
		case !ok:
			d.missing = append(d.missing, r)
		case sameValues(r, st):
		case st.Code != r.ProductCode:
			// Upserting under the trimmed code would add a second row beside
			// the padded one and double-count the date.
			d.padded++
		default:
			d.changed = append(d.changed, r)
		}
	}
	for code := range have {
		if _, ok := inFile[code]; !ok {
			d.extra++
		}
	}
	return d
}

// sameValues compares a file row with a stored one. Share counts are whole
// numbers and compare exactly. The percentage allows a relative 1e-9: the
// Python loader's float parser could land a ULP away from Go's for the same
// eight-decimal string, and a ULP is not a correction — a real one moves the
// figure by orders of magnitude more. A NULL or NaN never matches, so it is
// repaired.
func sameValues(r shortsRow, st storedRow) bool {
	if st.Short == nil || st.Issue == nil || st.Pct == nil {
		return false
	}
	if *st.Short != r.ReportedShortPositions || *st.Issue != r.TotalProductInIssue {
		return false
	}
	a, b := *st.Pct, r.Percent
	if a == b {
		return true
	}
	if math.IsNaN(a) || math.IsNaN(b) {
		return false
	}
	return math.Abs(a-b) <= 1e-9*math.Max(1, math.Max(math.Abs(a), math.Abs(b)))
}

func (r *reconcileReport) fail(file, stage string, err error) {
	log.Printf("⚠️  Reconcile could not check %s (%s): %v", file, stage, err)
	r.Failed = append(r.Failed, file)
}

// logSummary prints the pass's outcome. A repair is the interesting case — it
// means an earlier run lost or kept stale rows — so it names the dates.
func (r reconcileReport) logSummary(dryRun bool) {
	switch {
	case r.Files == 0:
		log.Printf("🩹 Reconcile: no published dates in the window")
	case r.Diverged == 0 && len(r.Failed) == 0:
		log.Printf("🩹 Reconcile: all %d published date(s) match ASIC", r.Clean)
	case r.Diverged == 0:
		log.Printf("🩹 Reconcile: %d of %d published date(s) match ASIC, the rest could not be checked", r.Clean, r.Files)
	default:
		action := fmt.Sprintf("wrote %d of %d row(s)", r.RowsWritten, r.RowsMissing+r.RowsChanged)
		if dryRun {
			action = fmt.Sprintf("would write %d row(s)", r.RowsMissing+r.RowsChanged)
		}
		more := ""
		if r.Diverged > len(r.Dates) {
			more = fmt.Sprintf(" (+%d more)", r.Diverged-len(r.Dates))
		}
		log.Printf("🩹 Reconcile: %d of %d published date(s) diverged from ASIC (%d missing, %d changed) — %s. %s%s",
			r.Diverged, r.Files, r.RowsMissing, r.RowsChanged, action, strings.Join(r.Dates, ", "), more)
	}
	if r.RowsExtra > 0 {
		log.Printf("🩹 Reconcile: %d row(s) are held that the current ASIC files do not carry — left in place", r.RowsExtra)
	}
	if r.RowsPadded > 0 {
		log.Printf("🩹 Reconcile: %d row(s) differ but are stored under a padded legacy code — left in place", r.RowsPadded)
	}
	if len(r.Failed) > 0 {
		log.Printf("⚠️  Reconcile could not check %d file(s), retried by a later run: %s", len(r.Failed), strings.Join(r.Failed, ", "))
	}
}
