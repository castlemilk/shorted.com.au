// Package main is a standalone backfill command that populates the entities
// and entity_edges tables from existing company-metadata and director_trades data.
//
// Usage:
//
//	DATABASE_URL=postgres://... go run ./shorts/cmd/graph-backfill/
//
// The command is idempotent — safe to re-run; upserts handle conflicts.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// -----------------------------------------------------------------------
// normalizePersonName
// -----------------------------------------------------------------------

var (
	// Leading honorifics to strip (must end with a space after the dot/word).
	honorificRe = regexp.MustCompile(
		`(?i)^(mr\.?\s+|mrs\.?\s+|ms\.?\s+|dr\.?\s+|hon\.?\s+|sir\.?\s+|prof\.?\s+|rev\.?\s+)`,
	)
	// Trailing title fragments like ", AM", ", AO", ", OBE", etc. and parentheticals.
	trailingTitleRe = regexp.MustCompile(`(?i)[,\(].*$`)
	// Collapse multiple whitespace characters to a single space.
	multiSpaceRe = regexp.MustCompile(`\s+`)
)

// normalizePersonName returns a lowercase, trimmed, whitespace-collapsed name
// with leading honorifics and trailing titles stripped. Returns "" if the
// result is shorter than 3 characters.
func normalizePersonName(name string) string {
	n := strings.TrimSpace(name)
	if n == "" {
		return ""
	}

	// Strip trailing titles/parentheticals first so the honorific strip works
	// on a clean prefix.
	n = trailingTitleRe.ReplaceAllString(n, "")
	n = strings.TrimRightFunc(n, func(r rune) bool {
		return unicode.IsPunct(r) || unicode.IsSpace(r)
	})

	// Strip leading honorifics.
	n = honorificRe.ReplaceAllString(n, "")

	// Lowercase + collapse whitespace.
	n = strings.ToLower(multiSpaceRe.ReplaceAllString(strings.TrimSpace(n), " "))

	if len([]rune(n)) < 3 {
		return ""
	}
	return n
}

// -----------------------------------------------------------------------
// keyPerson reflects one element of the key_people JSONB array.
// -----------------------------------------------------------------------

type keyPerson struct {
	Name         string `json:"name"`
	Role         string `json:"role"`
	Bio          string `json:"bio"`
	ImageURL     string `json:"image_url"`
	ImageGCSURL  string `json:"image_gcs_url"`
	LinkedInURL  string `json:"linkedin_url"`
	SourceURL    string `json:"source_url"`
	SourceType   string `json:"source_type"`
}

// -----------------------------------------------------------------------
// counters
// -----------------------------------------------------------------------

type counts struct {
	companies   int
	persons     int
	officerEdge int
	directsEdge int
}

// -----------------------------------------------------------------------
// main
// -----------------------------------------------------------------------

func main() {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL environment variable is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	pool, err := newPool(ctx, dbURL)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	c := &counts{}

	log.Println("=== graph-backfill: starting ===")

	// Step 1: company entities.
	companyMap, err := backfillCompanies(ctx, pool, c)
	if err != nil {
		log.Fatalf("backfillCompanies: %v", err)
	}
	log.Printf("  companies upserted: %d (entity ids loaded: %d)", c.companies, len(companyMap))

	// Step 2: person entities + officer_of edges from key_people.
	if err := backfillKeyPeople(ctx, pool, companyMap, c); err != nil {
		log.Fatalf("backfillKeyPeople: %v", err)
	}
	log.Printf("  key_people persons upserted: %d, officer_of edges: %d", c.persons, c.officerEdge)

	// Step 3: person entities + directs edges from director_trades.
	if err := backfillDirectorTrades(ctx, pool, companyMap, c); err != nil {
		log.Fatalf("backfillDirectorTrades: %v", err)
	}
	log.Printf("  director_trades persons upserted: %d, directs edges: %d", c.persons, c.directsEdge)

	// Step 4: cross-board summary.
	crossBoard, err := countCrossBoard(ctx, pool)
	if err != nil {
		log.Fatalf("countCrossBoard: %v", err)
	}

	log.Println("=== graph-backfill: complete ===")
	log.Printf("  total companies:    %d", c.companies)
	log.Printf("  total persons:      %d", c.persons)
	log.Printf("  officer_of edges:   %d", c.officerEdge)
	log.Printf("  directs edges:      %d", c.directsEdge)
	log.Printf("  cross-board persons (>1 company): %d", crossBoard)
}

// -----------------------------------------------------------------------
// pool constructor — SimpleProtocol for Supabase transaction pooler safety.
// -----------------------------------------------------------------------

