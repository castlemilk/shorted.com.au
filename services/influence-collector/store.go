package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func connect(ctx context.Context, dbURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	// SimpleProtocol keeps the Supabase transaction pooler (port 6543) happy —
	// same posture as house-price-collector.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	cfg.MaxConns = 4
	return pgxpool.NewWithConfig(ctx, cfg)
}

// upsertTaxRows idempotently writes tax facts, keyed by (abn, income_year).
// TaxableIncome / TaxPayable bind nil → NULL (a blank cell is meaningful, never 0).
func upsertTaxRows(ctx context.Context, pool *pgxpool.Pool, rows []TaxRow) (int, error) {
	const q = `
		INSERT INTO corporate_tax
			(abn, entity_name, income_year, total_income, taxable_income, tax_payable, source, source_licence)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (abn, income_year) DO UPDATE SET
			entity_name    = EXCLUDED.entity_name,
			total_income   = EXCLUDED.total_income,
			taxable_income = EXCLUDED.taxable_income,
			tax_payable    = EXCLUDED.tax_payable,
			source         = EXCLUDED.source,
			source_licence = EXCLUDED.source_licence`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.ABN, r.EntityName, r.IncomeYear, r.TotalIncome,
			r.TaxableIncome, r.TaxPayable, taxSource, taxSourceLicence)
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// normExpr builds the SQL that normalizes an entity/company name for matching:
// upper-case, punctuation → single space, then strip a trailing corporate suffix
// TWICE (so "WOOLWORTHS GROUP LIMITED" → "WOOLWORTHS GROUP" → "WOOLWORTHS").
func normExpr(col string) string {
	const suffixes = `LIMITED|LTD|GROUP|HOLDINGS|CORPORATION|PLC|TRUST|PTY|PROPRIETARY`
	base := `btrim(regexp_replace(upper(` + col + `), '[^A-Z0-9]+', ' ', 'g'))`
	strip := func(inner string) string {
		return `btrim(regexp_replace(` + inner + `, ' (` + suffixes + `)$', ''))`
	}
	return strip(strip(base))
}

// runMatch (re)builds the exact-name ASX mapping set-based. It normalizes both
// corporate_tax.entity_name and "company-metadata".company_name in SQL, and only
// inserts a mapping when a normalized name resolves to EXACTLY ONE stock_code
// (ambiguous names are skipped). name_exact rows are rebuilt each run; manual rows
// are preserved (ON CONFLICT DO NOTHING). Returns (inserted, skippedAmbiguous).
func runMatch(ctx context.Context, pool *pgxpool.Pool) (int64, int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Rebuild only auto-derived rows; keep any manually-curated mappings.
	if _, err := tx.Exec(ctx, `DELETE FROM entity_asx_map WHERE match_method = 'name_exact'`); err != nil {
		return 0, 0, err
	}

	taxN := normExpr("entity_name")
	compN := normExpr("company_name")

	insertSQL := `
		WITH tax AS (
			SELECT DISTINCT ON (abn) abn, entity_name, ` + taxN + ` AS nname
			FROM corporate_tax
			ORDER BY abn, income_year DESC
		),
		comp AS (
			SELECT stock_code, ` + compN + ` AS nname
			FROM "company-metadata"
			WHERE company_name IS NOT NULL AND btrim(company_name) <> ''
		),
		comp_unique AS (
			SELECT nname, MIN(stock_code) AS stock_code
			FROM comp
			WHERE nname <> ''
			GROUP BY nname
			HAVING COUNT(DISTINCT stock_code) = 1
		)
		INSERT INTO entity_asx_map (abn, stock_code, entity_name, match_method, confidence)
		SELECT t.abn, cu.stock_code, t.entity_name, 'name_exact', 1.0
		FROM tax t
		JOIN comp_unique cu ON cu.nname = t.nname
		WHERE t.nname <> ''
		ON CONFLICT (abn) DO NOTHING`
	tag, err := tx.Exec(ctx, insertSQL)
	if err != nil {
		return 0, 0, err
	}
	inserted := tag.RowsAffected()

	// Count tax entities whose normalized name matched an AMBIGUOUS company name
	// (a normalized name mapping to >1 stock_code) — these were deliberately skipped.
	ambiguousSQL := `
		WITH tax AS (
			SELECT DISTINCT ON (abn) abn, ` + taxN + ` AS nname
			FROM corporate_tax
			ORDER BY abn, income_year DESC
		),
		comp_ambiguous AS (
			SELECT nname
			FROM (SELECT stock_code, ` + compN + ` AS nname FROM "company-metadata"
			      WHERE company_name IS NOT NULL AND btrim(company_name) <> '') c
			WHERE nname <> ''
			GROUP BY nname
			HAVING COUNT(DISTINCT stock_code) > 1
		)
		SELECT COUNT(*) FROM tax t JOIN comp_ambiguous a ON a.nname = t.nname`
	var skipped int64
	if err := tx.QueryRow(ctx, ambiguousSQL).Scan(&skipped); err != nil {
		return inserted, 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return inserted, skipped, err
	}
	return inserted, skipped, nil
}

