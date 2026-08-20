package shortdatasync

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// ASIC endpoints. Unchanged from comprehensive_daily_sync.py (ASIC_DATA_URL /
// ASIC_BASE_URL).
const (
	asicIndexURL = "https://download.asic.gov.au/short-selling/short-selling-data.json"
	asicBaseURL  = "https://download.asic.gov.au/short-selling/"
)

// HTTP timeouts, matching the Python httpx clients: 30s for the index, 60s per
// CSV.
const (
	indexTimeout = 30 * time.Second
	fileTimeout  = 60 * time.Second
)

// asicFile is one entry of the ASIC index JSON: {"date":20260814,"version":"001"}.
type asicFile struct {
	Date    int    `json:"date"`
	Version string `json:"version"`
}

// downloadURL builds the CSV URL for an index entry. Byte-identical to
// generate_download_url(): RR<yyyymmdd>-<version>-SSDailyAggShortPos.csv.
func (f asicFile) downloadURL() string {
	d := strconv.Itoa(f.Date)
	if len(d) != 8 {
		// The Python string-sliced blindly; keep the same (degenerate) URL
		// rather than inventing a different failure mode. A bad entry 404s and
		// is skipped by the caller.
		return fmt.Sprintf("%sRR%s-%s-SSDailyAggShortPos.csv", asicBaseURL, d, f.Version)
	}
	return fmt.Sprintf("%sRR%s%s%s-%s-SSDailyAggShortPos.csv", asicBaseURL, d[:4], d[4:6], d[6:], f.Version)
}

// fileName is the last path segment of the download URL.
func (f asicFile) fileName() string {
	u := f.downloadURL()
	return u[strings.LastIndex(u, "/")+1:]
}

