package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The markets importer is unlike every other importer in this collector: it
// does NOT fetch a web source. It DERIVES per-state and per-industry short-
// interest series from data already in the database — the ASIC shorts history
// joined respectively to the company→state exposure model
// (mv_company_state_exposure) and current "company-metadata" classifications.
// So ingestMarkets takes the pgx pool, not an absdata.Client; main.go wraps it
// in a client-shaped closure so it reuses the shared runJob plumbing.
//
// DATA-HONESTY CAVEAT (documented here, in the registry notes, and carried on
// every series' `basis` dimension): the exposure weights AND market caps in
// mv_company_state_exposure are CURRENT — there is no history for either. This
// derivation therefore applies TODAY's state composition and TODAY's caps to
// EVERY historical month ("current-constituent basis"). Industry membership
// is likewise present-day and applied to every historical month. That is a standard,
// well-understood index-construction caveat (the same way a fixed-basket index
// applies present-day constituents backwards) — it is NOT a point-in-time
// reconstruction. The short percentages themselves ARE historical (each month
// uses that month's actual short observations); only the weighting is present-
// day. Consumers must read the series as "how the current WA-exposed cohort
// was shorted over time", not "the WA cohort as it stood each month".
//
// PROD NOTE: this reads mv_company_state_exposure, which is refreshed by a
// separate job (the company-state-exposure pipeline), NOT by this collector.
// On prod that MV must already exist and be populated before `-mode markets`
// runs; the `all` mode runs markets LAST for that reason (though it has no
// in-run dependency on the other importers — they write different topics).

// marketStateNames maps the mv_company_state_exposure `region` code (already a
// lowercase state slug) to its display name. Deliberately excludes
// 'international' and any national aggregate: markets emits per-state series
// only, so exactly these 8 entries → 8 series.
var marketStateNames = map[string]string{
	"nsw": "New South Wales",
	"vic": "Victoria",
	"qld": "Queensland",
	"sa":  "South Australia",
	"wa":  "Western Australia",
	"tas": "Tasmania",
	"nt":  "Northern Territory",
	"act": "Australian Capital Territory",
}

// industrySlugs is pinned to the 25 real GICS industry-group values observed
// in "company-metadata" by the 2026-07-22 DB probe. Series identity must not
// depend on a label-derived fallback: an upstream vocabulary change is skipped
// and surfaced by the drift tripwire instead of silently creating a new key.
var industrySlugs = map[string]string{
	"Materials":                        "materials",
	"Energy":                           "energy",
	"Software & Services":              "software-services",
	"Financial Services":               "financial-services",
	"Health Care Equipment & Services": "health-care-equipment-services",
	"Pharmaceuticals, Biotechnology & Life Sciences": "pharmaceuticals-biotechnology-life-sciences",
	"Capital Goods":                                "capital-goods",
	"Commercial & Professional Services":           "commercial-professional-services",
	"Media & Entertainment":                        "media-entertainment",
	"Food, Beverage & Tobacco":                     "food-beverage-tobacco",
	"Consumer Discretionary Distribution & Retail": "consumer-discretionary-distribution-retail",
	"Consumer Services":                            "consumer-services",
	"Equity Real Estate Investment Trusts (REITs)": "equity-real-estate-investment-trusts-reits",
	"Technology Hardware & Equipment":              "technology-hardware-equipment",
	"Transportation":                               "transportation",
	"Real Estate Management & Development":         "real-estate-management-development",
	"Utilities":                                    "utilities",
	"Telecommunication Services":                   "telecommunication-services",
	"Consumer Durables & Apparel":                  "consumer-durables-apparel",
	"Banks":                                        "banks",
	"Household & Personal Products":                "household-personal-products",
	"Insurance":                                    "insurance",
	"Automobiles & Components":                     "automobiles-components",
	"Consumer Staples Distribution & Retail":       "consumer-staples-distribution-retail",
	"Semiconductors & Semiconductor Equipment":     "semiconductors-semiconductor-equipment",
}

// marketSeriesDef builds the catalog entry for one state's derived short-
// interest series. Returns ok=false for any region that is not one of the 8
// states (international / national / unknown) so the derivation can never emit
// a non-state series.
func marketSeriesDef(region string) (SeriesDef, bool) {
	name, ok := marketStateNames[region]
	if !ok {
		return SeriesDef{}, false
	}
	return SeriesDef{
		Topic:      "markets",
		Metric:     "short_interest_wavg",
		RegionType: "state",
		RegionCode: region,
		RegionName: name,
		Unit:       "percent",
		Frequency:  "monthly",
		Adjustment: "original",
		SourceKey:  "derived-shorted-markets",
		Licence:    "derived",
		Dimensions: map[string]string{
			// current-constituent = present-day weights+caps applied to every
			// historical month (see file header). Carried so any consumer
			// inspecting the series learns the weighting basis.
			"basis":     "current-constituent",
			"weighting": "weight_x_market_cap",
		},
	}, true
}