func upsertIndustrySourceDefinitions(ctx context.Context, pool *pgxpool.Pool, defs []IndustrySourceDefinition) (int, error) {
	const q = `
		INSERT INTO industry_intelligence_sources
			(source_key, display_name, signal_kind, publisher, source_url, licence, cadence,
			 collection_method, enabled, public_enabled, exact_entity_required, notes)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		ON CONFLICT (source_key) DO UPDATE SET
			display_name = EXCLUDED.display_name,
			signal_kind = EXCLUDED.signal_kind,
			publisher = EXCLUDED.publisher,
			source_url = EXCLUDED.source_url,
			licence = EXCLUDED.licence,
			cadence = EXCLUDED.cadence,
			collection_method = EXCLUDED.collection_method,
			enabled = EXCLUDED.enabled,
			-- Never downgrade an earned public flip: markIndustrySourcePublic sets
			-- public_enabled=TRUE after exact-matched records import, and a registry
			-- refresh must not hide already-published records. Un-publishing a source
			-- is a deliberate manual action, not a side effect of a definition sync.
			public_enabled = industry_intelligence_sources.public_enabled OR EXCLUDED.public_enabled,
			exact_entity_required = EXCLUDED.exact_entity_required,
			notes = EXCLUDED.notes,
			updated_at = now()`

	batch := &pgx.Batch{}
	for _, d := range defs {
		batch.Queue(q, d.SourceKey, d.DisplayName, d.SignalKind, d.Publisher, d.SourceURL,
			d.Licence, d.Cadence, d.CollectionMethod, d.Enabled, d.PublicEnabled,
			d.ExactEntityRequired, d.Notes)
	}

	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()

	n := 0
	for range defs {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func insertIndustryCollectionRun(ctx context.Context, pool *pgxpool.Pool, sourceKey string) (string, error) {
	const q = `
		INSERT INTO industry_intelligence_collection_runs (source_key, status)
		VALUES ($1, 'running')
		RETURNING id::text`
	var id string
	if err := pool.QueryRow(ctx, q, sourceKey).Scan(&id); err != nil {
		return "", err
	}
	return id, nil
}

func finishIndustryCollectionRun(ctx context.Context, pool *pgxpool.Pool, runID, status string, recordsSeen, recordsImported, recordsFailed int, errorMessage string, metadata map[string]any) error {
	metadataJSON := "{}"
	if metadata != nil {
		b, err := json.Marshal(metadata)
		if err != nil {
			return fmt.Errorf("marshal collection run metadata: %w", err)
		}
		metadataJSON = string(b)
	}

	const q = `
		UPDATE industry_intelligence_collection_runs
		SET status = $2,
		    completed_at = now(),
		    records_seen = $3,
		    records_imported = $4,
		    records_failed = $5,
		    error_message = $6,
		    metadata = $7::jsonb
		WHERE id = $1::uuid`
	_, err := pool.Exec(ctx, q, runID, status, recordsSeen, recordsImported, recordsFailed, errorMessage, metadataJSON)
	return err
}

// syncIndustryTaxRecords promotes exact-matched ATO corporate-tax facts into the
// industry intelligence fact table. It writes one current factual row per ABN/year
// with the total-income metric; taxable income and tax payable remain available
// as nullable metadata so the UI can preserve nil-vs-zero semantics.
func syncIndustryTaxRecords(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	const q = `
		WITH mapped_tax AS (
			SELECT
				ct.abn,
				ct.entity_name,
				ct.income_year,
				ct.total_income,
				ct.taxable_income,
				ct.tax_payable,
				eam.stock_code,
				eam.confidence,
				COALESCE(NULLIF(cm.industry, ''), 'Unclassified') AS industry,
				COALESCE(NULLIF(cm.company_name, ''), eam.entity_name, ct.entity_name, eam.stock_code) AS company_name
			FROM corporate_tax ct
			JOIN entity_asx_map eam ON eam.abn = ct.abn
			LEFT JOIN "company-metadata" cm ON cm.stock_code = eam.stock_code
			WHERE ct.total_income IS NOT NULL
		),
		upserted AS (
			INSERT INTO industry_intelligence_records
				(source_key, source_record_id, signal_kind, industry, stock_code, entity_abn,
				 metric_key, metric_label, metric_value, unit, period_start, period_end, as_of,
				 title, summary, source_url, confidence, metadata)
			SELECT
				'ato-corporate-tax-transparency',
				'ato-tax:' || abn || ':' || income_year::text,
				'tax_environment',
				industry,
				stock_code,
				abn,
				'total_income',
				'Total income',
				total_income,
				'AUD',
				make_date((income_year - 1)::int, 7, 1),
				make_date(income_year::int, 6, 30),
				make_date(income_year::int, 6, 30),
				'ATO tax transparency: ' || company_name || ' ' || income_year::text,
				'ATO reported total income for ' || company_name || ' in the ' ||
					(income_year - 1)::text || '-' || right(income_year::text, 2) || ' income year.',
				'https://data.gov.au/data/dataset/corporate-transparency',
				confidence,
				jsonb_build_object(
					'entity_name', entity_name,
					'company_name', company_name,
					'income_year', income_year,
					'taxable_income', taxable_income,
					'has_taxable_income', taxable_income IS NOT NULL,
					'tax_payable', tax_payable,
					'has_tax_payable', tax_payable IS NOT NULL,
					'match_method', 'exact_entity_map'
				)
			FROM mapped_tax
			ON CONFLICT (source_key, source_record_id) DO UPDATE SET
				signal_kind = EXCLUDED.signal_kind,
				industry = EXCLUDED.industry,
				stock_code = EXCLUDED.stock_code,
				entity_abn = EXCLUDED.entity_abn,
				metric_key = EXCLUDED.metric_key,
				metric_label = EXCLUDED.metric_label,
				metric_value = EXCLUDED.metric_value,
				unit = EXCLUDED.unit,
				period_start = EXCLUDED.period_start,
				period_end = EXCLUDED.period_end,
				as_of = EXCLUDED.as_of,
				title = EXCLUDED.title,
				summary = EXCLUDED.summary,
				source_url = EXCLUDED.source_url,
				confidence = EXCLUDED.confidence,
				metadata = EXCLUDED.metadata,
				updated_at = now()
			RETURNING industry
		),
		source_enablement AS (
			INSERT INTO industry_intelligence_industry_sources
				(industry, source_key, enabled, public_enabled, reviewed_at, reviewed_by, notes)
			SELECT DISTINCT
				industry,
				'ato-corporate-tax-transparency',
				TRUE,
				TRUE,
				now(),
				'influence-collector',
				'ATO records exact-matched to the ASX entity map.'
			FROM upserted
			ON CONFLICT (industry, source_key) DO UPDATE SET
				enabled = EXCLUDED.enabled,
				public_enabled = EXCLUDED.public_enabled,
				reviewed_at = EXCLUDED.reviewed_at,
				reviewed_by = EXCLUDED.reviewed_by,
				notes = EXCLUDED.notes,
				updated_at = now()
			RETURNING 1
		)
		SELECT COUNT(*) FROM upserted`

	var count int64
	if err := pool.QueryRow(ctx, q).Scan(&count); err != nil {
		return 0, fmt.Errorf("sync industry tax records: %w", err)
	}
	return count, nil
}
