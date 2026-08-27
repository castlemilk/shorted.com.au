package main

import (
	"archive/zip"
	"log"
	"strconv"
	"strings"
)

const (
	// Census randomisation can make rates based on tiny cells misleading. All
	// derived rates remain NULL for SALs below this G01 total-person population.
	censusDerivedRateMinPopulation = 100

	censusG17BEntry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G17B_AUST_SAL.csv"
	censusG17CEntry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G17C_AUST_SAL.csv"
	censusG36Entry  = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G36_AUST_SAL.csv"
	censusG37Entry  = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G37_AUST_SAL.csv"
	censusG42Entry  = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G42_AUST_SAL.csv"
	censusG43Entry  = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G43_AUST_SAL.csv"
)

// expandedCensusStats is the curated cross-table result for one SAL. Every
// pointer is nil until its exact short-header columns are present and usable.
type expandedCensusStats struct {
	pctLowPersonalIncome         *float64
	pctHighPersonalIncome        *float64
	unemploymentRate             *float64
	labourForceParticipationRate *float64
	pctBachelorOrHigher          *float64
	pctSeparateHouse             *float64
	pctFlatApartment             *float64
	pctCoupleWithChildren        *float64
	pctLonePersonHousehold       *float64
	pctOwnedOutright             *float64
	pctOwnedMortgage             *float64
	pctRented                    *float64
	dwellingCount                *int
}

type expandedRateDefinition struct {
	name        string
	numerators  []string
	denominator string
	set         func(*expandedCensusStats, *float64)
}

func parseExpandedCount(value string) (*int, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, false
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 0 {
		return nil, false
	}
	return &n, true
}

func populationSupportsDerivedRates(populations map[string]*int, code string) bool {
	population := populations[code]
	return population != nil && *population >= censusDerivedRateMinPopulation
}

func boundedPct(numerator, denominator int) *float64 {
	if denominator <= 0 || numerator < 0 {
		return nil
	}
	pct := float64(numerator) / float64(denominator) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return &pct
}

// parseExpandedRates resolves every value by exact CSV header name. A missing
// metric column disables only that metric and is logged; it never shifts to a
// positional fallback or fails the Census run.
func parseExpandedRates(table string, rows [][]string, populations map[string]*int, logger *log.Logger, definitions []expandedRateDefinition) map[string]expandedCensusStats {
	out := map[string]expandedCensusStats{}
	if logger == nil {
		logger = log.Default()
	}
	if len(rows) < 2 {
		logger.Printf("[%s] no data rows; expanded metrics left NULL", table)
		return out
	}
	columns := csvColIndex(rows[0])
	codeIndex, ok := columns["SAL_CODE_2021"]
	if !ok {
		logger.Printf("[%s] missing header SAL_CODE_2021; expanded metrics left NULL", table)
		return out
	}

	valid := make([]bool, len(definitions))
	for i, definition := range definitions {
		missing := make([]string, 0)
		for _, header := range append(append([]string{}, definition.numerators...), definition.denominator) {
			if _, exists := columns[header]; !exists {
				missing = append(missing, header)
			}
		}
		if len(missing) > 0 {
			logger.Printf("[%s] metric %s missing header(s) %s; leaving NULL", table, definition.name, strings.Join(missing, ", "))
			continue
		}
		valid[i] = true
	}

	for _, row := range rows[1:] {
		code := stripSALPrefix(cell(row, codeIndex))
		if code == "" {
			continue
		}
		stats := out[code]
		if !populationSupportsDerivedRates(populations, code) {
			out[code] = stats
			continue
		}
		for i, definition := range definitions {
			if !valid[i] {
				continue
			}
			denominator, ok := parseExpandedCount(cell(row, columns[definition.denominator]))
			if !ok || *denominator == 0 {
				continue
			}
			numerator := 0
			complete := true
			for _, header := range definition.numerators {
				count, present := parseExpandedCount(cell(row, columns[header]))
				if !present {
					complete = false
					break
				}
				numerator += *count
			}
			if complete {
				definition.set(&stats, boundedPct(numerator, *denominator))
			}
		}
		out[code] = stats
	}
	return out
}

