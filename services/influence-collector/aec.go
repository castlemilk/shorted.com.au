package main

// AEC Transparency Register — annual financial disclosure returns.
//
// Bulk data comes from the official export at
// https://transparency.aec.gov.au/Download/AllAnnualData (a zip of 13 CSVs).
// NOTE: that endpoint only supports GET — a HEAD request returns HTTP 500
// (allow: GET), so reachability probes must GET (the source registry probes
// the landing page instead). Licence: the AEC copyright policy applies
// CC-BY-4.0 to AEC material (Crown copyright, © Commonwealth of Australia);
// the transparency subdomain carries no explicit licence statement of its own.
//
// The donation/receipt CSVs carry NO ABN, so matching is exact-normalized-name
// only (the same normalization as store.go's normExpr), never fuzzy, and
// ambiguous normalized names are dropped entirely. Values below the disclosure
// threshold in force for each financial year are not in the data
// (right-censored); FY2026-27+ records carry a threshold-change note.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// aecSource matches the "aec-transparency-register" entry already present
	// in sources.go (signal_kind=policy_footprint, ExactEntityRequired=true).
	aecSource              = "aec-transparency-register"
	aecAllAnnualDataURL    = "https://transparency.aec.gov.au/Download/AllAnnualData"
	aecDownloadPage        = "https://transparency.aec.gov.au/Download"
	defaultAECFileCap      = 2
	aecDonorReturnType     = "Annual donor return"
	aecKindDonationMade    = "donation_made"
	aecKindDetailedReceipt = "detailed_receipt"

	// aecThresholdNote annotates FY2026-27+ records: disclosure rules changed
	// with transitional rules from 1 July 2026 and a $5,000 threshold from
	// 1 January 2027 (Electoral Legislation Amendment (Electoral Reform) Act
	// 2025), so totals are not comparable across the boundary.
	aecThresholdNote = "Disclosure threshold changed 1 Jul 2026: transitional rules apply from 1 July 2026 and a $5,000 disclosure threshold commences 1 January 2027 (Electoral Legislation Amendment (Electoral Reform) Act 2025). Figures are not directly comparable with earlier financial years."
)

// AECReceiptRow is one declared money-flow row from the AEC annual bulk data:
// either a donation a donor declared making ("Donations Made.csv") or a
// receipt a recipient declared receiving ("Detailed Receipts.csv"). EntityName
// is always the paying side — the entity that may resolve to an ASX code.
type AECReceiptRow struct {
	RecordKind       string     // aecKindDonationMade | aecKindDetailedReceipt
	FinancialYear    string     // raw label from the file, e.g. "2024-25" or "1998-1999"
	FinancialYearEnd int        // calendar year the financial year ends in
	ReturnType       string     // e.g. "Annual donor return", "Political Party Return"
	EntityName       string     // donor / payer (potential ASX entity)
	CounterpartyName string     // recipient of the money
	ReceiptType      string     // detailed receipts only, e.g. "Donation Received"
	TransactionDate  *time.Time // donations only; nil when the return omits it
	Value            float64
	Occurrence       int // 1-based counter for byte-identical rows (legitimate duplicates)
	SourceURL        string
}

// ingestAEC downloads the official AllAnnualData zip export and parses up to
// fileCap of the donation/receipt CSVs (donor-declared donations first).
func ingestAEC(ctx context.Context, fileCap int) ([]AECReceiptRow, int, error) {
	if fileCap <= 0 {
		fileCap = defaultAECFileCap
	}
	data, err := downloadResource(ctx, aecAllAnnualDataURL)
	if err != nil {
		return nil, 0, err
	}
	return parseAECArchive(data, fileCap)
}

type aecArchiveFile struct {
	file *zip.File
	kind string
}

// aecAnnualCSVFiles lists the archive members we ingest, in priority order:
// donor-declared donations first, then recipient-declared detailed receipts.
var aecAnnualCSVFiles = []struct {
	match string
	kind  string
}{
	{match: "donations made", kind: aecKindDonationMade},
	{match: "detailed receipts", kind: aecKindDetailedReceipt},
}

