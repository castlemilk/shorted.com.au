package influence

// Shared AEC Transparency Register primitives.
//
// Two consumers sit on top of these: the industry-intelligence evidence feed
// (aec.go, -mode aec) and the political funding layer (aec_donations.go,
// -mode aec-donations). They read the SAME bulk exports with the SAME quirks,
// so the fetch, archive-walking, financial-year, date, amount and entity-name
// handling live here once. Forking them would let one path silently learn a
// quirk the other still trips over.
//
// The quirks, all measured against the live exports:
//
//   - The download endpoints are GET-ONLY. A HEAD returns HTTP 500 (allow: GET),
//     so a reachability probe must GET, or hit the landing page instead.
//   - The zips are REGENERATED CONTINUOUSLY as amendments land. A published
//     financial year is never frozen, so every consumer must be idempotent.
//   - Some members carry a UTF-8 BOM.
//   - Names carry leading/trailing whitespace and non-breaking spaces (U+00A0).
//   - Financial-year labels come in TWO formats: '1998-1999' and '2011-12'.
//   - Transaction dates are d/mm/yyyy, and some cells are empty.
//   - Byte-identical rows are LEGITIMATE repeated transactions, so consumers
//     count occurrences rather than deduplicating.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// The three bulk exports. Note AllElection**s**Data is PLURAL — the
	// singular spelling 404s, and it is the easiest URL in the set to get wrong.
	aecAllAnnualDataURL     = "https://transparency.aec.gov.au/Download/AllAnnualData"
	aecAllElectionsDataURL  = "https://transparency.aec.gov.au/Download/AllElectionsData"
	aecAllReferendumDataURL = "https://transparency.aec.gov.au/Download/AllReferendumData"
	aecDownloadPage         = "https://transparency.aec.gov.au/Download"

	// aecLicence is the licence recorded on every stored AEC row. The AEC
	// copyright policy applies CC BY 4.0 to AEC material (Crown copyright,
	// © Commonwealth of Australia); attribution must not imply AEC endorsement.
	aecLicence = "CC-BY-4.0"

	// aecSnapshotDirEnv points the fetcher at a local copy of the exports so a
	// development run never re-downloads from the AEC. Either
	// `<dir>/AllAnnualData.zip` or a `<dir>/AllAnnualData/` directory of CSVs
	// is accepted.
	aecSnapshotDirEnv = "AEC_SNAPSHOT_DIR"

	// aecThresholdNote annotates FY2026-27+ records: transitional rules apply
	// from 1 July 2026 and a $5,000 disclosure threshold commences 1 January
	// 2027 (Electoral Legislation Amendment (Electoral Reform) Act 2025), so
	// totals are not comparable across the boundary.
	aecThresholdNote = "Disclosure threshold changed 1 Jul 2026: transitional rules apply from 1 July 2026 and a $5,000 disclosure threshold commences 1 January 2027 (Electoral Legislation Amendment (Electoral Reform) Act 2025). Figures are not directly comparable with earlier financial years."
)

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

// aecArchive is one bulk export reduced to its CSV members, keyed by lower-cased
// base filename. Whether it came from the network, a local zip or a directory of
// extracted CSVs is invisible to the parsers.
type aecArchive struct {
	Name      string
	SourceURL string
	Files     map[string][]byte
}

// aecSnapshotName maps a download URL to the snapshot basename an operator
// would have on disk ("AllAnnualData").
func aecSnapshotName(downloadURL string) string {
	idx := strings.LastIndex(downloadURL, "/")
	if idx < 0 || idx == len(downloadURL)-1 {
		return downloadURL
	}
	return downloadURL[idx+1:]
}

// fetchAECArchive returns the named bulk export. When AEC_SNAPSHOT_DIR is set it
// reads from disk and NEVER touches the network — development and test runs work
// off a downloaded corpus rather than re-crawling a government site. SourceURL
// stays the canonical AEC URL either way, because that is what we cite and what
// a reader should be able to check.
func fetchAECArchive(ctx context.Context, downloadURL string) (*aecArchive, error) {
	name := aecSnapshotName(downloadURL)
	if dir := strings.TrimSpace(os.Getenv(aecSnapshotDirEnv)); dir != "" {
		archive, err := loadAECArchiveFromDisk(dir, name, downloadURL)
		if err != nil {
			return nil, fmt.Errorf("load %s from %s=%s: %w", name, aecSnapshotDirEnv, dir, err)
		}
		return archive, nil
	}
	data, err := downloadResource(ctx, downloadURL)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", name, err)
	}
	return newAECArchiveFromZip(name, downloadURL, data)
}

