package main

import (
	"bytes"
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xuri/excelize/v2"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// Victorian Local Government Performance Reporting Framework (LGPRF) "Full
// Council Data Set" — the annual per-council financial + service indicators for
// all 79 Victorian councils. Published by Local Government Victoria (Dept of
// Government Services) via the Victorian Government Data Directory, CC-BY-4.0
// (confirmed via the data.vic CKAN package: license_id=cc-by). The file host
// sits behind Cloudflare, so we fetch via stealthhttp's NATIVE engine — the same
// posture as vic_vpsr.go (a bare request gets a "Just a moment" challenge).
//
// The workbook has one worksheet per REPORTING YEAR ("Indicators 2024-25" …),
// long-format: each row is (Council, Group, ID, Description, Service Provided,
// Data applicable?, Result, …). We read the latest year's sheet and pull the
// three financial indicators we surface, keyed to the lga dimension by
// normalised council name (reusing normCouncil — LGPRF names councils
// "Melbourne City"/"Alpine Shire", handled by the bare-type-word strip).
const (
	vicLGPRFURL   = "https://www.localgovernment.vic.gov.au/__data/assets/excel_doc/0019/191008/LGPRF-2020-2025-Full-Council-Data-Set-Nov25-Final-Release.xlsx"
	vicFinSource  = "vic_lgprf"
	vicFinLicence = "CC-BY-4.0"

	// LGPRF financial indicator IDs we surface (→ existing lga columns):
	finIDAvgRates     = "E4"  // Average rate per property assessment ($)      → avg_rates
	finIDOpSurplus    = "OP1" // Adjusted underlying surplus/(deficit) (ratio) → op_surplus_ratio (×100 → %)
	finIDAssetRenewal = "O5"  // Asset renewal + upgrade ÷ depreciation (ratio)→ asset_renewal_ratio (×100 → %)
)

var indicatorsSheetRe = regexp.MustCompile(`^Indicators (\d{4})-(\d{2})$`)

// VicFinRow is one council's latest-year LGPRF financials (nil = not applicable).
type VicFinRow struct {
	Council       string
	Year          string
	AvgRates      *float64 // $ per property assessment
	OpSurplusPct  *float64 // adjusted underlying result, %
	AssetRenewPct *float64 // asset renewal vs depreciation, %
}

// fetchVICLGPRF pulls the LGPRF workbook bytes via the stealth native engine.
func fetchVICLGPRF(ctx context.Context) ([]byte, error) {
	client, err := stealthhttp.New(stealthhttp.WithTimeout(60 * time.Second))
	if err != nil {
		return nil, fmt.Errorf("stealth init: %w", err)
	}
	b, _, err := client.FetchBytes(ctx, vicLGPRFURL, xlsxAccept)
	if err != nil {
		return nil, fmt.Errorf("fetch VIC LGPRF: %w", err)
	}
	if len(b) < 2 || b[0] != 'P' || b[1] != 'K' { // ZIP magic; HTML => Cloudflare block
		return nil, fmt.Errorf("VIC LGPRF fetch did not return an xlsx (%d bytes, likely a challenge page)", len(b))
	}
	return b, nil
}

// ingestVICCouncilFinancials fetches + parses the latest LGPRF year.
func ingestVICCouncilFinancials(ctx context.Context) ([]VicFinRow, string, error) {
	b, err := fetchVICLGPRF(ctx)
	if err != nil {
		return nil, "", err
	}
	return parseVICCouncilFinancials(b)
}

// latestIndicatorsSheet returns the "Indicators YYYY-YY" sheet with the highest
// starting year, and that year label (e.g. "2024-25").
func latestIndicatorsSheet(sheets []string) (string, string) {
	best, bestYear, bestLabel := "", -1, ""
	for _, s := range sheets {
		m := indicatorsSheetRe.FindStringSubmatch(s)
		if m == nil {
			continue
		}
		y, _ := strconv.Atoi(m[1])
		if y > bestYear {
			bestYear, best, bestLabel = y, s, m[1]+"-"+m[2]
		}
	}
	return best, bestLabel
}

// parseVICCouncilFinancials reads the latest year's indicator sheet and pulls
// the E4/OP1/O5 result per council.
func parseVICCouncilFinancials(xlsxBytes []byte) ([]VicFinRow, string, error) {
	f, err := excelize.OpenReader(bytes.NewReader(xlsxBytes))
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = f.Close() }()

	sheet, year := latestIndicatorsSheet(f.GetSheetList())
	if sheet == "" {
		return nil, "", fmt.Errorf("LGPRF: no 'Indicators YYYY-YY' sheet found")
	}
	rows, err := f.GetRows(sheet)
	if err != nil || len(rows) < 2 {
		return nil, "", fmt.Errorf("LGPRF: sheet %q unreadable: %w", sheet, err)
	}

	// Locate columns by header name (Council | ID | Data applicable? | Result).
	councilCol, idCol, applCol, resultCol := -1, -1, -1, -1
	for j, h := range rows[0] {
		switch strings.ToLower(strings.TrimSpace(h)) {
		case "council":
			councilCol = j
		case "id":
			idCol = j
		case "data applicable?":
			applCol = j
		case "result":
			if resultCol < 0 { // first "Result" is the current-year actual
				resultCol = j
			}
		}
	}
	if councilCol < 0 || idCol < 0 || resultCol < 0 {
		return nil, "", fmt.Errorf("LGPRF: header columns not found in %q", sheet)
	}

	acc := map[string]*VicFinRow{}
	for _, row := range rows[1:] {
		council := strings.TrimSpace(cell(row, councilCol))
		id := strings.TrimSpace(cell(row, idCol))
		if council == "" || (id != finIDAvgRates && id != finIDOpSurplus && id != finIDAssetRenewal) {
			continue
		}
		if applCol >= 0 && applCol < len(row) {
			if a := strings.ToLower(strings.TrimSpace(row[applCol])); a != "" && a != "applicable" {
				continue // "not applicable" — leave that indicator nil
			}
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(cell(row, resultCol)), 64)
		if err != nil {
			continue
		}
		r := acc[council]
		if r == nil {
			r = &VicFinRow{Council: council, Year: year}
			acc[council] = r
		}
		switch id {
		case finIDAvgRates:
			rate := v
			r.AvgRates = &rate
		case finIDOpSurplus:
			pct := v * 100 // fraction → %
			r.OpSurplusPct = &pct
		case finIDAssetRenewal:
			pct := v * 100 // ratio → %
			r.AssetRenewPct = &pct
		}
	}

	out := make([]VicFinRow, 0, len(acc))
	for _, r := range acc {
		out = append(out, *r)
	}
	return out, year, nil
}