func selectAECAnnualFiles(zr *zip.Reader, limit int) []aecArchiveFile {
	var selected []aecArchiveFile
	for _, want := range aecAnnualCSVFiles {
		if limit > 0 && len(selected) >= limit {
			break
		}
		for _, f := range zr.File {
			name := strings.ToLower(path.Base(f.Name))
			if strings.HasSuffix(name, ".csv") && strings.Contains(name, want.match) {
				selected = append(selected, aecArchiveFile{file: f, kind: want.kind})
				break
			}
		}
	}
	return selected
}

func parseAECArchive(data []byte, fileCap int) ([]AECReceiptRow, int, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, 0, fmt.Errorf("open AEC annual data archive: %w", err)
	}
	selected := selectAECAnnualFiles(zr, fileCap)
	if len(selected) == 0 {
		return nil, 0, fmt.Errorf("no AEC annual CSV files found in archive")
	}

	var all []AECReceiptRow
	for _, entry := range selected {
		rc, err := entry.file.Open()
		if err != nil {
			return all, len(selected), fmt.Errorf("open %q: %w", entry.file.Name, err)
		}
		content, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			return all, len(selected), fmt.Errorf("read %q: %w", entry.file.Name, err)
		}
		var rows []AECReceiptRow
		switch entry.kind {
		case aecKindDonationMade:
			rows, err = parseAECDonationsMadeCSV(content, aecAllAnnualDataURL)
		case aecKindDetailedReceipt:
			rows, err = parseAECDetailedReceiptsCSV(content, aecAllAnnualDataURL)
		}
		if err != nil {
			return all, len(selected), fmt.Errorf("parse %q: %w", entry.file.Name, err)
		}
		all = append(all, rows...)
	}
	if len(all) == 0 {
		return nil, len(selected), fmt.Errorf("no AEC rows parsed")
	}
	return all, len(selected), nil
}

func newAECCSVReader(data []byte) *csv.Reader {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF}) // some exports carry a UTF-8 BOM
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	reader.TrimLeadingSpace = true
	return reader
}

// parseAECDonationsMadeCSV parses "Donations Made.csv":
// Financial Year, Donor Name, Donation Made To, Date, Value.
func parseAECDonationsMadeCSV(data []byte, sourceURL string) ([]AECReceiptRow, error) {
	reader := newAECCSVReader(data)
	headers, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read AEC donations header: %w", err)
	}
	cols := struct {
		fy, donor, recipient, date, value int
	}{
		fy:        columnIndex(headers, "Financial Year"),
		donor:     columnIndex(headers, "Donor Name"),
		recipient: columnIndex(headers, "Donation Made To"),
		date:      columnIndex(headers, "Date"),
		value:     columnIndex(headers, "Value"),
	}
	if cols.fy < 0 || cols.donor < 0 || cols.recipient < 0 || cols.value < 0 {
		return nil, fmt.Errorf("AEC donations CSV missing required columns")
	}

	occurrences := map[string]int{}
	var out []AECReceiptRow
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read AEC donations row: %w", err)
		}
		fyLabel := readColumn(row, cols.fy)
		yearEnd, ok := parseAECFinancialYear(fyLabel)
		if !ok {
			continue
		}
		donor := readColumn(row, cols.donor)
		recipient := readColumn(row, cols.recipient)
		rawDate := readColumn(row, cols.date)
		rawValue := readColumn(row, cols.value)
		value, okValue := parseAmount(rawValue)
		if donor == "" || !okValue || value <= 0 {
			continue
		}
		// Byte-identical rows are legitimate (repeated identical same-day
		// donations), so an occurrence counter keeps their record IDs distinct.
		key := strings.Join([]string{fyLabel, donor, recipient, rawDate, rawValue}, "\x00")
		occurrences[key]++
		out = append(out, AECReceiptRow{
			RecordKind:       aecKindDonationMade,
			FinancialYear:    fyLabel,
			FinancialYearEnd: yearEnd,
			ReturnType:       aecDonorReturnType,
			EntityName:       donor,
			CounterpartyName: recipient,
			TransactionDate:  parseAECDate(rawDate),
			Value:            value,
			Occurrence:       occurrences[key],
			SourceURL:        sourceURL,
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no AEC donation rows parsed")
	}
	return out, nil
}

