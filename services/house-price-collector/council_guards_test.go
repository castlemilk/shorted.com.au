package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Each council-mode floor refuses a partial source rather than writing it.
// These run each floor one below and exactly at its threshold, so removing a
// floor (or moving it out of the path the mode calls) fails here.

func TestParseBridgeRefusesTruncatedArtifact(t *testing.T) {
	known := map[string]bool{"A": true}
	bridge := func(n int) map[string]suburbLGAEntry {
		m := make(map[string]suburbLGAEntry, n)
		for i := 0; i < n; i++ {
			m[fmt.Sprintf("%05d", i)] = suburbLGAEntry{LGA: "A", Share: 1}
		}
		return m
	}
	if _, err := parseBridge(bridge(minSuburbLGABridgeRows-1), known); err == nil {
		t.Errorf("a %d-suburb bridge must be refused as truncated", minSuburbLGABridgeRows-1)
	}
	if subs, err := parseBridge(bridge(minSuburbLGABridgeRows), known); err != nil || len(subs) != minSuburbLGABridgeRows {
		t.Errorf("a %d-suburb bridge: %d rows, err %v", minSuburbLGABridgeRows, len(subs), err)
	}
}

func TestMatchFAGsRefusesABrokenNameMatch(t *testing.T) {
	idx := map[fagCouncilKey]string{}
	var rows []FagRow
	for i := 0; i < fagMinMatch; i++ {
		name := fmt.Sprintf("Shire of Place %d", i)
		idx[fagCouncilKey{"NSW", normCouncil(name)}] = fmt.Sprintf("1%04d", i)
		rows = append(rows, FagRow{"NSW", name, "2025-26", 1})
	}
	if _, err := matchFAGs(rows[:fagMinMatch-1], idx); err == nil {
		t.Errorf("%d matched councils must be refused", fagMinMatch-1)
	}
	if res, err := matchFAGs(rows, idx); err != nil || len(res.Latest) != fagMinMatch {
		t.Errorf("%d matched councils: %d, err %v", fagMinMatch, len(res.Latest), err)
	}
}

