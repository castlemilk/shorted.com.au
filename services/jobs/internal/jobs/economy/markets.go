package economy

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
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
// Small-cohort states (especially ACT and NT) may also legitimately breach the
// price-return index's ±25% monthly stability band and be excluded run-to-run.
// Consumers must treat a missing state price-return series as an insufficiently
// stable cohort, not as evidence that upstream state exposure data is absent.
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

const exposureMVRefreshedAtQuery = `SELECT max(refreshed_at) FROM mv_company_state_exposure`

func exposureMVStalenessWarning(refreshedAt *time.Time, now time.Time) string {
	if refreshedAt == nil || !refreshedAt.Before(now.Add(-45*24*time.Hour)) {
		return ""
	}
	return fmt.Sprintf(
		"WARNING: mv_company_state_exposure is older than 45 days (last refreshed %s); markets derivation will continue on stale current-constituent weights",
		refreshedAt.UTC().Format(time.RFC3339),
	)
}

func warnIfExposureMVStale(ctx context.Context, pool *pgxpool.Pool) error {
	var refreshedAt *time.Time
	if err := pool.QueryRow(ctx, exposureMVRefreshedAtQuery).Scan(&refreshedAt); err != nil {
		// A rolling deployment may run the new collector before migration
		// 000094. Missing refreshed_at means the guard is unavailable, not that
		// the markets derivation itself is unsafe to run.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42703" {
			return nil
		}
		return fmt.Errorf("check exposure MV refreshed_at: %w", err)
	}
	if warning := exposureMVStalenessWarning(refreshedAt, time.Now()); warning != "" {
		log.Print(warning)
	}
	return nil
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
// INCLUDE (PERCENT...)). One materialized CTE then feeds a UNION ALL of the
// state exposure-weighted family and the equal-weight industry family, tagged
// with a discriminator for the Go assembly paths. Set-based, one shorts scan,
// ~100ms locally / seconds on the full ~2.1M-row history.
// ASIC's columns are upper-case and must stay double-quoted; the DATE column
// is a timestamp, so date_trunc('month', ...) buckets it and ::date drops the
// time component for a clean month-start period.
const marketsQuery = `
WITH monthly_last AS MATERIALIZED (
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
  'state'::text AS family,
  e.region      AS dimension,
  m.month,
  SUM(e.weight * e.market_cap * m.short_pct) / NULLIF(SUM(e.weight * e.market_cap), 0) AS value,
  COUNT(*)::bigint AS constituents
FROM monthly_last m
JOIN mv_company_state_exposure e ON e.stock_code = m.stock_code
WHERE e.region <> 'international'
  AND e.market_cap IS NOT NULL
GROUP BY e.region, m.month

UNION ALL

SELECT
  'industry'::text AS family,
  cm.industry      AS dimension,
  m.month,
  AVG(m.short_pct) AS value,
  COUNT(*)::bigint AS constituents
FROM monthly_last m
JOIN "company-metadata" cm ON cm.stock_code = m.stock_code
WHERE NULLIF(BTRIM(cm.industry), '') IS NOT NULL
  AND cm.industry NOT IN ('Not Applic', 'Class Pend')
GROUP BY cm.industry, m.month
ORDER BY family, dimension, month`

type stateMarketRow struct {
	Region string
	Period time.Time
	Value  float64
}

type shortInterestMarketDerivations struct {
	stateObs    []Obs
	stateErr    error
	industryObs []Obs
	industryErr error
}

func assembleStateMarketObs(rows []stateMarketRow) ([]Obs, error) {
	obs := make([]Obs, 0, len(rows))
	skipped := 0
	for _, row := range rows {
		o, ok := marketObs(row.Region, row.Period, row.Value)
		if !ok {
			skipped++
			continue
		}
		obs = append(obs, o)
	}
	if len(obs) == 0 {
		return nil, fmt.Errorf("derivation produced 0 observations — " +
			"shorts history empty or mv_company_state_exposure unpopulated; treating as drift, not success")
	}
	if skipped > 0 {
		fmt.Printf("markets: skipped %d rows with non-state region codes\n", skipped)
	}
	return obs, nil
}

