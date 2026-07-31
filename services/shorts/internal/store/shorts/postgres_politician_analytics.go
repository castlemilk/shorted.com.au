package shorts

// Aggregate shape of the register: party x industry, and members by state.
//
// EDITORIAL RULE 5 GOVERNS THIS FILE ABSOLUTELY. The registers disclose WHAT is
// held, never how much, so every figure here is a COUNT OF PEOPLE or a COUNT OF
// COMPANIES. There is no weight, no exposure, no size and no value, because the
// source records none — any such number would be invented, and it would be
// invented next to named individuals grouped by political party.
//
// PEOPLE, NOT ROWS, IS THE HEADLINE. A member who declares four banks is one
// person, not four; counting rows would make a diversified portfolio look like
// political concentration. `companies` sits beside it so a reader can tell
// "46 members hold the same single stock" (Telstra) from "45 members hold 52
// different ones" (Materials) — those are completely different claims and a
// single intensity number cannot distinguish them.

import (
	"context"
	"fmt"
	"time"
)

// PartyIndustryCellRow is one cell of the matrix.
type PartyIndustryCellRow struct {
	PartyAb   string
	Industry  string
	People    int32
	Companies int32
}

// IndustryTotalRow / PartyTotalRow / StateTotalRow are the pre-ordered axes.
type IndustryTotalRow struct {
	Industry  string
	People    int32
	Companies int32
}

type PartyTotalRow struct {
	PartyAb string
	People  int32
}

type StateTotalRow struct {
	StateCode string
	People    int32
	Companies int32
}

// RegisterAnalytics is the whole response.
type RegisterAnalytics struct {
	Cells             []*PartyIndustryCellRow
	Industries        []*IndustryTotalRow
	Parties           []*PartyTotalRow
	States            []*StateTotalRow
	IndustriesOmitted int32
	AsAt              time.Time
}

// analyticsBase is the row filter every arm shares.
//
// `industry` comes from "company-metadata" via the MV and is blank for a
// meaningful minority of listings. A blank industry is EXCLUDED rather than
// bucketed as "Other": bucketing would invent a category and then show members
// concentrated in it. The count of what was excluded is reported.
const analyticsBase = `
	FROM mv_register_public_holdings
	WHERE stock_code IS NOT NULL
	  AND industry IS NOT NULL AND btrim(industry) <> ''`

// GetRegisterAnalytics builds the party x industry matrix and the state split.
func (s *postgresStore) GetRegisterAnalytics(topIndustries int32, currentOnly bool) (*RegisterAnalytics, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if topIndustries <= 0 || topIndustries > 40 {
		topIndustries = 14
	}
	currentFilter := ""
	if currentOnly {
		currentFilter = " AND currently_declared"
	}

	out := &RegisterAnalytics{}

	// 1. The industry axis, ordered by how many people declare into it, capped.
	industryRows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT industry, count(DISTINCT politician_id), count(DISTINCT stock_code)
		%s %s
		GROUP BY industry
		ORDER BY count(DISTINCT politician_id) DESC, industry
		LIMIT $1`, analyticsBase, currentFilter), topIndustries)
	if err != nil {
		return nil, fmt.Errorf("industry axis: %w", err)
	}
	defer industryRows.Close()

	kept := map[string]bool{}
	for industryRows.Next() {
		var r IndustryTotalRow
		if err := industryRows.Scan(&r.Industry, &r.People, &r.Companies); err != nil {
			return nil, err
		}
		out.Industries = append(out.Industries, &r)
		kept[r.Industry] = true
	}
	if err := industryRows.Err(); err != nil {
		return nil, err
	}

	// How many industries the cap dropped. Stated, never silently truncated: a
	// heatmap that shows 14 of 22 industries without saying so reads as the
	// whole picture.
	var totalIndustries int32
	if err := s.db.QueryRow(ctx, fmt.Sprintf(
		`SELECT count(DISTINCT industry) %s %s`, analyticsBase, currentFilter)).
		Scan(&totalIndustries); err != nil {
		return nil, fmt.Errorf("industry count: %w", err)
	}
	if omitted := totalIndustries - int32(len(out.Industries)); omitted > 0 {
		out.IndustriesOmitted = omitted
	}

	if len(kept) == 0 {
		return out, nil
	}
	names := make([]string, 0, len(kept))
	for n := range kept {
		names = append(names, n)
	}

	// 2. The cells, restricted to the industries actually on the axis.
	cellRows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT COALESCE(btrim(party_ab), ''), industry,
		       count(DISTINCT politician_id), count(DISTINCT stock_code)
		%s %s
		  AND industry = ANY($1)
		GROUP BY 1, 2`, analyticsBase, currentFilter), names)
	if err != nil {
		return nil, fmt.Errorf("matrix cells: %w", err)
	}
	defer cellRows.Close()

	for cellRows.Next() {
		var r PartyIndustryCellRow
		if err := cellRows.Scan(&r.PartyAb, &r.Industry, &r.People, &r.Companies); err != nil {
			return nil, err
		}
		out.Cells = append(out.Cells, &r)
	}
	if err := cellRows.Err(); err != nil {
		return nil, err
	}

	// 3. The party axis. An EMPTY party_ab is kept and returned as empty —
	// party is not on the APH listing, it reaches us through an electorate join,
	// and it is genuinely absent for some members. Dropping them would quietly
	// shrink the totals; guessing would attribute a party to a named person.
	partyRows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT COALESCE(btrim(party_ab), ''), count(DISTINCT politician_id)
		%s %s
		GROUP BY 1
		ORDER BY count(DISTINCT politician_id) DESC`, analyticsBase, currentFilter))
	if err != nil {
		return nil, fmt.Errorf("party axis: %w", err)
	}
	defer partyRows.Close()

	for partyRows.Next() {
		var r PartyTotalRow
		if err := partyRows.Scan(&r.PartyAb, &r.People); err != nil {
			return nil, err
		}
		out.Parties = append(out.Parties, &r)
	}
	if err := partyRows.Err(); err != nil {
		return nil, err
	}

	// 4. Members by state, and the as-at.
	stateRows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT COALESCE(btrim(member_state), ''), count(DISTINCT politician_id), count(DISTINCT stock_code)
		%s %s
		  AND btrim(COALESCE(member_state, '')) <> ''
		GROUP BY 1
		ORDER BY count(DISTINCT politician_id) DESC`, analyticsBase, currentFilter))
	if err != nil {
		return nil, fmt.Errorf("state axis: %w", err)
	}
	defer stateRows.Close()

	for stateRows.Next() {
		var r StateTotalRow
		if err := stateRows.Scan(&r.StateCode, &r.People, &r.Companies); err != nil {
			return nil, err
		}
		out.States = append(out.States, &r)
	}
	if err := stateRows.Err(); err != nil {
		return nil, err
	}

	var refreshed *time.Time
	if err := s.db.QueryRow(ctx,
		`SELECT max(refreshed_at) FROM mv_register_public_holdings`).Scan(&refreshed); err == nil && refreshed != nil {
		out.AsAt = *refreshed
	}

	return out, nil
}