// fetchIndex downloads the ASIC file index.
//
// A failure is NOT fatal in the Python (it logs and returns an empty list, so
// the run continues and reports 0 records). Here it is returned as an error and
// the caller decides — the job treats it as "no files" exactly like the Python,
// but a shadow run can surface it.
func fetchIndex(ctx context.Context, client *http.Client) ([]asicFile, error) {
	ctx, cancel := context.WithTimeout(ctx, indexTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asicIndexURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("asic index: unexpected status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var files []asicFile
	if err := json.Unmarshal(body, &files); err != nil {
		return nil, fmt.Errorf("asic index: decode: %w", err)
	}
	return files, nil
}

// selectFiles keeps the index entries at or after cutoff (an inclusive
// yyyymmdd integer), preserving the index's own order — ASIC serves it newest
// first and the Python processed it in that order, which decides which file
// wins when two versions of one date are present (the later-processed row's
// upsert wins).
func selectFiles(files []asicFile, cutoff int) []asicFile {
	out := make([]asicFile, 0, len(files))
	for _, f := range files {
		if f.Date >= cutoff {
			out = append(out, f)
		}
	}
	return out
}

// yyyymmdd renders a date as the integer form the ASIC index uses.
func yyyymmdd(d time.Time) int {
	return d.Year()*10000 + int(d.Month())*100 + d.Day()
}

// shortsRow is one parsed CSV record, ready for the shorts table.
type shortsRow struct {
	Date                   time.Time
	Product                string
	ProductCode            string
	ReportedShortPositions float64
	TotalProductInIssue    float64
	Percent                float64
}

// Canonical (normalised) column names in the ASIC daily aggregate file.
const (
	// There is no DATE column: the observation date comes from the file name.
	colProduct = "PRODUCT"
	colCode    = "PRODUCT_CODE"
	colShort   = "REPORTED_SHORT_POSITIONS"
	colIssue   = "TOTAL_PRODUCT_IN_ISSUE"
	colPercent = "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
)

// errNoUsableHeader reports a file whose header does not carry the columns the
// shorts table needs. The Python surfaced this as a per-row KeyError storm that
// silently produced zero inserts; naming it makes the same outcome visible.
var errNoUsableHeader = errors.New("csv header is missing required columns")

// parseFile turns one downloaded CSV into rows.
//
// Quirks preserved from the Python (pandas) path:
//   - the observation date comes from the FILENAME (the digits before the first
//     "-"), never from a column;
//   - headers are normalised upper → trim → " "→"_" → "%"→"PERCENT", which is
//     what turns "% of Total Product in Issue Reported as Short Positions" into
//     PERCENT_OF_…;
//   - PRODUCT and PRODUCT_CODE are whitespace-trimmed;
//   - a row that cannot be parsed is dropped and the rest of the file still
//     loads (the Python wrapped every insert in its own try/except).
//
// Two DELIBERATE divergences, both strictly more capable and both invisible on
// the daily path (every file inside the sync window is modern comma/UTF-8):
//
//  1. encoding is detected (UTF-8/UTF-16 BOM, UTF-8 validity, else CP1252)
//     instead of trusting the HTTP charset; and
//  2. the delimiter is sniffed (TAB or comma).
//
// Legacy ASIC files (roughly pre-2023) are UTF-16LE + TAB, which the deployed
// script parsed as a single unnamed column and silently skipped. A deep
// backfill (`-days 5000`) therefore ingests MORE than the Python would; a
// 7-day run is identical.
func parseFile(fileName string, body []byte) ([]shortsRow, error) {
	obsDate, err := dateFromFileName(fileName)
	if err != nil {
		return nil, err
	}

	text := decodeBytes(body)
	r := csv.NewReader(strings.NewReader(text))
	r.Comma = sniffDelimiter(text)
	r.FieldsPerRecord = -1 // ragged rows are dropped per-row, not fatal
	r.LazyQuotes = true

	header, err := r.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, errNoUsableHeader
		}
		return nil, err
	}
	idx := map[string]int{}
	for i, h := range header {
		idx[normaliseHeader(h)] = i
	}
	for _, want := range []string{colProduct, colCode, colShort, colIssue, colPercent} {
		if _, ok := idx[want]; !ok {
			return nil, fmt.Errorf("%w: %s", errNoUsableHeader, want)
		}
	}

	var rows []shortsRow
	for {
		rec, err := r.Read()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			// A malformed line is dropped, like the Python's per-row except.
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				continue
			}
			return rows, err
		}
		row, ok := rowFromRecord(rec, idx, obsDate)
		if !ok {
			continue
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// rowFromRecord maps one CSV record onto a shortsRow, reporting false for
// records the Python would have dropped (short row, unparseable number).
func rowFromRecord(rec []string, idx map[string]int, obsDate time.Time) (shortsRow, bool) {
	get := func(col string) (string, bool) {
		i, ok := idx[col]
		if !ok || i >= len(rec) {
			return "", false
		}
		return rec[i], true
	}
	product, ok := get(colProduct)
	if !ok {
		return shortsRow{}, false
	}
	code, ok := get(colCode)
	if !ok {
		return shortsRow{}, false
	}
	shortRaw, ok := get(colShort)
	if !ok {
		return shortsRow{}, false
	}
	issueRaw, ok := get(colIssue)
	if !ok {
		return shortsRow{}, false
	}
	pctRaw, ok := get(colPercent)
	if !ok {
		return shortsRow{}, false
	}
	shortPos, ok := parseNumeric(shortRaw)
	if !ok {
		return shortsRow{}, false
	}
	issue, ok := parseNumeric(issueRaw)
	if !ok {
		return shortsRow{}, false
	}
	pct, ok := parseNumeric(pctRaw)
	if !ok {
		return shortsRow{}, false
	}
	return shortsRow{
		Date:                   obsDate,
		Product:                strings.TrimSpace(product),
		ProductCode:            strings.TrimSpace(code),
		ReportedShortPositions: shortPos,
		TotalProductInIssue:    issue,
		Percent:                pct,
	}, true
}

// parseNumeric parses an ASIC numeric cell. Blank means zero (the Python's
// `float(x or 0)`), thousands separators and surrounding whitespace are
// tolerated, and anything else drops the row.
//
// Divergence worth knowing at shadow time: pandas turns a BLANK numeric cell
// into NaN, and `NaN or 0` is NaN, so the Python inserted NaN where this
// inserts 0. No blank has been observed in the daily files.
func parseNumeric(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, ",", "")
	if s == "" {
		return 0, true
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

// normaliseHeader reproduces the pandas column normalisation chain.
func normaliseHeader(h string) string {
	// decodeBytes strips a leading BOM, but a stray U+FEFF in a re-encoded
	// header would otherwise make the first column name unmatchable.
	h = strings.TrimPrefix(h, "\ufeff")
	h = strings.ToUpper(h)
	h = strings.TrimSpace(h)
	h = strings.ReplaceAll(h, " ", "_")
	return strings.ReplaceAll(h, "%", "PERCENT")
}

// dateFromFileName extracts the observation date the way the Python did: take
// the segment before the first "-", keep its digits, parse as yyyymmdd.
// "RR20260814-001-SSDailyAggShortPos.csv" → 2026-08-14.
func dateFromFileName(name string) (time.Time, error) {
	head, _, _ := strings.Cut(name, "-")
	var digits strings.Builder
	for _, r := range head {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}
	d, err := time.Parse("20060102", digits.String())
	if err != nil {
		return time.Time{}, fmt.Errorf("cannot derive date from file name %q: %w", name, err)
	}
	return d, nil
}

// sniffDelimiter picks TAB or comma from the header line. Modern files are
// comma-separated; the legacy UTF-16 files are tab-separated.
func sniffDelimiter(text string) rune {
	line := text
	if i := strings.IndexAny(text, "\r\n"); i >= 0 {
		line = text[:i]
	}
	if strings.Count(line, "\t") > strings.Count(line, ",") {
		return '\t'
	}
	return ','
}

// decodeBytes converts a downloaded file to UTF-8 text.
//
// Order: BOM (UTF-8 / UTF-16LE / UTF-16BE) → valid UTF-8 as-is → CP1252. This
// is the Go stand-in for chardet, minus the dependency: ASIC has only ever
// shipped UTF-16LE-with-BOM (legacy) and UTF-8 (current), and CP1252 is the
// safe superset for a stray Latin-1 byte since every byte maps to a rune.
func decodeBytes(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF:
		return string(b[3:])
	case len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE:
		return decodeUTF16(b[2:], false)
	case len(b) >= 2 && b[0] == 0xFE && b[1] == 0xFF:
		return decodeUTF16(b[2:], true)
	case utf8.Valid(b):
		return string(b)
	default:
		return decodeCP1252(b)
	}
}

// decodeUTF16 decodes UTF-16 code units (BOM already stripped). A trailing odd
// byte is dropped rather than producing a replacement char.
func decodeUTF16(b []byte, bigEndian bool) string {
	units := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		if bigEndian {
			units = append(units, uint16(b[i])<<8|uint16(b[i+1]))
		} else {
			units = append(units, uint16(b[i+1])<<8|uint16(b[i]))
		}
	}
	return string(utf16.Decode(units))
}

// cp1252High maps the 0x80–0x9F range where Windows-1252 differs from
// Latin-1; 0x00–0x7F and 0xA0–0xFF are code-point identical.
var cp1252High = [32]rune{
	0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
	0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD,
	0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
	0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178,
}

// decodeCP1252 decodes Windows-1252 bytes to UTF-8 without pulling in x/text.
func decodeCP1252(b []byte) string {
	var sb strings.Builder
	sb.Grow(len(b))
	for _, c := range b {
		switch {
		case c < 0x80:
			sb.WriteByte(c)
		case c < 0xA0:
			sb.WriteRune(cp1252High[c-0x80])
		default:
			sb.WriteRune(rune(c))
		}
	}
	return sb.String()
}

// downloadFile fetches one CSV. A non-2xx (ASIC serves an HTML 404 page for
// dates with no file, e.g. public holidays) is an error, and the caller skips
// the file exactly like the Python's raise_for_status + warning.
func downloadFile(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, fileTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}
