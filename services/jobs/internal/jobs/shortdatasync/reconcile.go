package shortdatasync

// reconcile.go is the pass that goes BACK over dates the forward window has
// already moved past, and writes the rows ASIC published that the table does
// not hold.
//
// # Why the forward window alone loses data for good
//
// The sync window is MAX("DATE") + 1 day → today (syncFileWindow). That is the
// right window for NEW data and a trap for DAMAGED data: the moment any row of
// a date lands, MAX("DATE") moves past it and the date is never offered to the
// pipeline again. Three ordinary events leave a date short:
//
//   - a file fails to download or parse and is skipped, while a NEWER file in
//     the same window loads (files run newest first, in ASIC index order);
//   - a run is interrupted (timeout, SIGTERM) after the newest file committed
//     but before the older ones did;
//   - individual rows fail to write and are counted rather than fatal
//     (UpsertRows — the Python's posture, kept deliberately).
//
// None of the three fails the run, so nothing alerted. Measured against ASIC's
// own files on 2026-09-26, every stock had lost rows on dates between December
// 2025 and July 2026 — most dates in February 2026 held about half of what ASIC
// published, and 2026-04-09 held none at all. It surfaced as a user report that
// WBT's short data had "stopped": its chart was missing 14 dates since January.
//
// # What the pass does
//
// Every live run re-reads the most recent N PUBLISHED ASIC dates at or before
// the MAX("DATE") the run started with (-reconcile-days / SYNC_RECONCILE_DAYS),
// compares each file's product codes with the codes the table holds for that
// date, and writes ONLY the missing keys through the same UpsertRows the sync
// uses. A complete date costs one download and one small SELECT; nothing
// already present is rewritten, so a healthy table sees no writes at all.
//
// Dates AFTER that starting MAX("DATE") belong to the forward window, and the
// split is what keeps the two from double-counting: a dry run's new dates are
// reported once, by the window that would write them. A date the forward window
// damages today is inside tomorrow's reconcile window.
//
// A wider window is the historical repair: `-reconcile-days 250` walks the last
// 250 published dates once. `-dry-run` previews it and writes nothing.

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"
)

// reconcileStore is the slice of pgStore the pass needs, narrowed so the pass
// is testable without Postgres.
type reconcileStore interface {
	CodesOnDate(ctx context.Context, d time.Time) (map[string]struct{}, error)
	UpsertRows(ctx context.Context, rows []shortsRow) (int, error)
}

// fetchFunc returns one ASIC file's bytes.
type fetchFunc func(ctx context.Context, f asicFile) ([]byte, error)

// maxShortDatesLogged bounds the per-date detail in the summary line, so a wide
// repair cannot turn one log line into hundreds.
const maxShortDatesLogged = 20

// reconcileReport is what one pass found and did.
type reconcileReport struct {
	// Files is how many published dates were examined.
	Files int
	// Complete counts dates that already held every row their file carries.
	Complete int
	// Short counts dates missing at least one row.
	Short int
	// RowsMissing is how many rows the files carried that the table did not.
	RowsMissing int
	// RowsWritten is how many of those were written — always 0 on a dry run.
	RowsWritten int
	// ShortDates names the short dates, oldest first, capped at
	// maxShortDatesLogged ("2026-02-03 608/686").
	ShortDates []string
	// Failed names the files that could not be fetched, parsed or compared.
	// They are retried by the next run, whose window still covers them.
	Failed []string
}

