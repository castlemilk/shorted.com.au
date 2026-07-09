package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xuri/excelize/v2"
)

const (
	austenderSource             = "austender-contract-notices"
	austenderHistoricalPackage  = "https://data.gov.au/data/api/3/action/package_show?id=historical-australian-government-contract-data"
	austenderHistoricalDataset  = "https://data.gov.au/data/dataset/historical-australian-government-contract-data"
	defaultAusTenderResourceCap = 2
)

type ContractNoticeRow struct {
	AgencyName        string
	NoticeType        string
	ContractID        string
	PublishDate       *time.Time
	StartDate         *time.Time
	EndDate           *time.Time
	ContractValue     float64
	Description       string
	UNSPSC            string
	UNSPSCTitle       string
	ProcurementMethod string
	SupplierName      string
	SupplierABN       string
	SourceURL         string
}

func ingestAusTender(ctx context.Context, resourceCap int) ([]ContractNoticeRow, int, error) {
	if resourceCap <= 0 {
		resourceCap = defaultAusTenderResourceCap
	}
	resources, err := fetchCKANResources(ctx, austenderHistoricalPackage)
	if err != nil {
		return nil, 0, err
	}
	selected := selectAusTenderResources(resources, resourceCap)
	if len(selected) == 0 {
		return nil, 0, fmt.Errorf("no AusTender CSV/XLSX resources selected")
	}

	var all []ContractNoticeRow
	for _, resource := range selected {
		data, err := downloadResource(ctx, resource.URL)
		if err != nil {
			return all, len(selected), fmt.Errorf("download %q: %w", resource.Name, err)
		}
		rows, err := parseAusTenderResource(data, resource)
		if err != nil {
			return all, len(selected), fmt.Errorf("parse %q: %w", resource.Name, err)
		}
		all = append(all, rows...)
	}
	if len(all) == 0 {
		return nil, len(selected), fmt.Errorf("no AusTender rows parsed")
	}
	return all, len(selected), nil
}

func selectAusTenderResources(resources []ckanResource, limit int) []ckanResource {
	var candidates []ckanResource
	for _, resource := range resources {
		haystack := strings.ToLower(resource.Name + " " + resource.Format + " " + resource.URL)
		switch {
		case strings.Contains(haystack, "dictionary"),
			strings.Contains(haystack, "unspsc"),
			strings.Contains(haystack, "api"),
			strings.Contains(haystack, ".pdf"):
			continue
		case strings.Contains(haystack, ".csv"),
			strings.Contains(haystack, "csv"),
			strings.Contains(haystack, ".xlsx"),
			strings.Contains(haystack, "xlsx"),
			strings.Contains(haystack, "excel"):
			candidates = append(candidates, resource)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		iy, iok := yearEndFromText(candidates[i].Name)
		jy, jok := yearEndFromText(candidates[j].Name)
		if iok != jok {
			return iok
		}
		if iok && iy != jy {
			return iy > jy
		}
		return candidates[i].Name > candidates[j].Name
	})
	if limit > 0 && len(candidates) > limit {
		return candidates[:limit]
	}
	return candidates
}

func parseAusTenderResource(data []byte, resource ckanResource) ([]ContractNoticeRow, error) {
	haystack := strings.ToLower(resource.Name + " " + resource.Format + " " + resource.URL)
	switch {
	case strings.Contains(haystack, ".csv") || strings.Contains(haystack, "csv"):
		return parseAusTenderCSV(data, resource.URL)
	case strings.Contains(haystack, ".xlsx") || strings.Contains(haystack, "xlsx") || strings.Contains(haystack, "excel"):
		return parseAusTenderXLSX(data, resource.URL)
	default:
		return nil, fmt.Errorf("unsupported AusTender resource format %q", resource.Format)
	}
}

func parseAusTenderCSV(data []byte, sourceURL string) ([]ContractNoticeRow, error) {
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	reader.TrimLeadingSpace = true

	rows, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}
	return parseAusTenderRows(rows, sourceURL)
}

func parseAusTenderXLSX(data []byte, sourceURL string) ([]ContractNoticeRow, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	for _, sheet := range f.GetSheetList() {
		rows, err := f.GetRows(sheet)
		if err != nil || len(rows) == 0 {
			continue
		}
		parsed, err := parseAusTenderRows(rows, sourceURL)
		if err == nil && len(parsed) > 0 {
			return parsed, nil
		}
	}
	return nil, fmt.Errorf("no parseable worksheet found")
}