// marketObs assembles a single derived observation. Pure (no DB): given a
// region code, a month period, and the pre-computed weighted-average short %,
// it produces the Obs with the right SeriesDef. Returns ok=false for non-state
// regions.
func marketObs(region string, period time.Time, value float64) (Obs, bool) {
	def, ok := marketSeriesDef(region)
	if !ok {
		return Obs{}, false
	}
	return Obs{Series: def, Period: period, Value: value}, true
}

type industryMarketRow struct {
	Industry     string
	Period       time.Time
	Average      float64
	Constituents int64
}

type industryMarketStats struct {
	MappedConstituentMonths   int64
	UnmappedConstituentMonths int64
	UnmappedRows              int
}

func industryMarketObs(row industryMarketRow, slug string) Obs {
	return Obs{
		Series: SeriesDef{
			Topic:      "markets",
			Metric:     "short_interest_avg",
			Product:    slug,
			RegionType: "national",
			RegionCode: "aus",
			RegionName: "Australia",
			Unit:       "percent",
			Frequency:  "monthly",
			Adjustment: "original",
			SourceKey:  "derived-shorted-markets",
			Licence:    "derived",
			Dimensions: map[string]string{
				"industry": row.Industry,
				"basis":    "equal-weight,current-membership",
			},
		},
		Period: row.Period,
		Value:  row.Average,
	}
}

// assembleIndustryMarketObs applies the five-stock noise floor and the GICS
// vocabulary-drift tripwire without a DB dependency. The ratio is based on
// constituent-months, including mapped groups below the noise floor, rather
// than on the number of grouped SQL rows.
func assembleIndustryMarketObs(rows []industryMarketRow) ([]Obs, industryMarketStats, error) {
	stats := industryMarketStats{}
	obs := make([]Obs, 0, len(rows))
	for _, row := range rows {
		slug, mapped := industrySlugs[row.Industry]
		if !mapped {
			stats.UnmappedRows++
			stats.UnmappedConstituentMonths += row.Constituents
			continue
		}
		stats.MappedConstituentMonths += row.Constituents
		if row.Constituents >= 5 {
			obs = append(obs, industryMarketObs(row, slug))
		}
	}

	if stats.UnmappedConstituentMonths*10 > stats.MappedConstituentMonths {
		return nil, stats, fmt.Errorf(
			"industry vocabulary drift: %d unmapped constituent-months exceed 10%% of %d mapped constituent-months",
			stats.UnmappedConstituentMonths, stats.MappedConstituentMonths,
		)
	}
	return obs, stats, nil
}

// marketsQuery is the derivation, kept as an exported-in-package const so a
// future integration test (and the smoke) can target the exact SQL.
//
// Shape: for each stock, take its LAST short observation within each calendar
// month (DISTINCT ON (stock, month) ORDER BY DATE DESC — served by the
// covering index idx_shorts_timeseries_covering on (PRODUCT_CODE, DATE DESC)
// INCLUDE (PERCENT...)); join the exposure model on stock_code; then per
// (region, month) compute the market-cap × exposure-weight weighted average of
// those short percentages over the stocks that HAVE a short obs that month.
// Set-based, one pass, ~100ms locally / seconds on the full ~2.1M-row history.
// ASIC's columns are upper-case and must stay double-quoted; the DATE column
// is a timestamp, so date_trunc('month', ...) buckets it and ::date drops the
// time component for a clean month-start period.
const marketsQuery = `
WITH monthly_last AS (
  SELECT DISTINCT ON (s."PRODUCT_CODE", date_trunc('month', s."DATE"))
    s."PRODUCT_CODE"                                                        AS stock_code,
    date_trunc('month', s."DATE")::date                                    AS month,
    s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"       AS short_pct
  FROM shorts s
  WHERE s."DATE" >= DATE '2015-01-01'
    AND s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
  ORDER BY s."PRODUCT_CODE", date_trunc('month', s."DATE"), s."DATE" DESC
)
SELECT
  e.region,
  m.month,
  SUM(e.weight * e.market_cap * m.short_pct) / NULLIF(SUM(e.weight * e.market_cap), 0) AS wavg
FROM monthly_last m
JOIN mv_company_state_exposure e ON e.stock_code = m.stock_code
WHERE e.region <> 'international'
  AND e.market_cap IS NOT NULL
GROUP BY e.region, m.month
ORDER BY e.region, m.month`

