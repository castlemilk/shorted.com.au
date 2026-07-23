package main

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type sourceDef struct {
	Key, DisplayName, SignalKind, Publisher, URL, Licence, Cadence, Method, Notes string
}

// signal_kind "economic_series" is allowed by the
// industry_intelligence_sources_kind_check CHECK constraint, extended by
// migration 000082_extend_source_kind_check.
var sourceDefs = []sourceDef{
	{"rba-key-indicators", "RBA key indicators (cash rate, exchange rates)", "economic_series",
		"Reserve Bank of Australia", "https://www.rba.gov.au/statistics/tables/",
		"CC-BY-4.0", "Monthly", "download", "Tables F1.1 + F11; national policy/FX series."},
	{"rba-commodity-prices", "RBA Index of Commodity Prices", "economic_series",
		"Reserve Bank of Australia", "https://www.rba.gov.au/statistics/tables/",
		"CC-BY-4.0", "Monthly", "download", "Table I2"},
	{"rba-credit-aggregates", "RBA Growth in Selected Financial Aggregates", "economic_series",
		"Reserve Bank of Australia", "https://www.rba.gov.au/statistics/tables/",
		"CC-BY-4.0", "Monthly", "download", "Table D1"},
	{"abs-cpi", "ABS Consumer Price Index", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/consumer-price-index-australia/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "All-groups index + annual change via SDMX."},
	{"abs-labour-force", "ABS Labour Force, Australia", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/labour/employment-and-unemployment/labour-force-australia/latest-release",
		"CC-BY-4.0", "Monthly", "download", "Unemployment/participation by state, seasonally adjusted, via SDMX."},
	{"abs-job-vacancies", "ABS Job Vacancies, Australia", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/labour/jobs/job-vacancies-australia/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "Total private and public sector job vacancies by state and Australia, original series, via SDMX."},
	{"abs-wage-price-index", "ABS Wage Price Index, Australia", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/wage-price-index-australia/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "Headline wage price index and annual change by state and Australia, original series, via SDMX."},
	{"abs-household-spending", "ABS Monthly Household Spending Indicator", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/finance/monthly-household-spending-indicator/latest-release",
		"CC-BY-4.0", "Monthly", "download", "Total household spending and through-the-year growth by state and Australia, seasonally adjusted, via SDMX. This broad spending gauge supersedes retail turnover for this use; retail remains available and overlaps by design."},
	{"abs-lending-indicators", "ABS Lending Indicators — housing finance", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/finance/lending-indicators/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "Value of new housing loan commitments for total dwellings excluding refinancing, split by owner-occupier and investor purpose, by state and Australia, seasonally adjusted via SDMX."},
	{"abs-construction-work-done", "ABS Construction Work Done, Australia, Preliminary", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/industry/building-and-construction/construction-work-done-australia-preliminary/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "Building, engineering and total construction work done, chain volume measures, by state and Australia, seasonally adjusted via SDMX; complements building approvals as the activity side of the lead/lag pair."},
	{"abs-merch-trade-state", "ABS International Merchandise Trade by state", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/international-trade/international-trade-goods/latest-release",
		"CC-BY-4.0", "Monthly", "download", "Export/import value by state of origin × SITC section via SDMX."},
	{"abs-state-accounts", "ABS State Final Demand (chain volume, by state)", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-national-income-expenditure-and-product/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "State final demand, chain volume measures, seasonally adjusted, by state via SDMX (ANA_SFD) — an expenditure-side proxy for state economic activity; GSP proper (catalogue 5220.0) is Excel-only and not available via the ABS Data API."},
	{"abs-building-approvals", "ABS Building Approvals, Australia", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/industry/building-and-construction/building-approvals-australia/latest-release",
		"CC-BY-4.0", "Monthly", "download", "Total dwelling units approved by state and territory, original series, via SDMX."},
	{"abs-retail-trade", "ABS Retail Trade, Australia", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/industry/retail-and-wholesale-trade/retail-trade-australia/latest-release",
		"CC-BY-4.0", "Monthly", "download", "Total current-price retail turnover by state and Australia, seasonally adjusted, via SDMX."},
	{"abs-population", "ABS National, state and territory population", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/people/population/national-state-and-territory-population/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "Estimated resident population and natural, interstate and overseas migration components by state and Australia, via SDMX."},
	{"abs-government-finance", "ABS Government Finance Statistics (state general government)", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/government/government-finance-statistics-australia/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "Per-state general-government operating statement — total revenue, total expenses, net operating balance by state (quarterly XLSX data cube, formerly catalogue 5519.0.55.001)."},
	{"dcceew-petroleum-statistics", "Australian Petroleum Statistics", "economic_series",
		"Department of Climate Change, Energy, the Environment and Water", "https://www.energy.gov.au/publications/australian-petroleum-statistics",
		"CC-BY-4.0", "Monthly", "download", "Refinery output, fuel sales by state, petroleum imports/exports (XLSX)."},
	{"derived-shorted-markets", "State and industry short interest (derived)", "economic_series",
		"Shorted (derived from ASIC + exposure model)", "https://shorted.com.au",
		"derived", "Monthly", "derived",
		"Monthly per-state exposure-weighted average short interest, derived in-DB from the ASIC shorts " +
			"history joined to the company→state exposure model (mv_company_state_exposure): each month uses " +
			"every stock's last short observation, weighted by exposure weight × market cap. CAVEAT: the exposure " +
			"weights and market caps are CURRENT (no history), so this applies present-day state composition " +
			"retrospectively to every month — a 'current-constituent basis', the standard fixed-basket " +
			"index-construction caveat. Also includes a simple monthly average by current GICS industry, emitted only " +
			"for industry-months with at least five stocks; those classifications likewise use current membership. " +
			"Short percentages themselves are historical; only the weighting/classification is present-day."},
	{"derived-shorted-economy", "Real wages and merchandise trade balance (derived)", "economic_series",
		"Shorted (derived from ABS economic series)", "https://shorted.com.au",
		"derived", "Monthly + quarterly", "derived",
		"Quarterly real WPI growth and monthly total merchandise trade balance, derived in-DB from imported ABS series. " +
			"CAVEAT: real WPI uses the national CPI index as the deflator for every state and territory because no state CPI series exists; " +
			"it is WPI YoY minus national CPI YoY computed from quarterly index levels, not the monthly CPI annual-change series."},
}

// registerSources upserts this collector's sources into the shared registry.
// public_enabled must NEVER be downgraded by a re-run (existing OR excluded).
func registerSources(ctx context.Context, pool *pgxpool.Pool) error {
	const q = `
		INSERT INTO industry_intelligence_sources
			(source_key, display_name, signal_kind, publisher, source_url,
			 licence, cadence, collection_method, enabled, public_enabled,
			 exact_entity_required, notes)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,TRUE,FALSE,$9)
		ON CONFLICT (source_key) DO UPDATE SET
			display_name = EXCLUDED.display_name,
			publisher = EXCLUDED.publisher,
			source_url = EXCLUDED.source_url,
			licence = EXCLUDED.licence,
			cadence = EXCLUDED.cadence,
			notes = EXCLUDED.notes,
			public_enabled = industry_intelligence_sources.public_enabled OR EXCLUDED.public_enabled,
			updated_at = now()`
	for _, s := range sourceDefs {
		if _, err := pool.Exec(ctx, q, s.Key, s.DisplayName, s.SignalKind, s.Publisher,
			s.URL, s.Licence, s.Cadence, s.Method, s.Notes); err != nil {
			return err
		}
	}
	return nil
}