// reconcileRecent runs the pass over the reconcile window ending at upTo, the
// MAX("DATE") read BEFORE the forward window wrote anything.
//
// It never fails the run over a bad file or a failed comparison: the forward
// sync has already succeeded, and a date it cannot check today is checked again
// tomorrow. Only cancellation is returned, so a SIGTERM stops the pass the way
// it stops the sync.
func reconcileRecent(ctx context.Context, cfg config, store reconcileStore, client *http.Client, upTo time.Time) (reconcileReport, error) {
	if cfg.reconcileDays < 1 {
		log.Printf("🩹 Reconcile disabled (-reconcile-days 0)")
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
	files := reconcileWindow(index, cfg.reconcileDays, upTo)
	log.Printf("🩹 RECONCILE: re-checking %d published date(s) up to %s for missing rows",
		len(files), upTo.Format("2006-01-02"))

	fetch := func(ctx context.Context, f asicFile) ([]byte, error) {
		return downloadFile(ctx, client, f.downloadURL())
	}
	rep, err := reconcileFiles(ctx, store, fetch, files, cfg.dryRun)
	// Logged on a cancelled pass too: whatever it wrote before the signal is
	// committed, and the run log should say so.
	rep.logSummary(cfg.dryRun)
	return rep, err
}

// reconcileWindow selects the most recent `days` published dates at or before
// upTo, ONE file per date (the highest version), oldest first.
//
// One file per date because the pass only fills keys that are missing: the
// newest version is the one to fill them from, and a second version of the same
// date would otherwise be reported twice on a dry run. (No date in the ASIC
// index has ever carried two versions; this keeps the pass honest if one does.)
// Oldest first so the log reads as a timeline — no date in this window moves
// MAX("DATE"), so the order is immaterial to correctness.
func reconcileWindow(index []asicFile, days int, upTo time.Time) []asicFile {
	limit := yyyymmdd(upTo)
	eligible := make([]asicFile, 0, len(index))
	for _, f := range index {
		if f.Date <= limit {
			eligible = append(eligible, f)
		}
	}
	byDate := map[int]asicFile{}
	for _, f := range selectRecentFiles(eligible, days) {
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

// reconcileFiles compares each file with the table and writes the missing rows.
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
		have, err := store.CodesOnDate(ctx, obsDate)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return rep, ctxErr
			}
			rep.fail(name, "read existing rows", err)
			continue
		}

		missing := missingRows(rows, have)
		if len(missing) == 0 {
			rep.Complete++
			continue
		}
		rep.Short++
		rep.RowsMissing += len(missing)
		label := fmt.Sprintf("%s %d/%d", obsDate.Format("2006-01-02"), len(missing), len(rows))
		if len(rep.ShortDates) < maxShortDatesLogged {
			rep.ShortDates = append(rep.ShortDates, label)
		}
		if dryRun {
			log.Printf("  [dry-run] %s: %d of %d row(s) missing — would write them", obsDate.Format("2006-01-02"), len(missing), len(rows))
			continue
		}
		written, err := store.UpsertRows(ctx, missing)
		rep.RowsWritten += written
		if err != nil {
			// UpsertRows returns only cancellation; a failed row is counted,
			// logged by UpsertRows, and retried by the next run's window.
			return rep, err
		}
		log.Printf("  🩹 %s: %d of %d row(s) were missing — wrote %d", obsDate.Format("2006-01-02"), len(missing), len(rows), written)
	}
	return rep, nil
}

// missingRows returns the rows whose product code the table does not hold for
// their date. Both sides are trimmed: parseFile trims the file's codes, and
// CodesOnDate trims the table's.
func missingRows(rows []shortsRow, have map[string]struct{}) []shortsRow {
	var out []shortsRow
	for _, r := range rows {
		if _, ok := have[r.ProductCode]; ok {
			continue
		}
		out = append(out, r)
	}
	return out
}

func (r *reconcileReport) fail(file, stage string, err error) {
	log.Printf("⚠️  Reconcile could not check %s (%s): %v", file, stage, err)
	r.Failed = append(r.Failed, file)
}

// logSummary prints the pass's one-line outcome. A repair is the interesting
// case — it means an earlier run lost rows — so it names the dates.
func (r reconcileReport) logSummary(dryRun bool) {
	switch {
	case r.Files == 0:
		log.Printf("🩹 Reconcile: no published dates in the window")
	case r.Short == 0 && len(r.Failed) == 0:
		log.Printf("🩹 Reconcile: all %d published date(s) complete", r.Complete)
	case r.Short == 0:
		log.Printf("🩹 Reconcile: %d of %d published date(s) complete, the rest could not be checked", r.Complete, r.Files)
	default:
		action := fmt.Sprintf("wrote %d of %d missing row(s)", r.RowsWritten, r.RowsMissing)
		if dryRun {
			action = fmt.Sprintf("would write %d missing row(s)", r.RowsMissing)
		}
		more := ""
		if r.Short > len(r.ShortDates) {
			more = fmt.Sprintf(" (+%d more)", r.Short-len(r.ShortDates))
		}
		log.Printf("🩹 Reconcile: %d of %d published date(s) were missing rows — %s. Missing/published: %s%s",
			r.Short, r.Files, action, strings.Join(r.ShortDates, ", "), more)
	}
	if len(r.Failed) > 0 {
		log.Printf("⚠️  Reconcile could not check %d file(s), retried next run: %s", len(r.Failed), strings.Join(r.Failed, ", "))
	}
}
