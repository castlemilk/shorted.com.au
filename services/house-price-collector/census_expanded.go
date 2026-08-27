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

	censusG17Entry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G17_AUST_SAL.csv"
	censusG25Entry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G25_AUST_SAL.csv"
	censusG32Entry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G32_AUST_SAL.csv"
	censusG33Entry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G33_AUST_SAL.csv"
	censusG36Entry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G36_AUST_SAL.csv"
	censusG43Entry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G43_AUST_SAL.csv"
	censusG46Entry = "2021 Census GCP Suburbs and Localities for AUS/2021Census_G46_AUST_SAL.csv"
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

// G17 personal-income bands. "Low" means $1-$499 per week; "high" means
// $2,000+ per week. Nil/negative income is excluded from both numerators. The
// assumed G17 table total is the denominator for both shares.
func parseG17(rows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	return parseExpandedRates("G17", rows, populations, logger, []expandedRateDefinition{
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

func parseG25(rows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	return parseExpandedRates("G25", rows, populations, logger, []expandedRateDefinition{
		{
			name: "pct_couple_with_children", numerators: []string{"CF_Ch_F"}, denominator: "Tot_F",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctCoupleWithChildren = value },
		},
		{
			name: "pct_lone_person_household", numerators: []string{"Lone_pers_H"}, denominator: "Tot_H",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctLonePersonHousehold = value },
		},
	})
}

func parseDwellingStructure(table string, rows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	return parseExpandedRates(table, rows, populations, logger, []expandedRateDefinition{
		{
			name: "pct_separate_house", numerators: []string{"OPD_Sep_house_Tot"}, denominator: "OPDs_Tot",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctSeparateHouse = value },
		},
		{
			name: "pct_flat_apartment", numerators: []string{"OPD_Flat_apart_Tot"}, denominator: "OPDs_Tot",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctFlatApartment = value },
		},
	})
}

func parseG43(rows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	return parseExpandedRates("G43", rows, populations, logger, []expandedRateDefinition{
		{
			name: "unemployment_rate", numerators: []string{"P_Tot_Unemp_Tot"}, denominator: "P_Tot_LF_Tot",
			set: func(stats *expandedCensusStats, value *float64) { stats.unemploymentRate = value },
		},
		{
			name: "labour_force_participation_rate", numerators: []string{"P_Tot_LF_Tot"}, denominator: "P_15yr_over_Tot",
			set: func(stats *expandedCensusStats, value *float64) { stats.labourForceParticipationRate = value },
		},
	})
}

func parseG46(rows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	return parseExpandedRates("G46", rows, populations, logger, []expandedRateDefinition{
		{
			name:        "pct_bachelor_or_higher",
			numerators:  []string{"P_PGrad_Deg_Tot", "P_GradDip_and_GradCert_Tot", "P_BachDeg_Tot"},
			denominator: "P_Tot_Tot",
			set:         func(stats *expandedCensusStats, value *float64) { stats.pctBachelorOrHigher = value },
		},
	})
}

// G33 is assumed to be the tenure-type table. It fills the four nullable
// columns created with suburb_demographics in migration 000055.
func parseG33(rows [][]string, populations map[string]*int, logger *log.Logger) map[string]expandedCensusStats {
	out := parseExpandedRates("G33", rows, populations, logger, []expandedRateDefinition{
		{
			name: "pct_owned_outright", numerators: []string{"O_OR_Tot"}, denominator: "Tot_Tot",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctOwnedOutright = value },
		},
		{
			name: "pct_owned_mortgage", numerators: []string{"O_MTG_Tot"}, denominator: "Tot_Tot",
			set: func(stats *expandedCensusStats, value *float64) { stats.pctOwnedMortgage = value },
		},
		{
			name: "pct_rented", numerators: []string{"R_RE_Tot"}, denominator: "Tot_Tot",
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
	totalIndex, hasTotal := columns["Tot_Tot"]
	if !hasCode || !hasTotal {
		if !hasTotal {
			logger.Printf("[G33] metric dwelling_count missing header Tot_Tot; leaving NULL")
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

func hasDwellingStructure(stats map[string]expandedCensusStats) bool {
	for _, row := range stats {
		if row.pctSeparateHouse != nil || row.pctFlatApartment != nil {
			return true
		}
	}
	return false
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

	mergeExpandedCensus(out, read("G17", censusG17Entry, parseG17))
	mergeExpandedCensus(out, read("G25", censusG25Entry, parseG25))
	dwelling := read("G32", censusG32Entry, func(rows [][]string, population map[string]*int, l *log.Logger) map[string]expandedCensusStats {
		return parseDwellingStructure("G32", rows, population, l)
	})
	if !hasDwellingStructure(dwelling) {
		dwelling = read("G36", censusG36Entry, func(rows [][]string, population map[string]*int, l *log.Logger) map[string]expandedCensusStats {
			return parseDwellingStructure("G36", rows, population, l)
		})
	}
	mergeExpandedCensus(out, dwelling)
	mergeExpandedCensus(out, read("G33", censusG33Entry, parseG33))
	mergeExpandedCensus(out, read("G43", censusG43Entry, parseG43))
	mergeExpandedCensus(out, read("G46", censusG46Entry, parseG46))
	return out
}
