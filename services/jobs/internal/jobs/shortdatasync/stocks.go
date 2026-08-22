package shortdatasync

// stocks.go implements `-stocks BHP,DRO` — the per-stock VALIDATION view of a
// shadow run.
//
// The question it answers is the one an operator actually asks when the sync
// looks wrong for one company: "what does today's ASIC file say about BHP, what
// would the sync do with it, and what is in the database right now?" A full
// shadow summary answers that for 2,000 stocks at once, which is to say it
// answers it for none of them.
//
// Everything here is READ-ONLY by construction: the flag is only accepted
// alongside -shadow (see parseConfig), and the only new database access is one
// SELECT over the requested codes.

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// validationLinePrefix marks the ONE compact JSON line a `-shadow -stocks` run
// writes to stdout.
//
// Why a sentinel instead of the plain indented summary: the retrieval path is
// Cloud Logging, which splits a container's stdout on newlines into one log
// ENTRY per line. The pretty-printed summary a bare `-shadow` run emits is
// therefore unrecoverable from logs without reassembling dozens of entries in
// order. A validation run instead emits a single line that survives the trip
// intact, tagged so the reader can find it among the job's log chatter.
//
// The reader is in a DIFFERENT Go module (services/shorts/internal/jobmonitor),
// so it carries its own copy of this literal. Both sides have a test asserting
// the exact string — change one, change the other.
const validationLinePrefix = "SHORTED_VALIDATION_JSON "

// shadowSchemaVersion is the version of the shadow/validation JSON contract.
// Bump it when a field changes meaning or is removed; adding a field does not
// require a bump (every consumer parses defensively).
const shadowSchemaVersion = 1

// maxStockCodes caps a single validation request. The report is meant to be
// read by a human in a console table; twenty codes is already generous, and the
// cap is what stops "-stocks" from becoming a way to dump the whole file.
const maxStockCodes = 20

// stockCodePattern is the ASX product-code shape. ASIC codes are 3-5 chars in
// practice; 1-5 is the permissive-but-still-bounded form, and the character
// class is what keeps a code out of any injectable position.
var stockCodePattern = regexp.MustCompile(`^[A-Z0-9]{1,5}$`)

// parseStockCodes normalises and validates a `-stocks` value.
//
// Accepts comma and/or whitespace separation, upper-cases, de-duplicates while
// preserving the order the operator typed, and rejects anything that is not a
// plausible product code. An empty list is an error: `-stocks ""` is a mistake,
// not a request to validate nothing.
func parseStockCodes(raw string) ([]string, error) {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == ';'
	})
	seen := make(map[string]struct{}, len(fields))
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		code := strings.ToUpper(strings.TrimSpace(f))
		if code == "" {
			continue
		}
		if !stockCodePattern.MatchString(code) {
			return nil, fmt.Errorf("invalid stock code %q (want 1-5 characters, A-Z or 0-9)", f)
		}
		if _, dup := seen[code]; dup {
			continue
		}
		seen[code] = struct{}{}
		out = append(out, code)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("-stocks was set but no valid codes were found")
	}
	if len(out) > maxStockCodes {
		return nil, fmt.Errorf("too many stock codes: %d (max %d)", len(out), maxStockCodes)
	}
	return out, nil
}

// Diff statuses. These describe what the sync WOULD do to the row, not what the
// file happens to contain.
const (
	// statusNew: the file has the row and the DB does not — an INSERT.
	statusNew = "new"
	// statusUnchanged: the file and the DB agree on every column the upsert
	// would write — the write is a no-op.
	statusUnchanged = "unchanged"
	// statusChanged: the DB has the row and at least one written column differs.
	statusChanged = "changed"
	// statusMissingFromFile: the DB has a row for this (code, date) but the
	// file we parsed for that date does not mention the code at all. ASIC drops
	// a stock from the file when it has no reportable short position, so this is
	// informative, not necessarily wrong — but it is the shape of a bad parse.
	statusMissingFromFile = "missing-from-file"
)

// stockValues is one (code, date) observation, from either side of the diff.
type stockValues struct {
	Product                string  `json:"product"`
	ReportedShortPositions float64 `json:"reported_short_positions"`
	TotalProductInIssue    float64 `json:"total_product_in_issue"`
	Percent                float64 `json:"percent"`
}

func valuesOf(r shortsRow) stockValues {
	return stockValues{
		Product:                r.Product,
		ReportedShortPositions: r.ReportedShortPositions,
		TotalProductInIssue:    r.TotalProductInIssue,
		Percent:                r.Percent,
	}
}

