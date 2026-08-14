package influence

// Party seeding for politician_terms.
//
// The register PDFs carry a member's NAME, SEAT and STATE — never their party.
// So party has to come from somewhere else, and the authoritative source we
// already have committed is the AEC election result that
// web/scripts/geo/join-electorates.mjs produced:
//
//	web/public/geo/electorates/federal-divisions.json
//	  "Adelaide": {"member":"Steve GEORGANAS","party":"Australian Labor Party",
//	               "partyAb":"ALP","state":"SA","tppAlp":69.07,"swing":7.16}
//
// postgres_politicians.go reads COALESCE(t.party, e.federal_party, '') — it
// prefers the term and falls back to joining suburb_demographics on division.
// That fallback is not enough on its own for two reasons: senators have no
// division at all, and suburb_demographics.federal_division is unpopulated in
// any environment where -mode electorates has not run. Filling the term
// directly is the durable fix.
//
// VINTAGE IS LOAD-BEARING. federal-divisions.json describes ONE election. A
// division changes hands between parliaments, so applying the 2025 result to the
// 47th Parliament would attribute the wrong party to a named person — exactly
// the class of error docs/influence-editorial-standards.md exists to prevent.
// We therefore seed only electoratesParliament and leave every other term NULL.
// A blank party chip is honest; a wrong one is not.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// electoratesParliament is the parliament federal-divisions.json describes: the
// 2025 federal election seated the 48th. Bump this in the same commit that
// refreshes the JSON after an election (recipe I in docs/feature/housing/architecture.md).
const electoratesParliament = 48

const federalDivisionsFile = "federal-divisions.json"

type federalDivision struct {
	Member  string `json:"member"`
	Party   string `json:"party"`
	PartyAb string `json:"partyAb"`
	State   string `json:"state"`
}

type partySeedStats struct {
	// Divisions present in the JSON.
	Divisions int
	// Terms in electoratesParliament, and how many now carry a party.
	Terms       int
	Updated     int
	WithParty   int
	Unmatched   []string
	SkippedFile bool
}

// electoratesDir resolves the committed electorate data directory.
//
// ELECTORATES_DIR matches the env var house-price-collector's -mode electorates
// already uses, so an operator configures one variable for both jobs.
func electoratesDir() string {
	if dir := strings.TrimSpace(os.Getenv("ELECTORATES_DIR")); dir != "" {
		return dir
	}
	// Repo-relative default so a local run needs no configuration.
	return filepath.Join("..", "..", "web", "public", "geo", "electorates")
}

func loadFederalDivisions(dir string) (map[string]federalDivision, error) {
	path := filepath.Join(dir, federalDivisionsFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var byDivision map[string]federalDivision
	if err := json.Unmarshal(raw, &byDivision); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if len(byDivision) == 0 {
		return nil, fmt.Errorf("%s contained no divisions", path)
	}
	return byDivision, nil
}

// seedTermParties fills politician_terms.party/party_ab for electoratesParliament.
//
// Matching is case- and whitespace-insensitive on purpose: the AEC's own files
// disagree with themselves on capitalisation (the boundary file says
// "O'connor", the results CSV says "O'Connor"), and an exact match silently
// drops those seats.
func seedTermParties(ctx context.Context, pool *pgxpool.Pool) (partySeedStats, error) {
	var stats partySeedStats

	dir := electoratesDir()
	byDivision, err := loadFederalDivisions(dir)
	if err != nil {
		// A missing file is a configuration gap, not a data error: the rest of the
		// load is still valid, so warn and carry on rather than failing the run.
		//
		// SAY SO LOUDLY. The default path is repo-relative and does NOT exist
		// inside the distroless job image, so a prod run silently skipped this and
		// every party chip fell back to the suburb_demographics.federal_division
		// join — which works for House members and yields NOTHING for senators,
		// who have no division. A quiet "skipped" line in a 700-document run is
		// not enough to notice that.
		log.Printf("[register-load] WARNING party seed SKIPPED — no party will be stored on any term: %v", err)
		log.Printf("[register-load] WARNING set ELECTORATES_DIR to a directory containing %s "+
			"(the committed copy is web/public/geo/electorates); House members still resolve a party via "+
			"suburb_demographics.federal_division, senators do not", federalDivisionsFile)
		stats.SkippedFile = true
		return stats, nil
	}
	stats.Divisions = len(byDivision)

	// Normalised lookup, built once.
	lookup := make(map[string]federalDivision, len(byDivision))
	for division, d := range byDivision {
		lookup[normalizeDivisionKey(division)] = d
	}

	rows, err := pool.Query(ctx, `
		SELECT id, division
		FROM politician_terms
		WHERE parliament = $1 AND division IS NOT NULL AND btrim(division) <> ''`,
		electoratesParliament)
	if err != nil {
		return stats, fmt.Errorf("select terms: %w", err)
	}
	type termRow struct {
		id       string
		division string
	}
	var terms []termRow
	for rows.Next() {
		var t termRow
		if err := rows.Scan(&t.id, &t.division); err != nil {
			rows.Close()
			return stats, fmt.Errorf("scan term: %w", err)
		}
		terms = append(terms, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return stats, fmt.Errorf("iterate terms: %w", err)
	}
	stats.Terms = len(terms)

	unmatched := map[string]bool{}
	for _, t := range terms {
		d, ok := lookup[normalizeDivisionKey(t.division)]
		if !ok || d.PartyAb == "" {
			unmatched[t.division] = true
			continue
		}
		tag, err := pool.Exec(ctx, `
			UPDATE politician_terms
			SET party = $2, party_ab = $3
			WHERE id = $1
			  AND (party IS DISTINCT FROM $2 OR party_ab IS DISTINCT FROM $3)`,
			t.id, d.Party, strings.ToUpper(d.PartyAb))
		if err != nil {
			return stats, fmt.Errorf("update term %s: %w", t.id, err)
		}
		stats.Updated += int(tag.RowsAffected())
	}
	for division := range unmatched {
		stats.Unmatched = append(stats.Unmatched, division)
	}

	if err := pool.QueryRow(ctx, `
		SELECT count(party_ab) FROM politician_terms WHERE parliament = $1`,
		electoratesParliament).Scan(&stats.WithParty); err != nil {
		return stats, fmt.Errorf("count seeded: %w", err)
	}

	return stats, nil
}

// normalizeDivisionKey collapses the casing and punctuation differences between
// the AEC's own spellings of the same seat.
func normalizeDivisionKey(division string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(division)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}
