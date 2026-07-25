// lobbyists.go ingests the two Attorney-General's Department influence
// registers into industry_intelligence_records:
//
//   - agd-register-lobbyists: the Australian Government Register of Lobbyists.
//     The register UI's own "Download the register" export (POST
//     https://api.lobbyists.ag.gov.au/search/download) returns an XLSX whose
//     "Clients" sheet lists every client of every registered lobbying firm,
//     including the client's ABN where disclosed.
//   - agd-fits-register: the Foreign Influence Transparency Scheme public
//     register. The register UI's "Registrants and their activities" export
//     (GET https://foreigninfluence.ag.gov.au/api/advancedSearch/exportExcelWithActivities)
//     returns an XLSX with one row per registrant x foreign principal x activity.
//
// Both are official, published, unauthenticated endpoints (the same calls the
// public register web apps make). If either endpoint refuses the request or
// serves a non-workbook payload, the collector records a failed collection run
// via errSourceUnavailable — it NEVER retries around a block and never
// fabricates data.
//
// Editorial gate (docs/influence-editorial-standards.md): a client/registrant
// only ever resolves to an ASX entity through an exact ABN match
// (entity_asx_map) or — when the register row carries no ABN — an exact
// normalized-name match against "company-metadata" using the same
// normalization semantics as store.go normExpr, with ambiguous names skipped
// exactly like runMatch. All published wording is neutral (lists / discloses).
package influence

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/xuri/excelize/v2"
)

const (
	lobbyistsSource = "agd-register-lobbyists"
	fitsSource      = "agd-fits-register"

	lobbyistRegisterURL       = "https://lobbyists.ag.gov.au/"
	lobbyistRegisterExportURL = "https://api.lobbyists.ag.gov.au/search/download"

	fitsRegisterURL       = "https://foreigninfluence.ag.gov.au/"
	fitsRegisterExportURL = "https://foreigninfluence.ag.gov.au/api/advancedSearch/exportExcelWithActivities"
)

// errSourceUnavailable marks a register whose official machine-readable
// endpoint is not currently reachable/usable (HTTP refusal, WAF interstitial,
// non-workbook payload). Run functions record it as a failed collection run
// and move on — hard rule: never bypass a 403/CAPTCHA/WAF, never invent rows.
type errSourceUnavailable struct {
	SourceKey string
	Reason    string
}

func (e *errSourceUnavailable) Error() string {
	return fmt.Sprintf("source %s unavailable: %s", e.SourceKey, e.Reason)
}

// LobbyistClientRow is one row of the Register of Lobbyists "Clients" sheet:
// a client listed by a registered lobbying organisation. ABNs are normalized
// to 11 digits or "" (the register mixes "92268817994", "70 673 193 596",
// leading whitespace, and blanks).
type LobbyistClientRow struct {
	ClientName     string
	ClientABN      string
	RegistrantName string
	RegistrantABN  string
}

// FITSArrangementRow is one unique (registrant, foreign principal) pair from
// the FITS "registrants and their activities" export. The raw export has one
// row per activity, so the parser de-duplicates pairs.
type FITSArrangementRow struct {
	RegistrantName       string
	RegistrantABN        string
	ForeignPrincipalName string
}

// CompanyNameMapping resolves an exactly-normalized company name to a single
// ASX stock code (ambiguous names are dropped before this map is built).
type CompanyNameMapping struct {
	StockCode   string
	Industry    string
	CompanyName string
}

// companyNameRow is one "company-metadata" row with its SQL-normalized name.
type companyNameRow struct {
	NormalizedName string
	StockCode      string
	Industry       string
	CompanyName    string
}

// entityMatch is a resolved register entity → ASX company match.
type entityMatch struct {
	StockCode   string
	Industry    string
	CompanyName string
	Confidence  float64
	Method      string // "exact_abn" | "name_exact"
}