// stockObservation is one row of the operator-facing report.
type stockObservation struct {
	Code string `json:"code"`
	Date string `json:"date"`
	// File is the ASIC file the date came from ("" for a missing-from-file row
	// whose date produced no parsed file).
	File string `json:"file"`
	// Status is one of the status* constants above.
	Status string `json:"status"`
	// FileValues / DBValues are nil when that side has no row.
	FileValues *stockValues `json:"file_values,omitempty"`
	DBValues   *stockValues `json:"db_values,omitempty"`
	// ChangedFields names the columns that differ AND that the upsert writes.
	// PRODUCT is deliberately never listed: ON CONFLICT does not refresh it (see
	// upsertShortsSQL), so a renamed product is not a change the sync would make.
	ChangedFields []string `json:"changed_fields,omitempty"`
	WouldInsert   bool     `json:"would_insert"`
	WouldUpdate   bool     `json:"would_update"`
	// WouldSkip is set on a missing-from-file row: the sync writes nothing for
	// it, and in particular does NOT delete the existing row.
	WouldSkip bool `json:"would_skip,omitempty"`
}

// stocksReport is the `stocks` section of a validation summary.
type stocksReport struct {
	// Requested is the normalised code list, in the order supplied.
	Requested []string `json:"requested"`
	// NotFound lists requested codes that appeared in NO parsed file of the
	// window. This is reported explicitly rather than by absence: "BHP is
	// missing" and "BHP was never asked for" must not look the same.
	//
	// It means "absent from the files", which is a real and useful signal (a
	// delisted or never-shorted ticker). It must NOT be read as "there was no
	// window" — that case is FilesInWindow == 0 / WindowEmpty, which is a
	// different problem with a different fix, and every renderer must branch on
	// WindowEmpty FIRST.
	NotFound []string `json:"not_found"`
	// FilesInWindow is how many parsed files the diff covers, and WindowEmpty
	// is the same fact stated as the alarm it is: with no files, the report
	// says nothing about any code and NotFound is vacuous.
	FilesInWindow int  `json:"files_in_window"`
	WindowEmpty   bool `json:"window_empty"`
	// Observations is the per-code, per-date diff, sorted by code then date.
	Observations []stockObservation `json:"observations"`
	// Counts summarises Observations by status, so the console can render a
	// headline without re-deriving it.
	Counts map[string]int `json:"counts"`
	// DBRowsInWindow is how many rows the comparison SELECT returned FOR THE
	// REQUESTED CODES over the window — deliberately not "all rows in the
	// window".
	//
	// The choice matters because the number is read next to the observations.
	// Scoped to the codes it is a direct denominator for them: "we asked about
	// 2 codes over 5 dates, the DB holds 10 of those 10 rows". Counting every
	// row in the window instead would put a ~10,000 next to a two-row table,
	// answering a question nobody asked (that is what the run-level
	// rows_parsed / would_update already cover) and costing a full-window scan
	// to produce. Zero here with non-zero file rows means the whole window is
	// genuinely new for these codes.
	DBRowsInWindow int `json:"db_rows_in_window"`
}

// validationWindow describes the file window a `-stocks` run scanned.
//
// It exists because a validation run's window is NOT the sync's window, and a
// report that did not say so would be read as a statement about tonight's
// ingest. A validation run deliberately re-parses days that are already in the
// database — that is the whole point: with everything ingested, every row comes
// back `unchanged`, which is the positive signal ("the file says 1.35%, the DB
// says 1.35%") an operator asking "does the pipeline work for BHP?" wants.
//
// Consequence worth stating once: the summary's top-level would_insert /
// would_update / would_revalidate describe what a sync WOULD do over THIS
// window if it were run against it, not what tonight's scheduled sync will do.
type validationWindow struct {
	// Days is the -validate-days value in force: how many of the most recent
	// PUBLISHED ASIC dates were scanned (not calendar days — see
	// selectRecentFiles).
	Days int `json:"days"`
	// From / To are the earliest and latest observation dates in the window
	// ("" when the window is empty).
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
	// Files is every selected file name, in the index's own order.
	Files []string `json:"files"`
	// IgnoredCutoff is the date a NORMAL sync would have started after
	// (MAX("DATE") + 1 day), recorded to make the divergence explicit. Empty
	// when the shorts table is empty.
	IgnoredCutoff string `json:"ignored_cutoff,omitempty"`
	// Problem is set ONLY when the window came out EMPTY — the one genuinely
	// broken outcome of a validation run, and the one an operator must not
	// confuse with "the code was not in the files". It carries the reason in
	// plain words (index fetch failed / the index is empty).
	Problem string `json:"problem,omitempty"`
}

// stockFileRows is the requested codes' rows captured from ONE parsed file,
// plus the codes that file did not contain. Accumulated during the run so the
// report can be built once, after the DB comparison read.
type stockFileRows struct {
	Date time.Time
	File string
	Rows []shortsRow
}

// filterRows keeps only the rows whose product code is in `want`.
func filterRows(rows []shortsRow, want map[string]struct{}) []shortsRow {
	if len(want) == 0 {
		return nil
	}
	out := make([]shortsRow, 0, len(want))
	for _, r := range rows {
		if _, ok := want[r.ProductCode]; ok {
			out = append(out, r)
		}
	}
	return out
}

// codeSet builds a lookup set from a code slice.
func codeSet(codes []string) map[string]struct{} {
	set := make(map[string]struct{}, len(codes))
	for _, c := range codes {
		set[c] = struct{}{}
	}
	return set
}

