package shortdatasync

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"time"
)

// shadowSummary is the machine-readable result of a `-shadow` run: what the
// pipeline WOULD have written, with nothing written. It is emitted as one JSON
// object on STDOUT (every log line goes to stderr), so a shadow run can be
// diffed against the Python job's actual writes — see the package README.
type shadowSummary struct {
	// Mode is always "shadow"; it makes a captured stream self-describing.
	Mode string `json:"mode"`
	// SchemaVersion is the version of THIS contract. A consumer that does not
	// recognise the value should refuse to interpret the payload rather than
	// guess — see shadowSchemaVersion.
	SchemaVersion int `json:"schema_version"`
	// GeneratedAt is the run's wall clock (UTC, RFC3339).
	GeneratedAt string `json:"generated_at"`
	// SyncDays is the -days window in force.
	SyncDays int `json:"sync_days"`
	// LastShortsDate is MAX("DATE") in the shorts table, "" when empty.
	LastShortsDate string `json:"last_shorts_date"`
	// CutoffDate is the yyyymmdd index cutoff the file selection used.
	CutoffDate int `json:"cutoff_date"`
	// AlreadyUpToDate is true when the run short-circuits (last date >= today).
	AlreadyUpToDate bool `json:"already_up_to_date"`
	// FilesSelected / FilesParsed count the index entries chosen and the ones
	// that produced rows (a 404 or an unparseable file is selected-not-parsed).
	FilesSelected int `json:"files_selected"`
	FilesParsed   int `json:"files_parsed"`
	// FilesFailed lists the files that could not be downloaded or parsed.
	FilesFailed []shadowFileError `json:"files_failed"`
	// Dates is the per-observation-date breakdown, oldest first.
	Dates []shadowDate `json:"dates"`
	// Totals across every date.
	RowsParsed   int `json:"rows_parsed"`
	WouldInsert  int `json:"would_insert"`
	WouldUpdate  int `json:"would_update"`
	DuplicateKey int `json:"duplicate_keys"`
	// Checksum is sha256 over the sorted "date|code|positions" tuples — the
	// single value to compare between the Go shadow run and the Python's
	// actual rows (the README has the matching SQL).
	Checksum string `json:"checksum"`
	// WouldRefreshMVs / WouldRevalidate / WouldSyncAlgolia record the side
	// effects that were suppressed.
	WouldRefreshMVs   bool `json:"would_refresh_materialized_views"`
	WouldRevalidate   bool `json:"would_revalidate"`
	WouldSyncAlgolia  bool `json:"would_sync_algolia"`
	WouldRecordStatus bool `json:"would_record_sync_status"`

	// Stocks is present ONLY on a `-stocks` validation run: the per-code,
	// per-date diff of file vs database. Absent (omitted) on a plain shadow run,
	// so the parity contract above is byte-for-byte unchanged.
	Stocks *stocksReport `json:"stocks,omitempty"`

	// Artifact records where the durable copy of this report was stored — or
	// why it was not. Like Stocks, present ONLY on a `-stocks` validation run;
	// a plain shadow run writes no object and carries no such field. See
	// artifact.go.
	Artifact *validationArtifact `json:"artifact,omitempty"`

	// rows accumulates every parsed row so the run-level checksum can be taken
	// once, at the end. Unexported: it is the INPUT to `checksum`, not part of
	// the emitted contract (a full row dump would be a licence-free but large
	// and needlessly diff-noisy artefact).
	rows []shortsRow

	// stockFilter is the requested code set (nil on a plain shadow run), and
	// stockFiles is the per-file capture of just those codes. Both unexported:
	// they are the INPUT to buildStocksReport, not part of the contract.
	stockFilter map[string]struct{}
	stockFiles  []stockFileRows
	// cutoff is the window start the file selection used, retained so the
	// comparison SELECT can be scoped to exactly the window that was parsed.
	cutoff time.Time
}

// shadowFileError names a file the run could not use.
type shadowFileError struct {
	File  string `json:"file"`
	Error string `json:"error"`
}

// shadowDate is one observation date's counts.
type shadowDate struct {
	Date        string `json:"date"`
	File        string `json:"file"`
	RowsParsed  int    `json:"rows_parsed"`
	WouldInsert int    `json:"would_insert"`
	WouldUpdate int    `json:"would_update"`
	Checksum    string `json:"checksum"`
}

// checksumRows is the canonical fingerprint of a row set: sha256 over
// "yyyy-mm-dd|CODE|positions" lines, SORTED, so it is independent of file order
// and of the order rows appear inside a file.
//
// positions is formatted with strconv 'f'/-1 (shortest round-trip), which
// matches how Postgres renders a float8 for the comparison query in the README.
func checksumRows(rows []shortsRow) string {
	lines := make([]string, 0, len(rows))
	for _, r := range rows {
		lines = append(lines, fmt.Sprintf("%s|%s|%s",
			r.Date.Format("2006-01-02"),
			r.ProductCode,
			strconv.FormatFloat(r.ReportedShortPositions, 'f', -1, 64),
		))
	}
	sort.Strings(lines)
	h := sha256.New()
	for _, l := range lines {
		_, _ = io.WriteString(h, l)
		_, _ = io.WriteString(h, "\n")
	}
	return hex.EncodeToString(h.Sum(nil))
}

// classify splits a file's rows into would-insert and would-update against the
// keys already present, and counts keys repeated WITHIN the batch (a duplicate
// key means the later row wins the upsert, exactly as in a real run).
func classify(rows []shortsRow, existing map[string]struct{}, seen map[string]struct{}) (insert, update, dup int) {
	for _, r := range rows {
		k := rowKey(r.Date, r.ProductCode)
		if _, ok := seen[k]; ok {
			dup++
			continue
		}
		seen[k] = struct{}{}
		if _, ok := existing[k]; ok {
			update++
		} else {
			insert++
		}
	}
	return insert, update, dup
}

// writeJSON emits the summary as indented JSON with a trailing newline.
func (s shadowSummary) writeJSON(w io.Writer) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(s)
}

// writeValidationLine emits the summary as ONE compact, prefixed line.
//
// This is the human-debuggable form: Cloud Logging splits container stdout per
// newline, so the indented block above cannot be read back from logs without
// reassembling entries in order, whereas one prefixed line greps cleanly. It is
// NOT how the admin console retrieves the report any more — that is the GCS
// artifact (artifact.go). See validationLinePrefix.
func (s shadowSummary) writeValidationLine(w io.Writer) error {
	payload, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if _, err := w.Write([]byte(validationLinePrefix)); err != nil {
		return err
	}
	if _, err := w.Write(payload); err != nil {
		return err
	}
	_, err = w.Write([]byte("\n"))
	return err
}

// newShadowSummary seeds the invariant fields.
func newShadowSummary(now time.Time, days int) shadowSummary {
	return shadowSummary{
		Mode:          "shadow",
		SchemaVersion: shadowSchemaVersion,
		GeneratedAt:   now.UTC().Format(time.RFC3339),
		SyncDays:      days,
		FilesFailed:   []shadowFileError{},
		Dates:         []shadowDate{},
	}
}