// Go mirror of store.go normExpr: upper-case, collapse non-alphanumerics to
// single spaces, trim, then strip a trailing corporate suffix TWICE
// ("WOOLWORTHS GROUP LIMITED" → "WOOLWORTHS GROUP" → "WOOLWORTHS").
var (
	entityNameNonAlnum   = regexp.MustCompile(`[^A-Z0-9]+`)
	entityNameCorpSuffix = regexp.MustCompile(` (LIMITED|LTD|GROUP|HOLDINGS|CORPORATION|PLC|TRUST|PTY|PROPRIETARY)$`)
)

func normalizeEntityName(s string) string {
	s = strings.TrimSpace(entityNameNonAlnum.ReplaceAllString(strings.ToUpper(s), " "))
	for i := 0; i < 2; i++ {
		s = strings.TrimSpace(entityNameCorpSuffix.ReplaceAllString(s, ""))
	}
	return s
}

// loadCompanyNameMappings builds the exact normalized-name → stock code map in
// SQL against "company-metadata" using the SAME normalization expression as
// store.go normExpr, then drops ambiguous names (a normalized name resolving
// to more than one stock code) exactly like runMatch does.
func loadCompanyNameMappings(ctx context.Context, pool *pgxpool.Pool) (map[string]CompanyNameMapping, error) {
	q := `
		SELECT
			` + normExpr("company_name") + ` AS nname,
			stock_code,
			COALESCE(NULLIF(industry, ''), 'Unclassified') AS industry,
			company_name
		FROM "company-metadata"
		WHERE company_name IS NOT NULL AND btrim(company_name) <> ''
		  AND stock_code IS NOT NULL AND btrim(stock_code) <> ''`
	rows, err := pool.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var all []companyNameRow
	for rows.Next() {
		var row companyNameRow
		if err := rows.Scan(&row.NormalizedName, &row.StockCode, &row.Industry, &row.CompanyName); err != nil {
			return nil, err
		}
		all = append(all, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return collapseCompanyNameMappings(all), nil
}

// collapseCompanyNameMappings keeps only normalized names that resolve to
// EXACTLY ONE stock code; ambiguous names are skipped (same posture as
// runMatch's HAVING COUNT(DISTINCT stock_code) = 1).
func collapseCompanyNameMappings(rows []companyNameRow) map[string]CompanyNameMapping {
	byName := map[string]map[string]CompanyNameMapping{}
	for _, row := range rows {
		if row.NormalizedName == "" {
			continue
		}
		stocks := byName[row.NormalizedName]
		if stocks == nil {
			stocks = map[string]CompanyNameMapping{}
			byName[row.NormalizedName] = stocks
		}
		stocks[row.StockCode] = CompanyNameMapping{
			StockCode:   row.StockCode,
			Industry:    row.Industry,
			CompanyName: row.CompanyName,
		}
	}
	out := make(map[string]CompanyNameMapping, len(byName))
	for nname, stocks := range byName {
		if len(stocks) != 1 {
			continue // ambiguous name → never matched
		}
		for _, mapping := range stocks {
			out[nname] = mapping
		}
	}
	return out
}

// matchRegisterEntity resolves a register entity to an ASX company. A row WITH
// an ABN is only ever matched by that exact ABN (an unmapped ABN never falls
// back to name matching — same-name traps); a row WITHOUT an ABN may match by
// exact normalized name against the unambiguous company-name map.
func matchRegisterEntity(abn, name string, abnMappings map[string]EntityMapping, nameMappings map[string]CompanyNameMapping) (entityMatch, bool) {
	if len(abn) == 11 {
		mapping, ok := abnMappings[abn]
		if !ok {
			return entityMatch{}, false
		}
		return entityMatch{
			StockCode:   mapping.StockCode,
			Industry:    mapping.Industry,
			CompanyName: mapping.CompanyName,
			Confidence:  mapping.Confidence,
			Method:      "exact_abn",
		}, true
	}
	nname := normalizeEntityName(name)
	if nname == "" {
		return entityMatch{}, false
	}
	mapping, ok := nameMappings[nname]
	if !ok {
		return entityMatch{}, false
	}
	return entityMatch{
		StockCode:   mapping.StockCode,
		Industry:    mapping.Industry,
		CompanyName: mapping.CompanyName,
		Confidence:  1.0, // same confidence runMatch assigns name_exact mappings
		Method:      "name_exact",
	}, true
}

// counterpartyIdentity keys a registrant/principal for distinct counting:
// exact ABN when present, otherwise the whitespace-collapsed uppercased name.
func counterpartyIdentity(abn, name string) string {
	if len(abn) == 11 {
		return "abn:" + abn
	}
	canonical := strings.ToUpper(strings.Join(strings.Fields(name), " "))
	if canonical == "" {
		return ""
	}
	return "name:" + canonical
}

// downloadRegisterExport fetches an official register export. Any non-200
// response or transport-level refusal is surfaced as errSourceUnavailable so
// the run is recorded as failed/blocked — never bypassed.
func downloadRegisterExport(ctx context.Context, sourceKey, method, exportURL string, jsonBody []byte) ([]byte, error) {
	var body io.Reader
	if jsonBody != nil {
		body = bytes.NewReader(jsonBody)
	}
	req, err := http.NewRequestWithContext(ctx, method, exportURL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", influenceUA)
	req.Header.Set("Accept", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream;q=0.9,*/*;q=0.8")
	if jsonBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return nil, &errSourceUnavailable{SourceKey: sourceKey, Reason: fmt.Sprintf("fetch %s: %v", exportURL, err)}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, &errSourceUnavailable{SourceKey: sourceKey, Reason: fmt.Sprintf("%s returned HTTP %d", exportURL, resp.StatusCode)}
	}
	return io.ReadAll(resp.Body)
}

// openRegisterWorkbook opens an export as XLSX; an unparseable payload (for
// example an HTML block page) is treated as the source being unavailable.
func openRegisterWorkbook(sourceKey string, data []byte) (*excelize.File, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return nil, &errSourceUnavailable{SourceKey: sourceKey, Reason: fmt.Sprintf("export was not a parseable workbook: %v", err)}
	}
	return f, nil
}

func downloadDateUTC() time.Time {
	return time.Now().UTC().Truncate(24 * time.Hour)
}

// --- Register of Lobbyists (agd-register-lobbyists) ------------------------

// ingestLobbyistRegister downloads the register's own XLSX export and returns
// the parsed client rows plus the download date (used as as_of — the register
// is a point-in-time snapshot).
func ingestLobbyistRegister(ctx context.Context) ([]LobbyistClientRow, time.Time, error) {
	// This is the exact request the register UI's "Download the register"
	// button sends; a bare POST is rejected by the API.
	payload := map[string]any{
		"fileExtension": "xlsx",
		"searchCriteria": map[string]any{
			"entity":       "all",
			"query":        "",
			"pageNumber":   1,
			"pagingCookie": nil,
			"count":        10,
			"sortCriteria": map[string]any{
				"fieldName": "",
				"sortOrder": 0,
			},
			"isDeregistered": false,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("marshal lobbyist download request: %w", err)
	}
	data, err := downloadRegisterExport(ctx, lobbyistsSource, http.MethodPost, lobbyistRegisterExportURL, body)
	if err != nil {
		return nil, time.Time{}, err
	}
	rows, err := parseLobbyistRegisterXLSX(data)
	if err != nil {
		return nil, time.Time{}, err
	}
	return rows, downloadDateUTC(), nil
}

// parseLobbyistRegisterXLSX finds the "Clients" worksheet (by its headers, not
// its name) and parses it.
func parseLobbyistRegisterXLSX(data []byte) ([]LobbyistClientRow, error) {
	f, err := openRegisterWorkbook(lobbyistsSource, data)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	for _, sheet := range f.GetSheetList() {
		rows, err := f.GetRows(sheet)
		if err != nil || len(rows) == 0 {
			continue
		}
		parsed, err := parseLobbyistClientRows(rows)
		if err == nil && len(parsed) > 0 {
			return parsed, nil
		}
	}
	return nil, fmt.Errorf("no lobbyist client worksheet found")
}

// parseLobbyistClientRows parses the Clients sheet rows:
// Client's Name | ABN | Date Published | Parent Organisation | Organisation's ABN
func parseLobbyistClientRows(rows [][]string) ([]LobbyistClientRow, error) {
	headerIdx := -1
	var headers []string
	limit := len(rows)
	if limit > 15 {
		limit = 15
	}
	for i := 0; i < limit; i++ {
		if columnIndex(rows[i], "Client's Name") >= 0 && columnIndex(rows[i], "Parent Organisation") >= 0 {
			headerIdx = i
			headers = rows[i]
			break
		}
	}
	if headerIdx < 0 {
		return nil, fmt.Errorf("lobbyist clients header row not found")
	}

	cols := struct {
		clientName    int
		clientABN     int
		registrant    int
		registrantABN int
	}{
		clientName:    columnIndex(headers, "Client's Name"),
		clientABN:     columnIndex(headers, "ABN"),
		registrant:    columnIndex(headers, "Parent Organisation"),
		registrantABN: columnIndex(headers, "Organisation's ABN"),
	}

	var out []LobbyistClientRow
	for _, row := range rows[headerIdx+1:] {
		clientName := readColumn(row, cols.clientName)
		if clientName == "" {
			continue
		}
		clientABN := abnDigits.ReplaceAllString(readColumn(row, cols.clientABN), "")
		if len(clientABN) != 11 {
			clientABN = ""
		}
		registrantABN := abnDigits.ReplaceAllString(readColumn(row, cols.registrantABN), "")
		if len(registrantABN) != 11 {
			registrantABN = ""
		}
		out = append(out, LobbyistClientRow{
			ClientName:     clientName,
			ClientABN:      clientABN,
			RegistrantName: readColumn(row, cols.registrant),
			RegistrantABN:  registrantABN,
		})
	}
	return out, nil
}

// buildLobbyistRecords aggregates matched client rows into ONE record per
// matched company: the count of distinct registrants listing that company as
// a client. Returns the records plus the number of rows skipped because they
// resolved to no exact ASX match (including ambiguous names, which never
// reach the name map).
func buildLobbyistRecords(rows []LobbyistClientRow, abnMappings map[string]EntityMapping, nameMappings map[string]CompanyNameMapping, asOf time.Time) ([]IndustryRecord, int) {
	type aggregate struct {
		match       entityMatch
		registrants map[string]string
		clientNames map[string]bool
		clientABNs  map[string]bool
		methods     map[string]bool
		confidence  float64
	}
	aggregates := map[string]*aggregate{}
	skipped := 0
	for _, row := range rows {
		match, ok := matchRegisterEntity(row.ClientABN, row.ClientName, abnMappings, nameMappings)
		if !ok {
			skipped++
			continue
		}
		agg := aggregates[match.StockCode]
		if agg == nil {
			agg = &aggregate{
				match:       match,
				registrants: map[string]string{},
				clientNames: map[string]bool{},
				clientABNs:  map[string]bool{},
				methods:     map[string]bool{},
				confidence:  match.Confidence,
			}
			aggregates[match.StockCode] = agg
		}
		if match.Confidence < agg.confidence {
			agg.confidence = match.Confidence
		}
		if key := counterpartyIdentity(row.RegistrantABN, row.RegistrantName); key != "" {
			agg.registrants[key] = row.RegistrantName
		}
		agg.clientNames[row.ClientName] = true
		if row.ClientABN != "" {
			agg.clientABNs[row.ClientABN] = true
		}
		agg.methods[match.Method] = true
	}

	stockCodes := make([]string, 0, len(aggregates))
	for stockCode := range aggregates {
		stockCodes = append(stockCodes, stockCode)
	}
	sort.Strings(stockCodes)

	records := make([]IndustryRecord, 0, len(aggregates))
	for _, stockCode := range stockCodes {
		agg := aggregates[stockCode]
		count := len(agg.registrants)
		if count == 0 {
			continue // rows carried no identifiable registrant; nothing to count
		}
		value := float64(count)
		noun, verb := "registrants", "list"
		if count == 1 {
			noun, verb = "registrant", "lists"
		}
		records = append(records, IndustryRecord{
			SourceKey:      lobbyistsSource,
			SourceRecordID: "agd-lobbyists:" + stockCode,
			SignalKind:     "policy_footprint",
			Industry:       agg.match.Industry,
			StockCode:      stockCode,
			EntityABN:      singleKey(agg.clientABNs),
			MetricKey:      "registered_lobbyist_engagements",
			MetricLabel:    "Registrants listing the company as a client",
			MetricValue:    &value,
			Unit:           "count",
			AsOf:           asOf,
			Title:          fmt.Sprintf("Register of Lobbyists: %s", agg.match.CompanyName),
			Summary: fmt.Sprintf("%d %s %s %s as a client on the Australian Government Register of Lobbyists, as at %s.",
				count, noun, verb, agg.match.CompanyName, asOf.Format("2 January 2006")),
			SourceURL:  lobbyistRegisterURL,
			Confidence: agg.confidence,
			Metadata: map[string]any{
				"company_name":     agg.match.CompanyName,
				"registrant_count": count,
				"registrants":      sortedValues(agg.registrants),
				"client_names":     sortedKeys(agg.clientNames),
				"match_methods":    sortedKeys(agg.methods),
			},
		})
	}
	return records, skipped
}

func syncLobbyistRegisterRecords(ctx context.Context, pool *pgxpool.Pool, rows []LobbyistClientRow, asOf time.Time) (int, int, error) {
	abnMappings, err := loadEntityMappings(ctx, pool)
	if err != nil {
		return 0, 0, fmt.Errorf("load entity mappings: %w", err)
	}
	nameMappings, err := loadCompanyNameMappings(ctx, pool)
	if err != nil {
		return 0, 0, fmt.Errorf("load company name mappings: %w", err)
	}
	records, skipped := buildLobbyistRecords(rows, abnMappings, nameMappings, asOf)
	imported, err := upsertIndustryRecords(ctx, pool, lobbyistsSource, records)
	return imported, skipped, err
}

// --- Foreign Influence Transparency Scheme (agd-fits-register) -------------

// ingestFITSRegister downloads the FITS "registrants and their activities"
// export and returns unique (registrant, foreign principal) pairs plus the
// download date (as_of).
func ingestFITSRegister(ctx context.Context) ([]FITSArrangementRow, time.Time, error) {
	data, err := downloadRegisterExport(ctx, fitsSource, http.MethodGet, fitsRegisterExportURL, nil)
	if err != nil {
		return nil, time.Time{}, err
	}
	rows, err := parseFITSRegisterXLSX(data)
	if err != nil {
		return nil, time.Time{}, err
	}
	return rows, downloadDateUTC(), nil
}

func parseFITSRegisterXLSX(data []byte) ([]FITSArrangementRow, error) {
	f, err := openRegisterWorkbook(fitsSource, data)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	for _, sheet := range f.GetSheetList() {
		rows, err := f.GetRows(sheet)
		if err != nil || len(rows) == 0 {
			continue
		}
		parsed, err := parseFITSActivityRows(rows)
		if err == nil && len(parsed) > 0 {
			return parsed, nil
		}
	}
	return nil, fmt.Errorf("no FITS activities worksheet found")
}

// fitsHeaderColumns locates the registrant name, registrant ABN, and foreign
// principal name columns. The activities export repeats the header "Name"
// (registrant, then foreign principal) so plain columnIndex can't be used:
// the registrant name is the FIRST "Name" column and the principal name is
// the first "Name" column AFTER the registrant "ABN" column.
func fitsHeaderColumns(row []string) (registrantName, registrantABN, principalName int, ok bool) {
	var nameIdx []int
	registrantABN = -1
	for i, header := range row {
		switch normalizedHeader(header) {
		case "name":
			nameIdx = append(nameIdx, i)
		case "abn":
			if registrantABN < 0 {
				registrantABN = i
			}
		}
	}
	if len(nameIdx) < 2 || registrantABN < 0 {
		return 0, 0, 0, false
	}
	registrantName = nameIdx[0]
	principalName = -1
	for _, idx := range nameIdx {
		if idx > registrantABN {
			principalName = idx
			break
		}
	}
	if principalName < 0 {
		return 0, 0, 0, false
	}
	return registrantName, registrantABN, principalName, true
}

// parseFITSActivityRows parses the registrant x principal x activity rows and
// de-duplicates to unique (registrant, principal) pairs. Activity dates (raw
// Excel serials in this export) are deliberately not parsed: the aggregate
// metric only needs the pair, and as_of is the download date.
func parseFITSActivityRows(rows [][]string) ([]FITSArrangementRow, error) {
	headerIdx := -1
	var nameCol, abnCol, principalCol int
	limit := len(rows)
	if limit > 15 {
		limit = 15
	}
	for i := 0; i < limit; i++ {
		if reg, abn, principal, ok := fitsHeaderColumns(rows[i]); ok {
			headerIdx, nameCol, abnCol, principalCol = i, reg, abn, principal
			break
		}
	}
	if headerIdx < 0 {
		return nil, fmt.Errorf("FITS activities header row not found")
	}

	seen := map[string]bool{}
	var out []FITSArrangementRow
	for _, row := range rows[headerIdx+1:] {
		registrantName := readColumn(row, nameCol)
		principalName := readColumn(row, principalCol)
		if registrantName == "" || principalName == "" {
			continue
		}
		registrantABN := abnDigits.ReplaceAllString(readColumn(row, abnCol), "")
		if len(registrantABN) != 11 {
			registrantABN = ""
		}
		key := counterpartyIdentity(registrantABN, registrantName) + "\x00" +
			strings.ToUpper(strings.Join(strings.Fields(principalName), " "))
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, FITSArrangementRow{
			RegistrantName:       registrantName,
			RegistrantABN:        registrantABN,
			ForeignPrincipalName: principalName,
		})
	}
	return out, nil
}

// buildFITSRecords aggregates matched registrant rows into ONE record per
// matched company: the count of distinct foreign principals the company
// discloses on the FITS register. Returns records plus skipped-row count.
func buildFITSRecords(rows []FITSArrangementRow, abnMappings map[string]EntityMapping, nameMappings map[string]CompanyNameMapping, asOf time.Time) ([]IndustryRecord, int) {
	type aggregate struct {
		match           entityMatch
		principals      map[string]string
		registrantNames map[string]bool
		registrantABNs  map[string]bool
		methods         map[string]bool
		confidence      float64
	}
	aggregates := map[string]*aggregate{}
	skipped := 0
	for _, row := range rows {
		match, ok := matchRegisterEntity(row.RegistrantABN, row.RegistrantName, abnMappings, nameMappings)
		if !ok {
			skipped++
			continue
		}
		agg := aggregates[match.StockCode]
		if agg == nil {
			agg = &aggregate{
				match:           match,
				principals:      map[string]string{},
				registrantNames: map[string]bool{},
				registrantABNs:  map[string]bool{},
				methods:         map[string]bool{},
				confidence:      match.Confidence,
			}
			aggregates[match.StockCode] = agg
		}
		if match.Confidence < agg.confidence {
			agg.confidence = match.Confidence
		}
		key := strings.ToUpper(strings.Join(strings.Fields(row.ForeignPrincipalName), " "))
		agg.principals[key] = row.ForeignPrincipalName
		agg.registrantNames[row.RegistrantName] = true
		if row.RegistrantABN != "" {
			agg.registrantABNs[row.RegistrantABN] = true
		}
		agg.methods[match.Method] = true
	}

	stockCodes := make([]string, 0, len(aggregates))
	for stockCode := range aggregates {
		stockCodes = append(stockCodes, stockCode)
	}
	sort.Strings(stockCodes)

	records := make([]IndustryRecord, 0, len(aggregates))
	for _, stockCode := range stockCodes {
		agg := aggregates[stockCode]
		count := len(agg.principals)
		if count == 0 {
			continue
		}
		value := float64(count)
		summary := fmt.Sprintf("%d foreign principals are disclosed for %s on the Foreign Influence Transparency Scheme public register, as at %s.",
			count, agg.match.CompanyName, asOf.Format("2 January 2006"))
		if count == 1 {
			summary = fmt.Sprintf("1 foreign principal is disclosed for %s on the Foreign Influence Transparency Scheme public register, as at %s.",
				agg.match.CompanyName, asOf.Format("2 January 2006"))
		}
		records = append(records, IndustryRecord{
			SourceKey:      fitsSource,
			SourceRecordID: "agd-fits:" + stockCode,
			SignalKind:     "policy_footprint",
			Industry:       agg.match.Industry,
			StockCode:      stockCode,
			EntityABN:      singleKey(agg.registrantABNs),
			MetricKey:      "registered_foreign_principals",
			MetricLabel:    "Foreign principals disclosed on the FITS register",
			MetricValue:    &value,
			Unit:           "count",
			AsOf:           asOf,
			Title:          fmt.Sprintf("Foreign Influence Transparency Scheme register: %s", agg.match.CompanyName),
			Summary:        summary,
			SourceURL:      fitsRegisterURL,
			Confidence:     agg.confidence,
			Metadata: map[string]any{
				"company_name":            agg.match.CompanyName,
				"foreign_principal_count": count,
				"foreign_principals":      sortedValues(agg.principals),
				"registrant_names":        sortedKeys(agg.registrantNames),
				"match_methods":           sortedKeys(agg.methods),
			},
		})
	}
	return records, skipped
}

func syncFITSRegisterRecords(ctx context.Context, pool *pgxpool.Pool, rows []FITSArrangementRow, asOf time.Time) (int, int, error) {
	abnMappings, err := loadEntityMappings(ctx, pool)
	if err != nil {
		return 0, 0, fmt.Errorf("load entity mappings: %w", err)
	}
	nameMappings, err := loadCompanyNameMappings(ctx, pool)
	if err != nil {
		return 0, 0, fmt.Errorf("load company name mappings: %w", err)
	}
	records, skipped := buildFITSRecords(rows, abnMappings, nameMappings, asOf)
	imported, err := upsertIndustryRecords(ctx, pool, fitsSource, records)
	return imported, skipped, err
}

// --- run wiring -------------------------------------------------------------

// runLobbyistsMode imports both AGD registers, each under its own collection
// run. A register whose official endpoint is unavailable records a failed run
// (metadata.source_unavailable=true) without sinking the other register or
// fabricating data; any other error is fatal after both registers have been
// attempted. markIndustrySourcePublic flips public_enabled through
// upsertIndustryRecords, the same path AusTender uses.
func runLobbyistsMode(ctx context.Context, pool *pgxpool.Pool) {
	lobbyistsErr := runLobbyistRegisterSource(ctx, pool)
	if lobbyistsErr != nil {
		log.Printf("[lobbyists] register run failed: %v", lobbyistsErr)
	}
	fitsErr := runFITSRegisterSource(ctx, pool)
	if fitsErr != nil {
		log.Printf("[fits] register run failed: %v", fitsErr)
	}
	if err := firstHardRegisterError(lobbyistsErr, fitsErr); err != nil {
		fatalf("[lobbyists] run error: %v", err)
	}
}

// firstHardRegisterError returns the first error that is NOT an
// errSourceUnavailable: a blocked source is recorded in its collection run and
// tolerated; anything else should fail the process like the other run* modes.
func firstHardRegisterError(errs ...error) error {
	for _, err := range errs {
		if err == nil {
			continue
		}
		var unavailable *errSourceUnavailable
		if errors.As(err, &unavailable) {
			continue
		}
		return err
	}
	return nil
}

func runLobbyistRegisterSource(ctx context.Context, pool *pgxpool.Pool) error {
	runID, err := insertIndustryCollectionRun(ctx, pool, lobbyistsSource)
	if err != nil {
		return fmt.Errorf("start collection run: %w", err)
	}
	rows, asOf, err := ingestLobbyistRegister(ctx)
	if err != nil {
		finishRegisterRunAfterFailure(ctx, pool, runID, "[lobbyists]", err, map[string]any{
			"register_url": lobbyistRegisterURL,
			"export_url":   lobbyistRegisterExportURL,
		})
		return err
	}
	imported, skipped, err := syncLobbyistRegisterRecords(ctx, pool, rows, asOf)
	if err != nil {
		finishRegisterRunAfterFailure(ctx, pool, runID, "[lobbyists]", err, map[string]any{
			"register_url": lobbyistRegisterURL,
			"export_url":   lobbyistRegisterExportURL,
		})
		return err
	}
	status := "succeeded"
	if imported == 0 && skipped > 0 {
		status = "partial"
	}
	if err := finishIndustryCollectionRun(ctx, pool, runID, status, len(rows), imported, 0, "", map[string]any{
		"register_url":      lobbyistRegisterURL,
		"export_url":        lobbyistRegisterExportURL,
		"as_of":             asOf.Format("2006-01-02"),
		"skipped_unmatched": skipped,
	}); err != nil {
		return fmt.Errorf("finish collection run: %w", err)
	}
	log.Printf("[lobbyists] parsed %d client rows, imported %d aggregate records (%d unmatched rows skipped)", len(rows), imported, skipped)
	return nil
}

func runFITSRegisterSource(ctx context.Context, pool *pgxpool.Pool) error {
	runID, err := insertIndustryCollectionRun(ctx, pool, fitsSource)
	if err != nil {
		return fmt.Errorf("start collection run: %w", err)
	}
	rows, asOf, err := ingestFITSRegister(ctx)
	if err != nil {
		finishRegisterRunAfterFailure(ctx, pool, runID, "[fits]", err, map[string]any{
			"register_url": fitsRegisterURL,
			"export_url":   fitsRegisterExportURL,
		})
		return err
	}
	imported, skipped, err := syncFITSRegisterRecords(ctx, pool, rows, asOf)
	if err != nil {
		finishRegisterRunAfterFailure(ctx, pool, runID, "[fits]", err, map[string]any{
			"register_url": fitsRegisterURL,
			"export_url":   fitsRegisterExportURL,
		})
		return err
	}
	status := "succeeded"
	if imported == 0 && skipped > 0 {
		status = "partial"
	}
	if err := finishIndustryCollectionRun(ctx, pool, runID, status, len(rows), imported, 0, "", map[string]any{
		"register_url":      fitsRegisterURL,
		"export_url":        fitsRegisterExportURL,
		"as_of":             asOf.Format("2006-01-02"),
		"skipped_unmatched": skipped,
	}); err != nil {
		return fmt.Errorf("finish collection run: %w", err)
	}
	log.Printf("[fits] parsed %d registrant/principal pairs, imported %d aggregate records (%d unmatched rows skipped)", len(rows), imported, skipped)
	return nil
}

// finishRegisterRunAfterFailure records a failed collection run, tagging runs
// blocked by an unavailable official endpoint so observability can tell
// "endpoint blocked/unreachable" apart from "collector bug".
func finishRegisterRunAfterFailure(ctx context.Context, pool *pgxpool.Pool, runID, label string, err error, metadata map[string]any) {
	var unavailable *errSourceUnavailable
	if errors.As(err, &unavailable) {
		metadata["source_unavailable"] = true
	}
	finishCollectionRunAfterFailure(ctx, pool, runID, label, err, metadata)
}

// --- small helpers ----------------------------------------------------------

// singleKey returns the sole key of a set, or "" when the set is empty or
// holds more than one value (an aggregate spanning multiple ABNs stores NULL).
func singleKey(set map[string]bool) string {
	if len(set) != 1 {
		return ""
	}
	for key := range set {
		return key
	}
	return ""
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func sortedValues(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for _, value := range m {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}