// buildStocksReport diffs the parsed files against the current DB rows.
//
// Pure by design — the whole diff contract is testable without a database, an
// HTTP client or a clock.
//
//   - files: the per-file capture of the requested codes' rows, any order.
//   - db:    current rows keyed by rowKey(date, code), for the requested codes
//     over the same window.
func buildStocksReport(codes []string, files []stockFileRows, db map[string]shortsRow) stocksReport {
	rep := stocksReport{
		Requested:      append([]string(nil), codes...),
		NotFound:       []string{},
		Observations:   []stockObservation{},
		Counts:         map[string]int{},
		DBRowsInWindow: len(db),
		FilesInWindow:  len(files),
		WindowEmpty:    len(files) == 0,
	}
	want := codeSet(codes)

	// seenInAnyFile drives NotFound; seenKey stops a code/date appearing twice
	// when ASIC republishes a date under two file versions (the later file in
	// index order wins the upsert, so the FIRST one processed is authoritative
	// for the diff, exactly as classify() treats a duplicate key).
	seenInAnyFile := map[string]struct{}{}
	seenKey := map[string]struct{}{}

	for _, f := range files {
		date := f.Date.Format("2006-01-02")
		inFile := map[string]struct{}{}

		for _, r := range f.Rows {
			if _, ok := want[r.ProductCode]; !ok {
				continue
			}
			inFile[r.ProductCode] = struct{}{}
			seenInAnyFile[r.ProductCode] = struct{}{}

			key := rowKey(truncateDay(r.Date), r.ProductCode)
			if _, dup := seenKey[key]; dup {
				continue
			}
			seenKey[key] = struct{}{}

			obs := stockObservation{
				Code:       r.ProductCode,
				Date:       r.Date.Format("2006-01-02"),
				File:       f.File,
				FileValues: ptrValues(valuesOf(r)),
			}
			cur, exists := db[key]
			if !exists {
				obs.Status = statusNew
				obs.WouldInsert = true
			} else {
				obs.DBValues = ptrValues(valuesOf(cur))
				obs.WouldUpdate = true
				obs.ChangedFields = changedFields(cur, r)
				if len(obs.ChangedFields) == 0 {
					obs.Status = statusUnchanged
				} else {
					obs.Status = statusChanged
				}
			}
			rep.Observations = append(rep.Observations, obs)
		}

		// A requested code the DB holds for this date but the file omits.
		for _, code := range codes {
			if _, ok := inFile[code]; ok {
				continue
			}
			key := rowKey(truncateDay(f.Date), code)
			if _, dup := seenKey[key]; dup {
				continue
			}
			cur, exists := db[key]
			if !exists {
				continue
			}
			seenKey[key] = struct{}{}
			rep.Observations = append(rep.Observations, stockObservation{
				Code:      code,
				Date:      date,
				File:      f.File,
				Status:    statusMissingFromFile,
				DBValues:  ptrValues(valuesOf(cur)),
				WouldSkip: true,
			})
		}
	}

	for _, code := range codes {
		if _, ok := seenInAnyFile[code]; !ok {
			rep.NotFound = append(rep.NotFound, code)
		}
	}

	sort.SliceStable(rep.Observations, func(i, j int) bool {
		if rep.Observations[i].Code != rep.Observations[j].Code {
			return rep.Observations[i].Code < rep.Observations[j].Code
		}
		return rep.Observations[i].Date < rep.Observations[j].Date
	})
	for _, o := range rep.Observations {
		rep.Counts[o.Status]++
	}
	return rep
}

func ptrValues(v stockValues) *stockValues { return &v }

// floatEpsilon is the tolerance for "the same number".
//
// The file value is parsed from decimal text and the DB value comes back as a
// float8; both are IEEE doubles of the same decimal, so they agree exactly in
// practice. The epsilon exists so a future round-trip through a different
// numeric type cannot turn every row in the report amber.
const floatEpsilon = 1e-9

func sameFloat(a, b float64) bool {
	if a == b {
		return true
	}
	diff := math.Abs(a - b)
	if diff <= floatEpsilon {
		return true
	}
	scale := math.Max(math.Abs(a), math.Abs(b))
	return diff <= floatEpsilon*scale
}

// changedFields lists the columns the upsert WOULD rewrite with a new value.
// It intentionally mirrors upsertShortsSQL's DO UPDATE SET list — PRODUCT is
// not in it, so a product rename is visible in the report's values but is not a
// "change".
func changedFields(current, incoming shortsRow) []string {
	var out []string
	if !sameFloat(current.ReportedShortPositions, incoming.ReportedShortPositions) {
		out = append(out, "reported_short_positions")
	}
	if !sameFloat(current.TotalProductInIssue, incoming.TotalProductInIssue) {
		out = append(out, "total_product_in_issue")
	}
	if !sameFloat(current.Percent, incoming.Percent) {
		out = append(out, "percent")
	}
	return out
}