func assembleIndustryMarketFamily(rows []industryMarketRow) ([]Obs, error) {
	obs, stats, err := assembleIndustryMarketObs(rows)
	if stats.UnmappedRows > 0 {
		fmt.Printf("markets: skipped %d unknown industry-month rows (%d constituent-months; %d mapped constituent-months)\n",
			stats.UnmappedRows, stats.UnmappedConstituentMonths, stats.MappedConstituentMonths)
	}
	if err != nil {
		return nil, err
	}
	if len(obs) == 0 {
		return nil, fmt.Errorf("derivation produced 0 observations — " +
			"company metadata missing or every industry is below the five-stock noise floor; treating as drift, not success")
	}
	return obs, nil
}

// deriveShortInterestMarkets executes the shared monthly_last CTE once, then
// routes discriminator-tagged rows through the existing state and industry
// assembly paths so family-level validation remains independent.
func deriveShortInterestMarkets(ctx context.Context, pool *pgxpool.Pool) shortInterestMarketDerivations {
	rows, err := pool.Query(ctx, marketsQuery)
	if err != nil {
		queryErr := fmt.Errorf("derivation query: %w", err)
		return shortInterestMarketDerivations{stateErr: queryErr, industryErr: queryErr}
	}
	defer rows.Close()

	var stateRows []stateMarketRow
	var industryRows []industryMarketRow
	for rows.Next() {
		var family string
		var dimension string
		var month time.Time
		var value float64
		var constituents int64
		if err := rows.Scan(&family, &dimension, &month, &value, &constituents); err != nil {
			scanErr := fmt.Errorf("scan: %w", err)
			return shortInterestMarketDerivations{stateErr: scanErr, industryErr: scanErr}
		}
		switch family {
		case "state":
			stateRows = append(stateRows, stateMarketRow{Region: dimension, Period: month, Value: value})
		case "industry":
			industryRows = append(industryRows, industryMarketRow{
				Industry: dimension, Period: month, Average: value, Constituents: constituents,
			})
		default:
			scanErr := fmt.Errorf("scan: unknown markets family %q", family)
			return shortInterestMarketDerivations{stateErr: scanErr, industryErr: scanErr}
		}
	}
	if err := rows.Err(); err != nil {
		rowsErr := fmt.Errorf("rows: %w", err)
		return shortInterestMarketDerivations{stateErr: rowsErr, industryErr: rowsErr}
	}
	stateObs, stateErr := assembleStateMarketObs(stateRows)
	industryObs, industryErr := assembleIndustryMarketFamily(industryRows)
	return shortInterestMarketDerivations{
		stateObs: stateObs, stateErr: stateErr,
		industryObs: industryObs, industryErr: industryErr,
	}
}

// ingestMarkets runs all independent derivations even when one fails.
// runJob persists the healthy family's observations alongside the returned
// error, preserving per-family resilience without adding another CLI mode.
func ingestMarkets(ctx context.Context, pool *pgxpool.Pool) ([]Obs, error) {
	if err := warnIfExposureMVStale(ctx, pool); err != nil {
		return nil, err
	}
	shortInterest := deriveShortInterestMarkets(ctx, pool)
	return runDerivationFamilies(
		derivationFamily{name: "state markets", run: func() ([]Obs, error) {
			return shortInterest.stateObs, shortInterest.stateErr
		}},
		derivationFamily{name: "industry markets", run: func() ([]Obs, error) {
			return shortInterest.industryObs, shortInterest.industryErr
		}},
		derivationFamily{name: "state price-return index", run: func() ([]Obs, error) {
			return derivePriceReturnIndexes(ctx, pool)
		}},
	)
}