// loadAECArchiveFromDisk accepts either `<dir>/<name>.zip` or a `<dir>/<name>/`
// directory of extracted CSVs, so a recon corpus works untouched in both shapes.
func loadAECArchiveFromDisk(dir, name, sourceURL string) (*aecArchive, error) {
	zipPath := filepath.Join(dir, name+".zip")
	if data, err := os.ReadFile(zipPath); err == nil {
		return newAECArchiveFromZip(name, sourceURL, data)
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	csvDir := filepath.Join(dir, name)
	entries, err := os.ReadDir(csvDir)
	if err != nil {
		return nil, fmt.Errorf("neither %s nor %s/ is readable: %w", zipPath, csvDir, err)
	}
	files := map[string][]byte{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".csv") {
			continue
		}
		content, err := os.ReadFile(filepath.Join(csvDir, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", entry.Name(), err)
		}
		files[strings.ToLower(entry.Name())] = content
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no CSV members in %s", csvDir)
	}
	return &aecArchive{Name: name, SourceURL: sourceURL, Files: files}, nil
}

func newAECArchiveFromZip(name, sourceURL string, data []byte) (*aecArchive, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("open %s archive: %w", name, err)
	}
	files := map[string][]byte{}
	for _, f := range zr.File {
		base := strings.ToLower(filepath.Base(f.Name))
		if !strings.HasSuffix(base, ".csv") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, fmt.Errorf("open %q: %w", f.Name, err)
		}
		content, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return nil, fmt.Errorf("read %q: %w", f.Name, err)
		}
		files[base] = content
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no CSV members in %s archive", name)
	}
	return &aecArchive{Name: name, SourceURL: sourceURL, Files: files}, nil
}

// member returns the archive CSV whose base name contains match (lower-cased).
// The AEC has renamed members before, so callers match on a substring rather
// than pinning an exact filename.
func (a *aecArchive) member(match string) ([]byte, bool) {
	match = strings.ToLower(match)
	if content, ok := a.Files[match]; ok {
		return content, true
	}
	// Deterministic order so an ambiguous substring picks the same file twice.
	names := make([]string, 0, len(a.Files))
	for name := range a.Files {
		names = append(names, name)
	}
	sortStrings(names)
	for _, name := range names {
		if strings.Contains(name, match) {
			return a.Files[name], true
		}
	}
	return nil, false
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// ---------------------------------------------------------------------------
// CSV reading
// ---------------------------------------------------------------------------

func newAECCSVReader(data []byte) *csv.Reader {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF}) // some exports carry a UTF-8 BOM
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	reader.TrimLeadingSpace = true
	return reader
}

// cleanAECText normalises the whitespace damage endemic to these exports:
// non-breaking spaces become ordinary ones and the result is trimmed. Internal
// spacing is left ALONE — this value is stored verbatim beside its normalised
// form, and collapsing runs here would quietly rewrite a declared name.
func cleanAECText(s string) string {
	s = strings.ReplaceAll(s, "\u00a0", " ") // non-breaking space
	s = strings.ReplaceAll(s, "\ufeff", "")  // stray BOM mid-field
	return strings.TrimSpace(s)
}

// readAECColumn reads and cleans one cell, tolerating short rows.
func readAECColumn(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	return cleanAECText(row[idx])
}

// ---------------------------------------------------------------------------
// Financial years, dates, amounts, names
// ---------------------------------------------------------------------------

var aecYearStartRe = regexp.MustCompile(`(\d{4})`)

// parseAECFinancialYear reads both AEC financial-year label formats
// ("1998-1999" and "2011-12"): the first 4-digit year is the start year, and
// the financial year ends the following calendar year.
func parseAECFinancialYear(s string) (int, bool) {
	m := aecYearStartRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, false
	}
	start, err := strconv.Atoi(m[1])
	if err != nil || start < 1900 || start > 2200 {
		return 0, false
	}
	return start + 1, true
}

// parseAECDate parses the strictly d/mm/yyyy transaction dates; empty cells
// return nil so callers fall back to the financial-year period end.
func parseAECDate(s string) *time.Time {
	s = cleanAECText(s)
	if s == "" {
		return nil
	}
	for _, layout := range []string{"2/01/2006", "02/01/2006"} {
		if t, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
			return &t
		}
	}
	return nil
}

// parseAECAmountCents converts a source dollar figure to integer cents. The AEC
// publishes whole dollars (measured: zero decimal values across ~209k amount
// cells), but a decimal is still parsed exactly rather than truncated, and
// negatives are preserved — refunds and corrections are real declared rows.
func parseAECAmountCents(s string) (int64, bool) {
	v, ok := parseAmount(s)
	if !ok {
		return 0, false
	}
	// Round half away from zero so a hypothetical 0.005 never lands on the wrong
	// cent through float representation.
	if v < 0 {
		return int64(v*100 - 0.5), true
	}
	return int64(v*100 + 0.5), true
}

var (
	aecNonAlphaNumeric = regexp.MustCompile(`[^A-Z0-9]+`)
	aecCorporateSuffix = regexp.MustCompile(` (LIMITED|LTD|GROUP|HOLDINGS|CORPORATION|PLC|TRUST|PTY|PROPRIETARY)$`)
)

// normalizeAECEntityName is the Go port of store.go's normExpr: upper-case,
// punctuation → single space, then strip a trailing corporate suffix TWICE
// (so "Woodside Energy Group Ltd" → "WOODSIDE ENERGY GROUP" → "WOODSIDE ENERGY").
// It MUST stay byte-identical in behaviour to the SQL, because the company match
// layer normalises company-metadata in SQL and these names in Go, then joins
// the two on equality.
func normalizeAECEntityName(s string) string {
	s = strings.TrimSpace(aecNonAlphaNumeric.ReplaceAllString(strings.ToUpper(s), " "))
	s = strings.TrimSpace(aecCorporateSuffix.ReplaceAllString(s, ""))
	s = strings.TrimSpace(aecCorporateSuffix.ReplaceAllString(s, ""))
	return s
}
