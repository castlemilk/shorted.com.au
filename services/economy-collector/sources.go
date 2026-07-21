package main

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type sourceDef struct {
	Key, DisplayName, SignalKind, Publisher, URL, Licence, Cadence, Method, Notes string
}

// NOTE: signal_kind values below use "economic_series", which does NOT satisfy
// the industry_intelligence_sources_kind_check CHECK constraint defined in
// services/migrations/000075_add_industry_intelligence_sources.up.sql (allowed
// values: short_interest | trade_exposure | public_money | tax_environment |
// policy_footprint | emissions). This was flagged during Task 3 implementation
// as a schema mismatch requiring a decision (extend the CHECK constraint via a
// new migration, or pick a different registry) rather than inventing a fix.
// See the Task 3 completion report for detail.
var sourceDefs = []sourceDef{
	{"rba-key-indicators", "RBA key indicators (cash rate, exchange rates)", "economic_series",
		"Reserve Bank of Australia", "https://www.rba.gov.au/statistics/tables/",
		"CC-BY-4.0", "Monthly", "download", "Tables F1.1 + F11; national policy/FX series."},
	{"abs-cpi", "ABS Consumer Price Index", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/consumer-price-index-australia/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "All-groups index + annual change via SDMX."},
	{"abs-labour-force", "ABS Labour Force, Australia", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/labour/employment-and-unemployment/labour-force-australia/latest-release",
		"CC-BY-4.0", "Monthly", "download", "Unemployment/participation by state, seasonally adjusted, via SDMX."},
	{"abs-merch-trade-state", "ABS International Merchandise Trade by state", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/international-trade/international-trade-goods/latest-release",
		"CC-BY-4.0", "Monthly", "download", "Export/import value by state of origin × SITC section via SDMX."},
	{"abs-state-accounts", "ABS State Final Demand (chain volume, by state)", "economic_series",
		"Australian Bureau of Statistics", "https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-national-income-expenditure-and-product/latest-release",
		"CC-BY-4.0", "Quarterly", "download", "State final demand, chain volume measures, seasonally adjusted, by state via SDMX (ANA_SFD) — an expenditure-side proxy for state economic activity; GSP proper (catalogue 5220.0) is Excel-only and not available via the ABS Data API."},
	{"dcceew-petroleum-statistics", "Australian Petroleum Statistics", "economic_series",
		"Department of Climate Change, Energy, the Environment and Water", "https://www.energy.gov.au/publications/australian-petroleum-statistics",
		"CC-BY-4.0", "Monthly", "download", "Refinery output, fuel sales by state, petroleum imports/exports (XLSX)."},
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
