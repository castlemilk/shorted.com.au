package main

import (
	"context"
	"fmt"
	"log"
	"strconv"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Codes pinned from the ABS,QBIS(1.0.0) SDMX probe on 2026-07-23.
// Dimension order is MEASURE.PRICE_ADJUSTMENT.INDUSTRY.SCOPE.TSEST.REGION.FREQ.
//
// The three keys deliberately constrain the upstream request to families that
// are current at 2026-Q1: national GOP by ANZSIC division, and all-industry
// sales/wages by region. In particular, no key can request the obsolete
// state-by-industry sales/profit families that stopped at 2022-Q3.
const (
	businessFlow             = "QBIS"
	businessVersion          = "1.0.0"
	businessMeasureSales     = "M1"
	businessMeasureWages     = "M5"
	businessMeasureGOP       = "M7"
	businessPriceCurrent     = "CUR"
	businessIndustryTotal    = "TOT"
	businessScopeTotal       = "TOT"
	businessTsestSeasAdj     = "20"
	businessFreqQuarterly    = "Q"
	businessUnitMultMillions = "6"
	businessStartPeriod      = "2001-Q3"
	businessGOPKey           = "M7.CUR.B+C+D+E+F+G+H+I+J+K+L+M+N+R+S.TOT.20.AUS.Q"
	businessSalesKey         = "M1.CUR.TOT.TOT.20.1+2+3+4+5+6+7+8+AUS.Q"
	businessWagesKey         = "M5.CUR.TOT.TOT.20.1+2+3+4+5+6+7+8+AUS.Q"
)

// anzsicDivisionSlugs is pinned to the 15 division letters present in the
// current, seasonally adjusted QBIS GOP family in the 2026-07-23 probe.
// P and Q occur in other QBIS measures but not this current GOP family; O was
// absent from the probe. Unknown letters are skipped with a warning rather
// than converted from their labels, keeping series identities stable.
//
// IRON RULE: these are ANZSIC divisions. They are not GICS classifications
// and must never be cross-mapped to the markets industrySlugs map.
var anzsicDivisionSlugs = map[string]string{
	"B": "mining",
	"C": "manufacturing",
	"D": "electricity-gas-water-waste",
	"E": "construction",
	"F": "wholesale-trade",
	"G": "retail-trade",
	"H": "accommodation-food-services",
	"I": "transport-postal-warehousing",
	"J": "information-media-telecommunications",
	"K": "financial-insurance-services",
	"L": "rental-hiring-real-estate",
	"M": "professional-scientific-technical",
	"N": "administrative-support",
	"R": "arts-recreation",
	"S": "other-services",
}

func ingestBusiness(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	queries := []struct {
		name string
		key  string
	}{
		{name: "gross operating profit", key: businessGOPKey},
		{name: "sales totals", key: businessSalesKey},
		{name: "wages totals", key: businessWagesKey},
	}
	var obs []Obs
	for _, query := range queries {
		rows, err := c.FetchSDMXCSV(ctx, businessFlow+","+businessVersion, query.key, businessStartPeriod)
		if err != nil {
			return nil, fmt.Errorf("fetch QBIS %s: %w", query.name, err)
		}
		parsed, err := parseBusiness(rows)
		if err != nil {
			return nil, err
		}
		obs = append(obs, parsed...)
	}
	return obs, nil
}

func parseBusiness(rows [][]string) ([]Obs, error) {
	if len(rows) < 2 {
		return nil, nil
	}
	idx := absdata.ColIndex(rows[0])
	requiredColumns := []string{"MEASURE", "PRICE_ADJUSTMENT", "INDUSTRY", "SCOPE", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"}
	if err := requireSDMXColumns(idx, "parseBusiness", requiredColumns...); err != nil {
		return nil, err
	}
	requiredRow := []string{"MEASURE", "PRICE_ADJUSTMENT", "INDUSTRY", "SCOPE", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "UNIT_MULT"}

	var obs []Obs
	for rowIndex, row := range rows[1:] {
		csvRow := rowIndex + 2
		if err := requireSDMXRow(row, idx, "parseBusiness", csvRow, requiredRow...); err != nil {
			return nil, err
		}
		valueCell := absdata.Cell(row, idx["OBS_VALUE"])
		if valueCell == "" {
			continue
		}

		measureCode := absdata.Code(absdata.Cell(row, idx["MEASURE"]))
		industryCode := absdata.Code(absdata.Cell(row, idx["INDUSTRY"]))
		regionCode := absdata.Code(absdata.Cell(row, idx["REGION"]))
		if absdata.Code(absdata.Cell(row, idx["PRICE_ADJUSTMENT"])) != businessPriceCurrent ||
			absdata.Code(absdata.Cell(row, idx["SCOPE"])) != businessScopeTotal ||
			absdata.Code(absdata.Cell(row, idx["TSEST"])) != businessTsestSeasAdj ||
			absdata.Code(absdata.Cell(row, idx["FREQ"])) != businessFreqQuarterly {
			continue
		}

		metric := ""
		product := ""
		var anzsicDivision string
		switch measureCode {
		case businessMeasureGOP:
			if regionCode != "AUS" || industryCode == businessIndustryTotal {
				continue
			}
			var ok bool
			product, ok = anzsicDivisionSlugs[industryCode]
			if !ok {
				log.Printf("business: skipped unknown ANZSIC division %q at CSV row %d", industryCode, csvRow)
				continue
			}
			metric = "gross_operating_profit"
			anzsicDivision = industryCode
		case businessMeasureSales:
			if industryCode != businessIndustryTotal {
				continue
			}
			metric, product = "sales", "total"
		case businessMeasureWages:
			if industryCode != businessIndustryTotal {
				continue
			}
			metric, product = "wages", "total"
		default:
			continue
		}

		region, ok := lfStates[regionCode]
		if !ok {
			continue
		}
		period, frequency, ok := absdata.PeriodDate(absdata.Cell(row, idx["TIME_PERIOD"]))
		if !ok {
			continue
		}
		unitMult := absdata.Code(absdata.Cell(row, idx["UNIT_MULT"]))
		if unitMult != businessUnitMultMillions {
			return nil, fmt.Errorf("parseBusiness: CSV row %d has unexpected UNIT_MULT code %q, want %s", csvRow, unitMult, businessUnitMultMillions)
		}
		scale, err := sdmxScaleStrict(absdata.Cell(row, idx["UNIT_MULT"]), "parseBusiness", csvRow)
		if err != nil {
			return nil, err
		}
		value, err := strconv.ParseFloat(valueCell, 64)
		if err != nil {
			return nil, fmt.Errorf("parseBusiness: CSV row %d has malformed OBS_VALUE: %w", csvRow, err)
		}
		dimensions := map[string]string{
			"abs_dataflow":         businessFlow,
			"abs_dataflow_version": businessVersion,
			"measure":              measureCode,
			"price_adjustment":     businessPriceCurrent,
			"industry":             industryCode,
			"scope":                businessScopeTotal,
			"tsest":                businessTsestSeasAdj,
			"region":               regionCode,
			"freq":                 businessFreqQuarterly,
			"unit_mult":            unitMult,
		}
		if anzsicDivision != "" {
			dimensions["anzsic_division"] = anzsicDivision
		}
		obs = append(obs, Obs{
			Series: SeriesDef{
				Topic: "business", Metric: metric, Product: product,
				RegionType: region[2], RegionCode: region[0], RegionName: region[1],
				Unit: "aud", Frequency: frequency, Adjustment: "seasadj",
				SourceKey: "abs-business-indicators", Licence: absdata.Licence,
				Dimensions: dimensions,
			},
			Period: period,
			Value:  value * scale,
		})
	}
	return obs, nil
}