type expandedColumnSource struct {
	fromG17C bool
	index    int
}

// combineG17Rows joins G17B and G17C by exact SAL code and exact header name.
// A non-SAL header present in both files is deliberately omitted so
// parseExpandedRates leaves every metric that depends on it NULL.
func combineG17Rows(g17BRows, g17CRows [][]string, logger *log.Logger) [][]string {
	if logger == nil {
		logger = log.Default()
	}
	missing := make([]string, 0, 2)
	if len(g17BRows) < 2 {
		missing = append(missing, "G17B")
	}
	if len(g17CRows) < 2 {
		missing = append(missing, "G17C")
	}
	if len(missing) > 0 {
		logger.Printf("[G17B+G17C] missing %s data; both income metrics left NULL", strings.Join(missing, " and "))
		return nil
	}

	g17BColumns := csvColIndex(g17BRows[0])
	g17CColumns := csvColIndex(g17CRows[0])
	g17BCodeIndex, hasG17BCode := g17BColumns["SAL_CODE_2021"]
	g17CCodeIndex, hasG17CCode := g17CColumns["SAL_CODE_2021"]
	if !hasG17BCode || !hasG17CCode {
		missing = missing[:0]
		if !hasG17BCode {
			missing = append(missing, "G17B")
		}
		if !hasG17CCode {
			missing = append(missing, "G17C")
		}
		logger.Printf("[G17B+G17C] missing SAL_CODE_2021 in %s; both income metrics left NULL", strings.Join(missing, " and "))
		return nil
	}

	collisions := map[string]bool{}
	for header := range g17BColumns {
		if header == "" || header == "SAL_CODE_2021" {
			continue
		}
		if _, exists := g17CColumns[header]; exists {
			collisions[header] = true
		}
	}
	loggedCollision := map[string]bool{}
	for _, rawHeader := range g17BRows[0] {
		header := strings.TrimSpace(rawHeader)
		if collisions[header] && !loggedCollision[header] {
			logger.Printf("[G17B+G17C] duplicate non-SAL header %s across entries; leaving colliding header unresolved", header)
			loggedCollision[header] = true
		}
	}

	header := []string{"SAL_CODE_2021"}
	sources := make([]expandedColumnSource, 0, len(g17BRows[0])+len(g17CRows[0])-2)
	seen := map[string]bool{"SAL_CODE_2021": true}
	appendColumns := func(row []string, columns map[string]int, fromG17C bool) {
		for _, rawHeader := range row {
			name := strings.TrimSpace(rawHeader)
			if name == "" || seen[name] || collisions[name] {
				continue
			}
			seen[name] = true
			header = append(header, name)
			sources = append(sources, expandedColumnSource{fromG17C: fromG17C, index: columns[name]})
		}
	}
	appendColumns(g17BRows[0], g17BColumns, false)
	appendColumns(g17CRows[0], g17CColumns, true)

	g17CRowsByCode := make(map[string][]string, len(g17CRows)-1)
	for _, row := range g17CRows[1:] {
		code := stripSALPrefix(cell(row, g17CCodeIndex))
		if code != "" {
			g17CRowsByCode[code] = row
		}
	}

	combined := make([][]string, 1, len(g17BRows))
	combined[0] = header
	for _, g17BRow := range g17BRows[1:] {
		code := stripSALPrefix(cell(g17BRow, g17BCodeIndex))
		g17CRow, exists := g17CRowsByCode[code]
		if code == "" || !exists {
			continue
		}
		row := make([]string, 1, len(header))
		row[0] = code
		for _, source := range sources {
			sourceRow := g17BRow
			if source.fromG17C {
				sourceRow = g17CRow
			}
			row = append(row, cell(sourceRow, source.index))
		}
		combined = append(combined, row)
	}
	return combined
}