func parseAusTenderRows(rows [][]string, sourceURL string) ([]ContractNoticeRow, error) {
	headerIdx := -1
	var headers []string
	for i, row := range rows {
		if columnIndex(row, "Supplier ABN") >= 0 && columnIndex(row, "Contract Value") >= 0 {
			headerIdx = i
			headers = row
			break
		}
	}
	if headerIdx < 0 {
		return nil, fmt.Errorf("header row not found")
	}

	cols := struct {
		agency     int
		noticeType int
		contractID int
		publish    int
		start      int
		end        int
		value      int
		amendValue int
		desc       int
		unspsc     int
		unspscName int
		method     int
		supplier   int
		abn        int
	}{
		agency:     columnIndex(headers, "Agency Name"),
		noticeType: columnIndex(headers, "Contract Notice Type"),
		contractID: columnIndex(headers, "Contract ID"),
		publish:    columnIndex(headers, "Publish Date"),
		start:      columnIndex(headers, "Start Date"),
		end:        columnIndex(headers, "End Date"),
		value:      columnIndex(headers, "Contract Value"),
		amendValue: columnIndex(headers, "Amendments Value"),
		desc:       columnIndex(headers, "Description"),
		unspsc:     columnIndex(headers, "UNSPSC"),
		unspscName: columnIndex(headers, "UNSPSC Title"),
		method:     columnIndex(headers, "Procurement Method"),
		supplier:   columnIndex(headers, "Supplier Name"),
		abn:        columnIndex(headers, "Supplier ABN"),
	}
	if cols.contractID < 0 || cols.value < 0 || cols.supplier < 0 || cols.abn < 0 {
		return nil, fmt.Errorf("required AusTender columns missing")
	}

	var out []ContractNoticeRow
	for _, row := range rows[headerIdx+1:] {
		abn := abnDigits.ReplaceAllString(readColumn(row, cols.abn), "")
		if len(abn) != 11 {
			continue
		}
		value, ok := parseAmount(readColumn(row, cols.value))
		if !ok && cols.amendValue >= 0 {
			value, ok = parseAmount(readColumn(row, cols.amendValue))
		}
		if !ok || value <= 0 {
			continue
		}
		contractID := readColumn(row, cols.contractID)
		if contractID == "" {
			contractID = stableRecordID("row", abn, readColumn(row, cols.publish), strconv.FormatFloat(value, 'f', 2, 64), readColumn(row, cols.desc))
		}
		out = append(out, ContractNoticeRow{
			AgencyName:        readColumn(row, cols.agency),
			NoticeType:        readColumn(row, cols.noticeType),
			ContractID:        contractID,
			PublishDate:       parseAusTenderDate(readColumn(row, cols.publish)),
			StartDate:         parseAusTenderDate(readColumn(row, cols.start)),
			EndDate:           parseAusTenderDate(readColumn(row, cols.end)),
			ContractValue:     value,
			Description:       stripHTML(readColumn(row, cols.desc)),
			UNSPSC:            readColumn(row, cols.unspsc),
			UNSPSCTitle:       readColumn(row, cols.unspscName),
			ProcurementMethod: readColumn(row, cols.method),
			SupplierName:      readColumn(row, cols.supplier),
			SupplierABN:       abn,
			SourceURL:         sourceURL,
		})
	}
	return out, nil
}

func syncIndustryContractRecords(ctx context.Context, pool *pgxpool.Pool, rows []ContractNoticeRow) (int, int, error) {
	mappings, err := loadEntityMappings(ctx, pool)
	if err != nil {
		return 0, 0, fmt.Errorf("load entity mappings: %w", err)
	}
	records := make([]IndustryRecord, 0, len(rows))
	skipped := 0
	for _, row := range rows {
		mapping, ok := mappings[row.SupplierABN]
		if !ok {
			skipped++
			continue
		}
		asOf := time.Now().UTC()
		if row.PublishDate != nil {
			asOf = *row.PublishDate
		}
		records = append(records, IndustryRecord{
			SourceKey:      austenderSource,
			SourceRecordID: "austender-cn:" + row.ContractID,
			SignalKind:     "public_money",
			Industry:       mapping.Industry,
			StockCode:      mapping.StockCode,
			EntityABN:      row.SupplierABN,
			MetricKey:      "contract_value",
			MetricLabel:    "Contract value (life-of-contract maximum)",
			MetricValue:    &row.ContractValue,
			Unit:           "AUD",
			PeriodStart:    row.StartDate,
			PeriodEnd:      row.EndDate,
			AsOf:           asOf,
			Title:          fmt.Sprintf("AusTender contract: %s", mapping.CompanyName),
			Summary:        fmt.Sprintf("AusTender reported a Commonwealth contract notice for %s. The value is a life-of-contract maximum, not annual spend.", mapping.CompanyName),
			SourceURL:      row.SourceURL,
			Confidence:     mapping.Confidence,
			Metadata: map[string]any{
				"agency_name":        row.AgencyName,
				"notice_type":        row.NoticeType,
				"contract_id":        row.ContractID,
				"description":        row.Description,
				"unspsc":             row.UNSPSC,
				"unspsc_title":       row.UNSPSCTitle,
				"procurement_method": row.ProcurementMethod,
				"supplier_name":      row.SupplierName,
				"company_name":       mapping.CompanyName,
				"match_method":       "exact_abn",
			},
		})
	}
	imported, err := upsertIndustryRecords(ctx, pool, austenderSource, records)
	return imported, skipped, err
}

func parseAusTenderDate(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" || strings.EqualFold(s, "NULL") {
		return nil
	}
	for _, layout := range []string{"2/01/2006", "02/01/2006", "2006-01-02", "2/1/2006"} {
		if t, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
			return &t
		}
	}
	return nil
}

func stripHTML(s string) string {
	var b strings.Builder
	inTag := false
	for _, r := range s {
		switch r {
		case '<':
			inTag = true
		case '>':
			inTag = false
		default:
			if !inTag {
				b.WriteRune(r)
			}
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}
