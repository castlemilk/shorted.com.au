package main

import (
	"context"

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