// industryMarketsQuery deliberately mirrors marketsQuery's monthly-last CTE,
// then joins current company metadata and computes a simple (equal-weight)
// average by raw GICS industry. Invalid classifications are excluded in SQL;
// other unknown values remain visible to Go so the pinned-map tripwire can
// count their constituent-months. The five-stock emission floor is applied by
// assembleIndustryMarketObs, keeping that behavior unit-testable.
const industryMarketsQuery = `
WITH monthly_last AS (
  SELECT DISTINCT ON (s."PRODUCT_CODE", date_trunc('month', s."DATE"))
    s."PRODUCT_CODE"                                                        AS stock_code,
    date_trunc('month', s."DATE")::date                                    AS month,
    s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"       AS short_pct
  FROM shorts s
  WHERE s."DATE" >= DATE '2015-01-01'
    AND s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
  ORDER BY s."PRODUCT_CODE", date_trunc('month', s."DATE"), s."DATE" DESC
)
SELECT
  cm.industry,
  m.month,
  AVG(m.short_pct) AS average,
  COUNT(*)         AS constituents
FROM monthly_last m
JOIN "company-metadata" cm ON cm.stock_code = m.stock_code
WHERE NULLIF(BTRIM(cm.industry), '') IS NOT NULL
  AND cm.industry NOT IN ('Not Applic', 'Class Pend')
GROUP BY cm.industry, m.month
ORDER BY cm.industry, m.month`

func deriveStateMarkets(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	rows, err := pool.Query(ctx, marketsQuery)
	if err != nil {
		return nil, fmt.Errorf("derivation query: %w", err)
	}
	defer rows.Close()

	var obs []Obs
	skipped := 0
	for rows.Next() {
		var region string
		var month time.Time
		var wavg float64
		if err := rows.Scan(&region, &month, &wavg); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		o, ok := marketObs(region, month, wavg)
		if !ok {
			// A region the WHERE clause should already exclude — defensive.
			skipped++
			continue
		}
		obs = append(obs, o)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows: %w", err)
	}
	if len(obs) == 0 {
		return nil, fmt.Errorf("derivation produced 0 observations — " +
			"shorts history empty or mv_company_state_exposure unpopulated; treating as drift, not success")
	}
	if skipped > 0 {
		// Not fatal, but surfaced: the query filter and the Go map disagreed.
		fmt.Printf("markets: skipped %d rows with non-state region codes\n", skipped)
	}
	return obs, nil
}

func deriveIndustryMarkets(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	industryRows, err := pool.Query(ctx, industryMarketsQuery)
	if err != nil {
		return nil, fmt.Errorf("derivation query: %w", err)
	}
	defer industryRows.Close()

	var rawIndustryRows []industryMarketRow
	for industryRows.Next() {
		var row industryMarketRow
		if err := industryRows.Scan(&row.Industry, &row.Period, &row.Average, &row.Constituents); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		rawIndustryRows = append(rawIndustryRows, row)
	}
	if err := industryRows.Err(); err != nil {
		return nil, fmt.Errorf("rows: %w", err)
	}
	industryObs, stats, err := assembleIndustryMarketObs(rawIndustryRows)
	if stats.UnmappedRows > 0 {
		fmt.Printf("markets: skipped %d unknown industry-month rows (%d constituent-months; %d mapped constituent-months)\n",
			stats.UnmappedRows, stats.UnmappedConstituentMonths, stats.MappedConstituentMonths)
	}
	if err != nil {
		return nil, err
	}
	if len(industryObs) == 0 {
		return nil, fmt.Errorf("derivation produced 0 observations — " +
			"company metadata missing or every industry is below the five-stock noise floor; treating as drift, not success")
	}
	return industryObs, nil
}

// ingestMarkets runs both independent derivations even when either one fails.
// runJob persists the healthy family's observations alongside the returned
// error, preserving per-family resilience without adding another CLI mode.
func ingestMarkets(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	return runDerivationFamilies(
		derivationFamily{name: "state markets", run: func() ([]Obs, error) {
			return deriveStateMarkets(ctx, pool)
		}},
		derivationFamily{name: "industry markets", run: func() ([]Obs, error) {
			return deriveIndustryMarkets(ctx, pool)
		}},
	)
}