func TestWikidataFloors(t *testing.T) {
	code := func(i int) string { return fmt.Sprintf("%05d", 30000+i) }

	sparql := func(n int) []byte {
		var res sparqlResults
		for i := 0; i < n; i++ {
			res.Results.Bindings = append(res.Results.Bindings, map[string]struct {
				Value string `json:"value"`
			}{
				"code": {Value: "LGA" + code(i)},
				"item": {Value: fmt.Sprintf("http://www.wikidata.org/entity/Q%d", i+1)},
			})
		}
		b, err := json.Marshal(res)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	now := time.Date(2026, 9, 24, 0, 0, 0, 0, time.UTC)
	if _, err := buildWikidataSnapshot(sparql(wikidataMinCouncils-1), now); err == nil {
		t.Errorf("a %d-council SPARQL answer must not overwrite the snapshot", wikidataMinCouncils-1)
	}
	snap, err := buildWikidataSnapshot(sparql(wikidataMinCouncils), now)
	if err != nil || len(snap.Councils) != wikidataMinCouncils || snap.Licence != wikidataLicence {
		t.Fatalf("a %d-council answer: %d councils, licence %q, err %v", wikidataMinCouncils, len(snap.Councils), snap.Licence, err)
	}

	ix := lgaIndex{kind: map[string]string{}, state: map[string]string{}, name: map[string]string{}}
	for i := 0; i < wikidataMinCouncils; i++ {
		ix.kind[code(i)] = lgaKindCouncil
	}
	if codes, err := wikidataWrites(snap, ix); err != nil || len(codes) != wikidataMinCouncils {
		t.Errorf("full match: %d codes, err %v", len(codes), err)
	}
	delete(snap.Councils, code(0))
	if _, err := wikidataWrites(snap, ix); err == nil {
		t.Errorf("%d matched councils must be refused", wikidataMinCouncils-1)
	}
}

// The SQL-side guards, as string contracts so `make test` (no database)
// still fails when one is dropped. TestCouncilSQLGuards_Integration below
// checks what each one does.
func TestCouncilSQLGuardContracts(t *testing.T) {
	squash := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	for name, c := range map[string]struct{ sql, want string }{
		"clearNonERPPopulationSQL clears only rows no ERP year vouches for": {clearNonERPPopulationSQL, "SET population = NULL, pop_growth_pct = NULL WHERE erp_year IS NULL"},
		"mintSlugSQL never reassigns":                                       {mintSlugSQL, "AND slug IS NULL"},
		"deleteUnbridgedSQL drops suburbs the artifact no longer lists":     {deleteUnbridgedSQL, "DELETE FROM suburb_lga WHERE NOT (sal_code = ANY($1))"},
	} {
		if !strings.Contains(squash(c.sql), c.want) {
			t.Errorf("%s: %q lacks %q", name, squash(c.sql), c.want)
		}
	}
}

// TestCouncilSQLGuards_Integration runs the SQL guards against a real
// Postgres, on TEMP tables that shadow lga/suburb_lga/lga_series inside one
// transaction that is always rolled back, so it never touches real rows:
//
//	HOUSING_TEST_DB_URL='postgres://…' go test ./house-price-collector/ -run TestCouncilSQLGuards_Integration -v
//
// Name it with -run: the other _Integration tests here DROP and recreate
// tables, so they need a throwaway database; this one is safe on a shared one.
func TestCouncilSQLGuards_Integration(t *testing.T) {
	dbURL := os.Getenv("HOUSING_TEST_DB_URL")
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL to a Postgres with the housing schema to run the council SQL guards")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, table := range []string{"lga", "suburb_lga", "lga_series"} {
		if _, err := tx.Exec(ctx, fmt.Sprintf(`CREATE TEMP TABLE %s (LIKE public.%s INCLUDING ALL) ON COMMIT DROP`, table, table)); err != nil {
			t.Fatalf("shadow %s: %v", table, err)
		}
		var n int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s does not resolve to the empty temp table (%d rows, err %v): refusing to write", table, n, err)
		}
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	intOrNil := func(sql string, args ...any) *int {
		t.Helper()
		var v *int
		if err := tx.QueryRow(ctx, sql, args...).Scan(&v); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		return v
	}

	// erp-lga clears a population ERP does not vouch for, and only that.
	exec(`INSERT INTO lga (lga_code24, lga_name, state_code, population, erp_year) VALUES
		('10050', 'Albury', 'NSW', 1, NULL),
		('10070', 'Armidale', 'NSW', 999, NULL),
		('10100', 'Ballina', 'NSW', 555, 2024)`)
	growth := 1.5
	if _, cleared, err := applyERPLGATx(ctx, tx, nil, []LGAPopulation{{LGACode: "10050", Population: 57000, Year: 2025, PopGrowthPct: &growth}}); err != nil || cleared != 1 {
		t.Fatalf("applyERPLGATx: cleared %d, err %v; want the one Census-sum population cleared", cleared, err)
	}
	if p := intOrNil(`SELECT population FROM lga WHERE lga_code24 = '10050'`); p == nil || *p != 57000 {
		t.Errorf("ERP-covered council population = %v, want 57000", p)
	}
	if p := intOrNil(`SELECT population FROM lga WHERE lga_code24 = '10070'`); p != nil {
		t.Errorf("a population with no ERP year survived: %d", *p)
	}
	if p := intOrNil(`SELECT population FROM lga WHERE lga_code24 = '10100'`); p == nil || *p != 555 {
		t.Errorf("an earlier ERP population was cleared: %v", p)
	}

	// A slug, once minted, is never reassigned — even by a write that skipped
	// the in-memory check (a concurrent run).
	exec(`UPDATE lga SET slug = 'albury' WHERE lga_code24 = '10050'`)
	tag, err := tx.Exec(ctx, mintSlugSQL, "10050", "albury-city")
	if err != nil || tag.RowsAffected() != 0 {
		t.Errorf("mintSlugSQL on a slugged council: %d rows, err %v", tag.RowsAffected(), err)
	}
	var slug string
	if err := tx.QueryRow(ctx, `SELECT slug FROM lga WHERE lga_code24 = '10050'`).Scan(&slug); err != nil || slug != "albury" {
		t.Errorf("slug = %q (err %v), want albury", slug, err)
	}
	if tag, err := tx.Exec(ctx, mintSlugSQL, "10070", "armidale"); err != nil || tag.RowsAffected() != 1 {
		t.Errorf("mintSlugSQL on an unslugged council: %d rows, err %v", tag.RowsAffected(), err)
	}

	// The bridge becomes exactly the artifact: a suburb it no longer lists goes.
	exec(`INSERT INTO suburb_lga (sal_code, lga_code24) VALUES ('99999', '10070')`)
	n, removed, err := replaceSuburbLGATx(ctx, tx, []SuburbLGARow{
		{SALCode: "10001", LGACode: "10050", DominantShare: 1, Overlaps: []LGAOverlap{{"10050", 1}}},
	})
	if err != nil || n != 1 || removed != 1 {
		t.Fatalf("replaceSuburbLGATx: %d upserted, %d removed, err %v; want 1 and 1", n, removed, err)
	}
	var sals []string
	rows, err := tx.Query(ctx, `SELECT sal_code FROM suburb_lga ORDER BY sal_code`)
	if err != nil {
		t.Fatal(err)
	}
	if sals, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil || len(sals) != 1 || sals[0] != "10001" {
		t.Errorf("bridge = %v (err %v), want only 10001", sals, err)
	}
}
