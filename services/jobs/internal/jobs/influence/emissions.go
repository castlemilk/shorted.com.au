package influence

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	emissionsSource = "cer-nger-corporate-emissions"
	cerLatestURL    = "https://cer.gov.au/markets/reports-and-data/nger-reporting-data-and-registers/corporate-emissions-and-energy-data-2024-25"
)

type EmissionsRow struct {
	EntityName        string
	ABN               string
	ReportingYearEnd  int
	Scope1            float64
	Scope2            float64
	NetEnergyConsumed float64
	Notes             string
	SourceURL         string
}

func ingestCEREmissions(ctx context.Context) ([]EmissionsRow, error) {
	links, err := fetchDownloadLinks(ctx, cerLatestURL)
	if err != nil {
		return nil, err
	}
	link, ok := findDownloadLink(links, "registered corporation", "csv")
	if !ok {
		return nil, fmt.Errorf("CER registered corporation CSV link not found")
	}
	yearEnd, ok := yearEndFromText(link.Text)
	if !ok {
		return nil, fmt.Errorf("CER reporting year not found in %q", link.Text)
	}
	data, err := downloadResource(ctx, link.Href)
	if err != nil {
		return nil, err
	}
	return parseCEREmissionsCSV(data, yearEnd, link.Href)
}

func parseCEREmissionsCSV(data []byte, reportingYearEnd int, sourceURL string) ([]EmissionsRow, error) {
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("read CER header: %w", err)
	}
	cols := struct {
		name   int
		abn    int
		scope1 int
		scope2 int
		energy int
		notes  int
	}{
		name:   columnIndex(headers, "Organisation name", "Organization name"),
		abn:    columnIndex(headers, "Identifying details"),
		scope1: columnIndex(headers, "Total scope 1 emissions (t CO2-e)"),
		scope2: columnIndex(headers, "Total scope 2 emissions (t CO2-e)"),
		energy: columnIndex(headers, "Net energy consumed (GJ)"),
		notes:  columnIndex(headers, "Important notes"),
	}
	if cols.name < 0 || cols.abn < 0 || cols.scope1 < 0 || cols.scope2 < 0 {
		return nil, fmt.Errorf("CER CSV missing required columns")
	}

	var out []EmissionsRow
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read CER row: %w", err)
		}
		abn := abnDigits.ReplaceAllString(readColumn(row, cols.abn), "")
		if len(abn) != 11 {
			continue
		}
		scope1, ok1 := parseAmount(readColumn(row, cols.scope1))
		scope2, ok2 := parseAmount(readColumn(row, cols.scope2))
		if !ok1 || !ok2 {
			continue
		}
		var energy float64
		if cols.energy >= 0 {
			energy, _ = parseAmount(readColumn(row, cols.energy))
		}
		out = append(out, EmissionsRow{
			EntityName:        strings.TrimSpace(readColumn(row, cols.name)),
			ABN:               abn,
			ReportingYearEnd:  reportingYearEnd,
			Scope1:            scope1,
			Scope2:            scope2,
			NetEnergyConsumed: energy,
			Notes:             readColumn(row, cols.notes),
			SourceURL:         sourceURL,
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no CER emissions rows parsed")
	}
	return out, nil
}

func syncIndustryEmissionRecords(ctx context.Context, pool *pgxpool.Pool, rows []EmissionsRow) (int, int, error) {
	mappings, err := loadEntityMappings(ctx, pool)
	if err != nil {
		return 0, 0, fmt.Errorf("load entity mappings: %w", err)
	}
	records := make([]IndustryRecord, 0, len(rows))
	skipped := 0
	for _, row := range rows {
		mapping, ok := mappings[row.ABN]
		if !ok {
			skipped++
			continue
		}
		totalEmissions := row.Scope1 + row.Scope2
		periodStart, periodEnd, asOf := financialYearDates(row.ReportingYearEnd)
		records = append(records, IndustryRecord{
			SourceKey:      emissionsSource,
			SourceRecordID: fmt.Sprintf("cer-nger:%s:%d", row.ABN, row.ReportingYearEnd),
			SignalKind:     "emissions",
			Industry:       mapping.Industry,
			StockCode:      mapping.StockCode,
			EntityABN:      row.ABN,
			MetricKey:      "scope_1_2_emissions",
			MetricLabel:    "Scope 1 + 2 emissions",
			MetricValue:    &totalEmissions,
			Unit:           "t CO2-e",
			PeriodStart:    periodStart,
			PeriodEnd:      periodEnd,
			AsOf:           asOf,
			Title:          fmt.Sprintf("NGER emissions: %s %d", mapping.CompanyName, row.ReportingYearEnd),
			Summary:        fmt.Sprintf("CER reported scope 1 and scope 2 greenhouse gas emissions for %s in the %d-%02d reporting year.", mapping.CompanyName, row.ReportingYearEnd-1, row.ReportingYearEnd%100),
			SourceURL:      row.SourceURL,
			Confidence:     mapping.Confidence,
			Metadata: map[string]any{
				"entity_name":            row.EntityName,
				"company_name":           mapping.CompanyName,
				"reporting_year_end":     row.ReportingYearEnd,
				"scope_1_emissions":      row.Scope1,
				"scope_2_emissions":      row.Scope2,
				"net_energy_consumed_gj": row.NetEnergyConsumed,
				"important_notes":        row.Notes,
				"match_method":           "exact_abn",
			},
		})
	}
	imported, err := upsertIndustryRecords(ctx, pool, emissionsSource, records)
	return imported, skipped, err
}