func newPool(ctx context.Context, dbURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	// IMPORTANT: SimpleProtocol avoids prepared-statement cache collisions
	// that occur with Supabase's pgBouncer transaction pooler.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	cfg.MaxConns = 5
	cfg.MinConns = 1
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("new pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// -----------------------------------------------------------------------
// Step 1 — company entities
// -----------------------------------------------------------------------

// backfillCompanies upserts one entity row per company (deduped by stock_code).
// Returns a map of stock_code -> entity id.
func backfillCompanies(ctx context.Context, pool *pgxpool.Pool, c *counts) (map[string]int64, error) {
	// Upsert: normalized_name = lower(trim(stock_code)) so companies dedup by code,
	// not by company_name (names drift, codes don't).
	const upsertSQL = `
INSERT INTO entities (type, canonical_name, normalized_name, stock_code)
SELECT
    'company',
    company_name,
    lower(trim(stock_code)),
    stock_code
FROM "company-metadata"
WHERE company_name IS NOT NULL
  AND stock_code   IS NOT NULL
ON CONFLICT (type, normalized_name)
DO UPDATE SET
    stock_code  = EXCLUDED.stock_code,
    last_seen   = now()
`
	tag, err := pool.Exec(ctx, upsertSQL)
	if err != nil {
		return nil, fmt.Errorf("upsert companies: %w", err)
	}
	c.companies = int(tag.RowsAffected())

	// Build stock_code -> entity_id map for later edge insertions.
	rows, err := pool.Query(ctx, `SELECT id, stock_code FROM entities WHERE type = 'company' AND stock_code IS NOT NULL`)
	if err != nil {
		return nil, fmt.Errorf("query company ids: %w", err)
	}
	defer rows.Close()

	m := make(map[string]int64)
	for rows.Next() {
		var id int64
		var code string
		if err := rows.Scan(&id, &code); err != nil {
			return nil, fmt.Errorf("scan company row: %w", err)
		}
		m[code] = id
	}
	return m, rows.Err()
}

// -----------------------------------------------------------------------
// Step 2 — person entities + officer_of edges from key_people
// -----------------------------------------------------------------------

func backfillKeyPeople(ctx context.Context, pool *pgxpool.Pool, companyMap map[string]int64, c *counts) error {
	// Fetch company-metadata rows that have key_people populated.
	rows, err := pool.Query(ctx, `
SELECT stock_code, key_people
FROM "company-metadata"
WHERE key_people IS NOT NULL
  AND jsonb_array_length(key_people) > 0
  AND stock_code IS NOT NULL
`)
	if err != nil {
		return fmt.Errorf("query key_people: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var stockCode string
		var keyPeopleRaw []byte
		if err := rows.Scan(&stockCode, &keyPeopleRaw); err != nil {
			return fmt.Errorf("scan key_people row: %w", err)
		}

		companyID, ok := companyMap[stockCode]
		if !ok {
			// Company entity wasn't created (shouldn't happen, but skip gracefully).
			log.Printf("  warn: no company entity for stock_code %q — skipping key_people", stockCode)
			continue
		}

		var people []keyPerson
		if err := json.Unmarshal(keyPeopleRaw, &people); err != nil {
			log.Printf("  warn: unmarshal key_people for %q: %v — skipping", stockCode, err)
			continue
		}

		for _, p := range people {
			if p.Name == "" {
				continue
			}
			norm := normalizePersonName(p.Name)
			if norm == "" {
				continue
			}

			personID, err := upsertPerson(ctx, pool, p.Name, norm, buildPersonAttrs(p))
			if err != nil {
				return fmt.Errorf("upsert person %q: %w", p.Name, err)
			}
			c.persons++

			if err := upsertOfficerEdge(ctx, pool, personID, companyID, p.Role); err != nil {
				return fmt.Errorf("officer_of edge %d->%d: %w", personID, companyID, err)
			}
			c.officerEdge++
		}
	}
	return rows.Err()
}

// buildPersonAttrs marshals the person's enrichment attributes to JSON bytes
// suitable for passing to upsertPerson. Nil fields are omitted.
func buildPersonAttrs(p keyPerson) []byte {
	m := map[string]any{}
	if p.Role != "" {
		m["role"] = p.Role
	}
	if p.Bio != "" {
		m["bio"] = p.Bio
	}
	if p.ImageURL != "" {
		m["image_url"] = p.ImageURL
	}
	if p.ImageGCSURL != "" {
		m["image_gcs_url"] = p.ImageGCSURL
	}
	if p.LinkedInURL != "" {
		m["linkedin_url"] = p.LinkedInURL
	}
	if p.SourceURL != "" {
		m["source_url"] = p.SourceURL
	}
	if p.SourceType != "" {
		m["source_type"] = p.SourceType
	}
	b, _ := json.Marshal(m)
	return b
}

// upsertPerson inserts or updates a person entity.
// On conflict it merges attrs (existing || incoming so new fields win) and
// refreshes last_seen. Returns the entity id.
func upsertPerson(ctx context.Context, pool *pgxpool.Pool, canonicalName, normalizedName string, attrsJSON []byte) (int64, error) {
	const sql = `
INSERT INTO entities (type, canonical_name, normalized_name, attrs)
VALUES ('person', $1, $2, $3::jsonb)
ON CONFLICT (type, normalized_name)
DO UPDATE SET
    attrs     = entities.attrs || EXCLUDED.attrs,
    last_seen = now()
RETURNING id
`
	var id int64
	err := pool.QueryRow(ctx, sql, canonicalName, normalizedName, string(attrsJSON)).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("upsert person: %w", err)
	}
	return id, nil
}

// upsertOfficerEdge inserts or updates an officer_of edge from person to company.
func upsertOfficerEdge(ctx context.Context, pool *pgxpool.Pool, personID, companyID int64, role string) error {
	const sql = `
INSERT INTO entity_edges (src_id, dst_id, edge_type, attrs, source)
VALUES ($1, $2, 'officer_of', jsonb_build_object('role', $3::text), 'key_people')
ON CONFLICT (src_id, dst_id, edge_type)
DO UPDATE SET
    attrs = EXCLUDED.attrs
`
	_, err := pool.Exec(ctx, sql, personID, companyID, role)
	return err
}

// -----------------------------------------------------------------------
// Step 3 — person entities + directs edges from director_trades
// -----------------------------------------------------------------------

type directorRow struct {
	StockCode    string
	DirectorName string
	TradeCount   int64
	NetBuyValue  float64
}

func backfillDirectorTrades(ctx context.Context, pool *pgxpool.Pool, companyMap map[string]int64, c *counts) error {
	const querySQL = `
SELECT
    stock_code,
    director_name,
    count(*)                                                              AS n,
    sum(CASE
        WHEN trade_type = 'buy'              THEN total_value
        WHEN trade_type = 'sell'             THEN -total_value
        ELSE 0
    END)                                                                  AS net
FROM director_trades
WHERE director_name IS NOT NULL
  AND director_name <> ''
  AND stock_code    IS NOT NULL
GROUP BY stock_code, director_name
`
	rows, err := pool.Query(ctx, querySQL)
	if err != nil {
		return fmt.Errorf("query director_trades: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var dr directorRow
		if err := rows.Scan(&dr.StockCode, &dr.DirectorName, &dr.TradeCount, &dr.NetBuyValue); err != nil {
			return fmt.Errorf("scan director row: %w", err)
		}

		norm := normalizePersonName(dr.DirectorName)
		if norm == "" {
			continue
		}

		// Minimal attrs for director_trades persons — no bio/image available here.
		attrsJSON, _ := json.Marshal(map[string]any{})

		personID, err := upsertPerson(ctx, pool, dr.DirectorName, norm, attrsJSON)
		if err != nil {
			return fmt.Errorf("upsert director %q: %w", dr.DirectorName, err)
		}
		c.persons++

		companyID, ok := companyMap[dr.StockCode]
		if !ok {
			log.Printf("  warn: no company entity for stock_code %q — skipping directs edge for %q", dr.StockCode, dr.DirectorName)
			continue
		}

		if err := upsertDirectsEdge(ctx, pool, personID, companyID, dr.TradeCount, dr.NetBuyValue); err != nil {
			return fmt.Errorf("directs edge %d->%d: %w", personID, companyID, err)
		}
		c.directsEdge++
	}
	return rows.Err()
}

// upsertDirectsEdge inserts or updates a 'directs' edge (person -> company).
func upsertDirectsEdge(ctx context.Context, pool *pgxpool.Pool, personID, companyID int64, tradeCount int64, netBuyValue float64) error {
	const sql = `
INSERT INTO entity_edges (src_id, dst_id, edge_type, attrs, source)
VALUES (
    $1, $2, 'directs',
    jsonb_build_object('trade_count', $3::bigint, 'net_buy_value', $4::double precision),
    'director_trades'
)
ON CONFLICT (src_id, dst_id, edge_type)
DO UPDATE SET
    attrs = EXCLUDED.attrs
`
	_, err := pool.Exec(ctx, sql, personID, companyID, tradeCount, netBuyValue)
	return err
}

// -----------------------------------------------------------------------
// Step 4 — cross-board count
// -----------------------------------------------------------------------

// countCrossBoard returns the number of person entities connected to more
// than one company entity via any edge type.
func countCrossBoard(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	const sql = `
SELECT count(*)
FROM (
    SELECT e.src_id
    FROM entity_edges e
    JOIN entities p ON p.id = e.src_id
    WHERE p.type = 'person'
    GROUP BY e.src_id
    HAVING count(DISTINCT e.dst_id) > 1
) t
`
	var n int64
	if err := pool.QueryRow(ctx, sql).Scan(&n); err != nil {
		return 0, fmt.Errorf("cross-board count: %w", err)
	}
	return n, nil
}