// G17 personal-income bands span G17B and G17C. "Low" means $1-$499
// per week; "high" means $2,000+ per week. Both use G17C's P_Tot_Tot.
func parseG17(g17BRows, g17CRows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	rows := combineG17Rows(g17BRows, g17CRows, logger)
	if rows == nil {
		return map[string]expandedCensusStats{}
	}
	return parseExpandedRates("G17B+G17C", rows, populations, logger, []expandedRateDefinition{
		{
			name: "pct_low_personal_income",
			numerators: []string{
				"P_1_149_Tot", "P_150_299_Tot", "P_300_399_Tot", "P_400_499_Tot",
			},
			denominator: "P_Tot_Tot",
			set:         func(stats *expandedCensusStats, value *float64) { stats.pctLowPersonalIncome = value },
		},
		{
			name: "pct_high_personal_income",
			numerators: []string{
				"P_2000_2999_Tot", "P_3000_3499_Tot", "P_3500_more_Tot",
			},
			denominator: "P_Tot_Tot",
			set:         func(stats *expandedCensusStats, value *float64) { stats.pctHighPersonalIncome = value },
		},
	})
}

func parseG36(rows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	return parseExpandedRates("G36", rows, populations, logger, []expandedRateDefinition{
		{
			name: "pct_separate_house", numerators: []string{"OPDs_Separate_house_Dwellings"}, denominator: "OPDs_Tot_OPDs_Dwellings",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctSeparateHouse = value },
		},
		{
			name: "pct_flat_apartment", numerators: []string{"OPDs_Flt_apart_Tot_Dwgs"}, denominator: "OPDs_Tot_OPDs_Dwellings",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctFlatApartment = value },
		},
	})
}

func parseG42(rows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	return parseExpandedRates("G42", rows, populations, logger, []expandedRateDefinition{
		{
			name: "pct_couple_with_children", numerators: []string{"Tot_FHs_CF_C"}, denominator: "Tot_Tot",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctCoupleWithChildren = value },
		},
		{
			name: "pct_lone_person_household", numerators: []string{"Tot_Lone_P_H"}, denominator: "Tot_Tot",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctLonePersonHousehold = value },
		},
	})
}

func parseG43(rows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	return parseExpandedRates("G43", rows, populations, logger, []expandedRateDefinition{
		{
			name: "unemployment_rate", numerators: []string{"lfs_Unmplyed_lookng_for_wrk_P"}, denominator: "lfs_Tot_LF_P",
			set: func(stats *expandedCensusStats, value *float64) { stats.unemploymentRate = value },
		},
		{
			name: "labour_force_participation_rate", numerators: []string{"lfs_Tot_LF_P"}, denominator: "P_15_yrs_over_P",
			set: func(stats *expandedCensusStats, value *float64) { stats.labourForceParticipationRate = value },
		},
		{
			name:        "pct_bachelor_or_higher",
			numerators:  []string{"non_sch_qual_PostGrad_Dgre_P", "non_sch_qual_Gr_Dip_Gr_Crt_P", "non_sch_qual_Bchelr_Degree_P"},
			denominator: "P_15_yrs_over_P",
			set:         func(stats *expandedCensusStats, value *float64) { stats.pctBachelorOrHigher = value },
		},
	})
}

// G37 supplies both tenure rates and the raw total dwelling count. The count
// is intentionally populated outside the derived-rate population guard.
func parseG37(rows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	out := parseExpandedRates("G37", rows, populations, logger, []expandedRateDefinition{
		{
			name: "pct_owned_outright", numerators: []string{"O_OR_Total"}, denominator: "Total_Total",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctOwnedOutright = value },
		},
		{
			name: "pct_owned_mortgage", numerators: []string{"O_MTG_Total"}, denominator: "Total_Total",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctOwnedMortgage = value },
		},
		{
			name: "pct_rented", numerators: []string{"R_Tot_Total"}, denominator: "Total_Total",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctRented = value },
		},
	})
	if logger == nil {
		logger = log.Default()
	}
	if len(rows) < 2 {
		return out
	}
	columns := csvColIndex(rows[0])
	codeIndex, hasCode := columns["SAL_CODE_2021"]
	totalIndex, hasTotal := columns["Total_Total"]
	if !hasCode || !hasTotal {
		if !hasTotal {
			logger.Printf("[G37] metric dwelling_count missing header Total_Total; leaving NULL")
		}
		return out
	}
	for _, row := range rows[1:] {
		code := stripSALPrefix(cell(row, codeIndex))
		if code == "" {
			continue
		}
		stats := out[code]
		if total, ok := parseExpandedCount(cell(row, totalIndex)); ok {
			stats.dwellingCount = total
		}
		out[code] = stats
	}
	return out
}