// parseAECDetailedReceiptsCSV parses "Detailed Receipts.csv":
// Financial Year, Return Type, Recipient Name, Received From, Receipt Type, Value.
func parseAECDetailedReceiptsCSV(data []byte, sourceURL string) ([]AECReceiptRow, error) {
	reader := newAECCSVReader(data)
	headers, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read AEC receipts header: %w", err)
	}
	cols := struct {
		fy, returnType, recipient, receivedFrom, receiptType, value int
	}{
		fy:           columnIndex(headers, "Financial Year"),
		returnType:   columnIndex(headers, "Return Type"),
		recipient:    columnIndex(headers, "Recipient Name"),
		receivedFrom: columnIndex(headers, "Received From"),
		receiptType:  columnIndex(headers, "Receipt Type"),
		value:        columnIndex(headers, "Value"),
	}
	if cols.fy < 0 || cols.recipient < 0 || cols.receivedFrom < 0 || cols.value < 0 {
		return nil, fmt.Errorf("AEC receipts CSV missing required columns")
	}

	occurrences := map[string]int{}
	var out []AECReceiptRow
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read AEC receipts row: %w", err)
		}
		fyLabel := readColumn(row, cols.fy)
		yearEnd, ok := parseAECFinancialYear(fyLabel)
		if !ok {
			continue
		}
		returnType := readColumn(row, cols.returnType)
		recipient := readColumn(row, cols.recipient)
		receivedFrom := readColumn(row, cols.receivedFrom)
		receiptType := readColumn(row, cols.receiptType)
		rawValue := readColumn(row, cols.value)
		value, okValue := parseAmount(rawValue)
		if receivedFrom == "" || !okValue || value <= 0 {
			continue
		}
		key := strings.Join([]string{fyLabel, returnType, recipient, receivedFrom, receiptType, rawValue}, "\x00")
		occurrences[key]++
		out = append(out, AECReceiptRow{
			RecordKind:       aecKindDetailedReceipt,
			FinancialYear:    fyLabel,
			FinancialYearEnd: yearEnd,
			ReturnType:       returnType,
			EntityName:       receivedFrom,
			CounterpartyName: recipient,
			ReceiptType:      receiptType,
			Value:            value,
			Occurrence:       occurrences[key],
			SourceURL:        sourceURL,
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no AEC receipt rows parsed")
	}
	return out, nil
}

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
// (95 rows in the current export) return nil so callers fall back to the
// financial-year period end.
func parseAECDate(s string) *time.Time {
	s = strings.TrimSpace(s)
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

var (
	aecNonAlphaNumeric = regexp.MustCompile(`[^A-Z0-9]+`)
	aecCorporateSuffix = regexp.MustCompile(` (LIMITED|LTD|GROUP|HOLDINGS|CORPORATION|PLC|TRUST|PTY|PROPRIETARY)$`)
)

// normalizeAECEntityName is the Go port of store.go's normExpr: upper-case,
// punctuation → single space, then strip a trailing corporate suffix TWICE
// (so "Woodside Energy Group Ltd" → "WOODSIDE ENERGY GROUP" → "WOODSIDE ENERGY").
func normalizeAECEntityName(s string) string {
	s = strings.TrimSpace(aecNonAlphaNumeric.ReplaceAllString(strings.ToUpper(s), " "))
	s = strings.TrimSpace(aecCorporateSuffix.ReplaceAllString(s, ""))
	s = strings.TrimSpace(aecCorporateSuffix.ReplaceAllString(s, ""))
	return s
}

// buildAECNameIndex derives an exact-normalized-name index from the ABN-keyed
// entity mappings. The AEC donation/receipt files carry no ABN, so a name that
// normalizes to more than one stock code is AMBIGUOUS and dropped entirely —
// per the editorial standard, when in doubt, don't join. Same-stock-code
// collisions resolve deterministically to the lowest ABN.
func buildAECNameIndex(mappings map[string]EntityMapping) map[string]EntityMapping {
	abns := make([]string, 0, len(mappings))
	for abn := range mappings {
		abns = append(abns, abn)
	}
	sort.Strings(abns)

	index := map[string]EntityMapping{}
	ambiguous := map[string]bool{}
	for _, abn := range abns {
		mapping := mappings[abn]
		name := normalizeAECEntityName(mapping.CompanyName)
		if name == "" {
			continue
		}
		existing, ok := index[name]
		if !ok {
			index[name] = mapping
			continue
		}
		if existing.StockCode != mapping.StockCode {
			ambiguous[name] = true
		}
	}
	for name := range ambiguous {
		delete(index, name)
	}
	return index
}

// buildAECIndustryRecords converts exact name-matched AEC rows into neutral,
// cited industry intelligence records. Unmatched rows are counted and dropped —
// no fuzzy fallback, ever.
func buildAECIndustryRecords(rows []AECReceiptRow, index map[string]EntityMapping) ([]IndustryRecord, int) {
	records := make([]IndustryRecord, 0, len(rows))
	skipped := 0
	for _, row := range rows {
		name := normalizeAECEntityName(row.EntityName)
		mapping, ok := index[name]
		if name == "" || !ok {
			skipped++
			continue
		}
		records = append(records, buildAECIndustryRecord(row, mapping))
	}
	return records, skipped
}

func buildAECIndustryRecord(row AECReceiptRow, mapping EntityMapping) IndustryRecord {
	periodStart, periodEnd, fyEnd := financialYearDates(row.FinancialYearEnd)
	asOf := fyEnd
	if row.TransactionDate != nil {
		asOf = *row.TransactionDate
	}

	kindTag := "donation"
	metricKey := "declared_donation_value"
	metricLabel := "Declared donation (AEC annual return)"
	summary := fmt.Sprintf("%s declared a donation of %s made to %s in its %s annual return lodged with the AEC.",
		mapping.CompanyName, formatAUDAmount(row.Value), row.CounterpartyName, row.FinancialYear)
	metadata := map[string]any{
		"record_kind":    row.RecordKind,
		"return_type":    row.ReturnType,
		"financial_year": row.FinancialYear,
		"donor_name":     row.EntityName,
		"recipient_name": row.CounterpartyName,
		"entity_name":    row.EntityName,
		"company_name":   mapping.CompanyName,
		"occurrence":     row.Occurrence,
		"match_method":   "name_exact",
	}
	if row.TransactionDate != nil {
		metadata["transaction_date"] = row.TransactionDate.Format("2006-01-02")
	}

	if row.RecordKind == aecKindDetailedReceipt {
		kindTag = "receipt"
		metricKey = "declared_receipt_value"
		metricLabel = "Declared receipt (AEC annual return)"
		summary = fmt.Sprintf("%s declared receipts of %s received from %s in its %s annual return lodged with the AEC.",
			row.CounterpartyName, formatAUDAmount(row.Value), mapping.CompanyName, row.FinancialYear)
		delete(metadata, "donor_name")
		metadata["received_from"] = row.EntityName
		metadata["receipt_type"] = row.ReceiptType
	}
	if row.FinancialYearEnd >= 2027 {
		metadata["threshold_note"] = aecThresholdNote
	}

	value := row.Value
	dateStr := ""
	if row.TransactionDate != nil {
		dateStr = row.TransactionDate.Format("2006-01-02")
	}
	recordID := stableRecordID("aec-"+kindTag,
		row.FinancialYear, row.EntityName, row.CounterpartyName, row.ReceiptType,
		dateStr, strconv.FormatFloat(row.Value, 'f', 2, 64), strconv.Itoa(row.Occurrence))

	return IndustryRecord{
		SourceKey:      aecSource,
		SourceRecordID: recordID,
		SignalKind:     "policy_footprint",
		Industry:       mapping.Industry,
		StockCode:      mapping.StockCode,
		EntityABN:      abnDigits.ReplaceAllString(mapping.ABN, ""),
		MetricKey:      metricKey,
		MetricLabel:    metricLabel,
		MetricValue:    &value,
		Unit:           "AUD",
		PeriodStart:    periodStart,
		PeriodEnd:      periodEnd,
		AsOf:           asOf,
		Title:          fmt.Sprintf("AEC return: %s", mapping.CompanyName),
		Summary:        summary,
		SourceURL:      row.SourceURL,
		Confidence:     mapping.Confidence,
		Metadata:       metadata,
	}
}

// formatAUDAmount renders a dollar figure with thousands separators for the
// neutral record summaries ("$12,000", "$1,250,000.5").
func formatAUDAmount(v float64) string {
	negative := v < 0
	if negative {
		v = -v
	}
	s := strconv.FormatFloat(v, 'f', -1, 64)
	intPart, fracPart, _ := strings.Cut(s, ".")
	var b strings.Builder
	for i, r := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	out := "$" + b.String()
	if fracPart != "" {
		out += "." + fracPart
	}
	if negative {
		out = "-" + out
	}
	return out
}

// syncIndustryDonationRecords publishes exact name-matched AEC rows as industry
// intelligence records. Matching is exact-normalized-name against the ABN spine
// (the AEC files carry no ABN); unmatched rows fall back to nothing. The
// public_enabled flip happens inside upsertIndustryRecords via
// markIndustrySourcePublic — the same path AusTender uses.
func syncIndustryDonationRecords(ctx context.Context, pool *pgxpool.Pool, rows []AECReceiptRow) (int, int, error) {
	mappings, err := loadEntityMappings(ctx, pool)
	if err != nil {
		return 0, 0, fmt.Errorf("load entity mappings: %w", err)
	}
	records, skipped := buildAECIndustryRecords(rows, buildAECNameIndex(mappings))
	imported, err := upsertIndustryRecords(ctx, pool, aecSource, records)
	return imported, skipped, err
}

// runAECMode mirrors runAusTenderMode: collection-run bracketing, ingest, sync,
// and a partial status when nothing matched. main.go wires it up later.
func runAECMode(ctx context.Context, pool *pgxpool.Pool, sourceLimit int) {
	runID, err := insertIndustryCollectionRun(ctx, pool, aecSource)
	if err != nil {
		log.Fatalf("[aec] start collection run: %v", err)
	}
	rows, files, err := ingestAEC(ctx, sourceLimit)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[aec]", err, map[string]any{
			"download_url": aecAllAnnualDataURL,
			"register_url": aecDownloadPage,
			"file_limit":   sourceLimit,
		})
		log.Fatalf("[aec] ingest error: %v", err)
	}
	imported, skipped, err := syncIndustryDonationRecords(ctx, pool, rows)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[aec]", err, map[string]any{
			"download_url": aecAllAnnualDataURL,
			"register_url": aecDownloadPage,
			"file_limit":   sourceLimit,
		})
		log.Fatalf("[aec] sync error: %v", err)
	}
	status := "succeeded"
	if imported == 0 && skipped > 0 {
		status = "partial"
	}
	if err := finishIndustryCollectionRun(ctx, pool, runID, status, len(rows), imported, 0, "", map[string]any{
		"download_url":     aecAllAnnualDataURL,
		"register_url":     aecDownloadPage,
		"files_parsed":     files,
		"file_limit":       sourceLimit,
		"skipped_unmapped": skipped,
	}); err != nil {
		log.Fatalf("[aec] finish collection run: %v", err)
	}
	log.Printf("[aec] parsed %d AEC return rows from %d files, imported %d exact name-matched records (%d unmapped)", len(rows), files, imported, skipped)
}