// applyVICFinancials matches each council's LGPRF financials (by normalised name,
// VIC only) to the lga dimension and updates the financial columns.
func applyVICFinancials(ctx context.Context, pool *pgxpool.Pool, rows []VicFinRow) (int, error) {
	idx := map[string]string{} // normCouncil(name) → lga_code24 (VIC)
	q, err := pool.Query(ctx, `SELECT lga_code24, lga_name FROM lga WHERE state_code = 'VIC'`)
	if err != nil {
		return 0, err
	}
	for q.Next() {
		var code, name string
		if err := q.Scan(&code, &name); err != nil {
			q.Close()
			return 0, err
		}
		idx[normCouncil(name)] = code
	}
	q.Close()
	// A mid-stream read error surfaces only via Err(); guard against a silently
	// truncated match index being recorded as a successful ingest.
	if err := q.Err(); err != nil {
		return 0, err
	}

	batch := &pgx.Batch{}
	matched := 0
	for _, r := range rows {
		code, ok := idx[normCouncil(r.Council)]
		if !ok {
			continue
		}
		batch.Queue(`UPDATE lga SET
			avg_rates = $2, op_surplus_ratio = $3, asset_renewal_ratio = $4,
			fin_source = $5, fin_source_licence = $6, fin_year = $7, fetched_at = now()
			WHERE lga_code24 = $1`,
			code, r.AvgRates, r.OpSurplusPct, r.AssetRenewPct, vicFinSource, vicFinLicence, r.Year)
		matched++
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	for i := 0; i < matched; i++ {
		if _, err := br.Exec(); err != nil {
			return i, err
		}
	}
	return matched, nil
}