func mergeExpandedCensus(into map[string]expandedCensusStats, from map[string]expandedCensusStats) {
	for code, next := range from {
		current := into[code]
		if next.pctLowPersonalIncome != nil {
			current.pctLowPersonalIncome = next.pctLowPersonalIncome
		}
		if next.pctHighPersonalIncome != nil {
			current.pctHighPersonalIncome = next.pctHighPersonalIncome
		}
		if next.unemploymentRate != nil {
			current.unemploymentRate = next.unemploymentRate
		}
		if next.labourForceParticipationRate != nil {
			current.labourForceParticipationRate = next.labourForceParticipationRate
		}
		if next.pctBachelorOrHigher != nil {
			current.pctBachelorOrHigher = next.pctBachelorOrHigher
		}
		if next.pctSeparateHouse != nil {
			current.pctSeparateHouse = next.pctSeparateHouse
		}
		if next.pctFlatApartment != nil {
			current.pctFlatApartment = next.pctFlatApartment
		}
		if next.pctCoupleWithChildren != nil {
			current.pctCoupleWithChildren = next.pctCoupleWithChildren
		}
		if next.pctLonePersonHousehold != nil {
			current.pctLonePersonHousehold = next.pctLonePersonHousehold
		}
		if next.pctOwnedOutright != nil {
			current.pctOwnedOutright = next.pctOwnedOutright
		}
		if next.pctOwnedMortgage != nil {
			current.pctOwnedMortgage = next.pctOwnedMortgage
		}
		if next.pctRented != nil {
			current.pctRented = next.pctRented
		}
		if next.dwellingCount != nil {
			current.dwellingCount = next.dwellingCount
		}
		into[code] = current
	}
}

// parseExpandedCensus reads optional tables from the already-open DataPack.
// Entry/header drift is non-fatal: it is logged and leaves the affected values
// NULL so a guessed short header can never silently write the wrong metric.
func parseExpandedCensus(zr *zip.ReadCloser, g01 map[string]g01Row, logger *log.Logger) map[string]expandedCensusStats {
	if logger == nil {
		logger = log.Default()
	}
	populations := make(map[string]*int, len(g01))
	for code, row := range g01 {
		populations[code] = row.pop
	}
	out := map[string]expandedCensusStats{}
	read := func(table, entry string, parse func([][]string, map[string]*int, *log.Logger) map[string]expandedCensusStats) map[string]expandedCensusStats {
		rows, err := readZipCSV(zr, entry)
		if err != nil {
			logger.Printf("[%s] %v; expanded metrics left NULL", table, err)
			return nil
		}
		return parse(rows, populations, logger)
	}

	g17BRows, err := readZipCSV(zr, censusG17BEntry)
	if err != nil {
		logger.Printf("[G17B] %v; both income metrics left NULL", err)
	}
	g17CRows, err := readZipCSV(zr, censusG17CEntry)
	if err != nil {
		logger.Printf("[G17C] %v; both income metrics left NULL", err)
	}
	mergeExpandedCensus(out, parseG17(g17BRows, g17CRows, populations, logger))
	mergeExpandedCensus(out, read("G36", censusG36Entry, parseG36))
	mergeExpandedCensus(out, read("G37", censusG37Entry, parseG37))
	mergeExpandedCensus(out, read("G42", censusG42Entry, parseG42))
	mergeExpandedCensus(out, read("G43", censusG43Entry, parseG43))
	return out
}
