package shorts

// Read models for the register DISCOVERY layer (docs/feature/politicians/
// explorer-ui.md §7): surfaces where an unusual pattern becomes a findable
// fact, without anything here labelling it as one.
//
// Three properties hold for every query in this file and none of them are
// optional:
//
//  1. ZERO new tables or views. Everything derives live from
//     mv_register_public_holdings (and mv_top_shorts for the company's ASIC
//     figure), so the layer deploys as code and inherits the publication gates
//     rather than re-deriving them.
//  2. DATED-ONLY event logic, identical to ListRegisterChanges' events CTE: a
//     KNOWN declared_from is one event, a declared_to is another. An undated
//     base declaration has no point on a timeline and is never given one — the
//     rows it excludes are counted and reported instead
//     (RegisterActivityRow.UndatedCurrentCount).
//  3. COUNTS ONLY. No column, alias or struct field in this file may name a
//     quantity, value, price, worth or score. The registers record what is
//     held, never how much (editorial rule 5).

import (
	"context"
	"strings"
	"time"
)

// registerEventsCTE is THE definition of a register event, shared by every
// discovery measure. It is a verbatim copy of ListRegisterChanges' CTE plus the
// columns the aggregates group by: the changes feed, the weekly strip and the
// most-active rail must be one measure at three groupings, not three measures
// that happen to share a label.
const registerEventsCTE = `
	WITH events AS (
	    SELECT politician_id, slug, 'added' AS kind, declared_from AS changed_on
	    FROM mv_register_public_holdings
	    WHERE declared_from IS NOT NULL AND declared_from_known
	    UNION ALL
	    SELECT politician_id, slug, 'removed', declared_to
	    FROM mv_register_public_holdings
	    WHERE declared_to IS NOT NULL
	)`

type WeeklyEventCountRow struct {
	WeekStart    string // YYYY-MM-DD, Monday
	AddedCount   int32
	RemovedCount int32
}

type ActiveMemberRow struct {
	Slug        string
	DisplayName string
	PartyAb     string
	Chamber     string
	Division    string
	EventCount  int32
}

type NewlyDeclaredCompanyRow struct {
	StockCode       string
	CompanyName     string
	Industry        string
	FirstDeclaredOn string // YYYY-MM-DD
	DeclarerCount   int32
}

type DeclarerCountChangeRow struct {
	StockCode              string
	CompanyName            string
	Industry               string
	DeclarersNow           int32
	DeclarersAtWindowStart int32
}

type RegisterActivityRow struct {
	WindowDays             int32
	Weeks                  []*WeeklyEventCountRow
	ActiveMembers          []*ActiveMemberRow
	NewlyDeclaredCompanies []*NewlyDeclaredCompanyRow
	DeclarerCountChanges   []*DeclarerCountChangeRow
	UndatedCurrentCount    int32
	AsAt                   time.Time
}

type DistinctiveHoldingRow struct {
	StockCode           string
	CompanyName         string
	Industry            string
	Holder              string
	CurrentlyDeclared   bool
	CorpusDeclarerCount int32
	ShortPercent        float64
}

type DistinctiveHoldingsRow struct {
	CanonicalSlug string
	Holdings      []*DistinctiveHoldingRow
	MoreCount     int32
	AsAt          time.Time
}

// distinctiveHoldingsCap bounds the rail; the remainder is reported as
// MoreCount rather than silently dropped.
const distinctiveHoldingsCap = 30

// activeMembersCap bounds the most-active rail.
const activeMembersCap = 10

// declarerCountChangeCap bounds the declarer-movement rail.
const declarerCountChangeCap = 20

// GetRegisterActivity builds the activity explorer's rails for one window.
//
// windowDays is expected pre-clamped by the handler (30/90/180/365) so the
// cache key and the query can never describe different windows; it is bounded
// again here because a store method is a public entry point of this package.
func (s *postgresStore) GetRegisterActivity(windowDays int32) (*RegisterActivityRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	windowDays = clampRegisterWindowDays(windowDays)
	out := &RegisterActivityRow{WindowDays: windowDays}

	// Monday-anchored weeks. date_trunc('week', …) is ISO in Postgres, so the
	// bucket label is the week's Monday and a consumer can render it directly.
	weekRows, err := s.db.Query(ctx, registerEventsCTE+`
		SELECT to_char(date_trunc('week', changed_on), 'YYYY-MM-DD'),
		       count(*) FILTER (WHERE kind = 'added')::INTEGER,
		       count(*) FILTER (WHERE kind = 'removed')::INTEGER
		FROM events
		WHERE changed_on >= CURRENT_DATE - $1::INTEGER
		GROUP BY date_trunc('week', changed_on)
		ORDER BY date_trunc('week', changed_on)`, windowDays)
	if err != nil {
		return nil, err
	}
	for weekRows.Next() {
		var r WeeklyEventCountRow
		if err := weekRows.Scan(&r.WeekStart, &r.AddedCount, &r.RemovedCount); err != nil {
			weekRows.Close()
			return nil, err
		}
		out.Weeks = append(out.Weeks, &r)
	}
	if err := weekRows.Err(); err != nil {
		weekRows.Close()
		return nil, err
	}
	weekRows.Close()

	// Most-active members: a COUNT ordering and nothing else. A high count
	// reflects lodgement and extraction activity; the ordering carries no
	// characterisation of the member and the response has no field that could.
	memberRows, err := s.db.Query(ctx, registerEventsCTE+`
		SELECT p.slug, p.display_name,
		       upper(COALESCE(t.party_ab, '')), lower(COALESCE(t.chamber, '')),
		       COALESCE(t.division, ''), count(*)::INTEGER AS event_count
		FROM events e
		JOIN politicians p ON p.id = e.politician_id AND p.merged_into_id IS NULL
		LEFT JOIN LATERAL (
		    SELECT chamber, division, party_ab
		    FROM politician_terms
		    WHERE politician_id = p.id
		    ORDER BY parliament DESC
		    LIMIT 1
		) t ON TRUE
		WHERE e.changed_on >= CURRENT_DATE - $1::INTEGER
		GROUP BY p.slug, p.display_name, t.party_ab, t.chamber, t.division
		ORDER BY event_count DESC, p.display_name
		LIMIT $2`, windowDays, activeMembersCap)
	if err != nil {
		return nil, err
	}
	for memberRows.Next() {
		var r ActiveMemberRow
		if err := memberRows.Scan(&r.Slug, &r.DisplayName, &r.PartyAb, &r.Chamber, &r.Division, &r.EventCount); err != nil {
			memberRows.Close()
			return nil, err
		}
		out.ActiveMembers = append(out.ActiveMembers, &r)
	}
	if err := memberRows.Err(); err != nil {
		memberRows.Close()
		return nil, err
	}
	memberRows.Close()

	// "First declared" is CORPUS-WIDE and dated-only: the minimum known start
	// date across every member. A company one member has declared since 2019 is
	// not new because a second member declared it last week, and an undated row
	// cannot make anything new because it carries no date at all.
	newRows, err := s.db.Query(ctx, `
		WITH firsts AS (
		    SELECT stock_code,
		           min(declared_from) AS first_declared_on,
		           COALESCE(max(company_name), '') AS company_name,
		           COALESCE(max(industry), '') AS industry
		    FROM mv_register_public_holdings
		    WHERE stock_code IS NOT NULL AND declared_from_known AND declared_from IS NOT NULL
		    GROUP BY stock_code
		), declarers AS (
		    SELECT stock_code, count(DISTINCT politician_id)::INTEGER AS declarer_count
		    FROM mv_register_public_holdings
		    WHERE stock_code IS NOT NULL AND currently_declared
		    GROUP BY stock_code
		)
		SELECT f.stock_code, f.company_name, f.industry,
		       to_char(f.first_declared_on, 'YYYY-MM-DD'),
		       COALESCE(d.declarer_count, 0)
		FROM firsts f
		LEFT JOIN declarers d ON d.stock_code = f.stock_code
		WHERE f.first_declared_on >= CURRENT_DATE - $1::INTEGER
		ORDER BY f.first_declared_on DESC, f.stock_code`, windowDays)
	if err != nil {
		return nil, err
	}
	for newRows.Next() {
		var r NewlyDeclaredCompanyRow
		if err := newRows.Scan(&r.StockCode, &r.CompanyName, &r.Industry, &r.FirstDeclaredOn, &r.DeclarerCount); err != nil {
			newRows.Close()
			return nil, err
		}
		out.NewlyDeclaredCompanies = append(out.NewlyDeclaredCompanies, &r)
	}
	if err := newRows.Err(); err != nil {
		newRows.Close()
		return nil, err
	}
	newRows.Close()

	// SYMMETRIC by construction: one predicate, evaluated at two dates. This is
	// the same discipline the industry-movement fix established in
	// GetRegisterExplorer — ~80% of currently-declared rows are undated, so an
	// undated-inclusive "now" against a dated-only baseline reports every
	// company as gaining declarers, and ORDER BY abs(...) then ranks the rail by
	// that artefact. A company with no dated movement in the window must report
	// none, which is why it is filtered out entirely rather than shown at zero.
	changeRows, err := s.db.Query(ctx, `
		WITH declarer_counts AS (
		    SELECT stock_code,
		           COALESCE(max(company_name), '') AS company_name,
		           COALESCE(max(industry), '') AS industry,
		           count(DISTINCT politician_id) FILTER (
		               WHERE declared_from_known
		                 AND declared_from <= CURRENT_DATE
		                 AND (declared_to IS NULL OR declared_to > CURRENT_DATE)
		           )::INTEGER AS declarers_now,
		           count(DISTINCT politician_id) FILTER (
		               WHERE declared_from_known
		                 AND declared_from <= CURRENT_DATE - $1::INTEGER
		                 AND (declared_to IS NULL OR declared_to > CURRENT_DATE - $1::INTEGER)
		           )::INTEGER AS declarers_at_window_start
		    FROM mv_register_public_holdings
		    WHERE stock_code IS NOT NULL
		    GROUP BY stock_code
		)
		SELECT stock_code, company_name, industry, declarers_now, declarers_at_window_start
		FROM declarer_counts
		WHERE declarers_now <> declarers_at_window_start
		ORDER BY abs(declarers_now - declarers_at_window_start) DESC, stock_code
		LIMIT $2`, windowDays, declarerCountChangeCap)
	if err != nil {
		return nil, err
	}
	for changeRows.Next() {
		var r DeclarerCountChangeRow
		if err := changeRows.Scan(&r.StockCode, &r.CompanyName, &r.Industry,
			&r.DeclarersNow, &r.DeclarersAtWindowStart); err != nil {
			changeRows.Close()
			return nil, err
		}
		out.DeclarerCountChanges = append(out.DeclarerCountChanges, &r)
	}
	if err := changeRows.Err(); err != nil {
		changeRows.Close()
		return nil, err
	}
	changeRows.Close()

	// The size of what the dated-only discipline leaves out, so a surface can
	// caption it. Without this the rails read as the whole register.
	if err := s.db.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE currently_declared AND NOT declared_from_known)::INTEGER
		FROM mv_register_public_holdings`).Scan(&out.UndatedCurrentCount); err != nil {
		return nil, err
	}

	var err2 error
	out.AsAt, err2 = s.registerAsAt(ctx)
	if err2 != nil {
		return nil, err2
	}
	return out, nil
}

// clampRegisterWindowDays snaps a requested window onto the four supported
// widths. Anything between two supported values rounds UP, so a caller never
// receives a narrower window than it asked for while the cached key set stays
// four entries wide.
func clampRegisterWindowDays(windowDays int32) int32 {
	switch {
	case windowDays <= 0:
		return 90
	case windowDays <= 30:
		return 30
	case windowDays <= 90:
		return 90
	case windowDays <= 180:
		return 180
	default:
		return 365
	}
}

// ListDistinctiveHoldings answers, for one member, "how many other members
// currently declare this company?".
//
// A corpus_declarer_count of 1 is the whole fact the profile rail renders:
// no other member currently declares it. Nothing here computes a rarity score,
// a percentile or a flag — the count is published as-is and the reader draws
// their own inference (explorer-ui.md §7b).
//
// The row grain is (company, holder), not company: a member declaring the same
// company for themselves and via a spouse holds two DIFFERENT declarations, and
// collapsing them would have to pick one holder and thereby attribute a
// spouse's declaration to the member.
func (s *postgresStore) ListDistinctiveHoldings(slug string) (*DistinctiveHoldingsRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	slug = strings.ToLower(strings.TrimSpace(slug))

	// Canonical-slug handling exactly as GetPolitician does it: the politicians
	// row is the authority, merged rows are excluded (so a retired slug 404s
	// rather than silently resolving), and the stored slug is echoed back for
	// the consumer's redirect.
	var canonical string
	if err := s.db.QueryRow(ctx,
		`SELECT slug FROM politicians WHERE slug = $1 AND merged_into_id IS NULL`, slug).
		Scan(&canonical); err != nil {
		return nil, err
	}
	out := &DistinctiveHoldingsRow{CanonicalSlug: canonical}

	// stock_code IS NOT NULL is re-asserted rather than trusted from the view:
	// the 2026-07 audit found the housing licence gate leaking on the one read
	// path that trusted its upstream.
	rows, err := s.db.Query(ctx, `
		WITH corpus AS (
		    SELECT stock_code, count(DISTINCT politician_id)::INTEGER AS declarer_count
		    FROM mv_register_public_holdings
		    WHERE stock_code IS NOT NULL AND currently_declared
		    GROUP BY stock_code
		)
		SELECT h.stock_code,
		       COALESCE(max(h.company_name), ''),
		       COALESCE(max(h.industry), ''),
		       h.holder,
		       bool_or(h.currently_declared),
		       max(c.declarer_count),
		       COALESCE(max(ts.current_percent), 0)
		FROM mv_register_public_holdings h
		JOIN corpus c ON c.stock_code = h.stock_code
		LEFT JOIN mv_top_shorts ts ON ts.product_code = h.stock_code
		WHERE h.slug = $1 AND h.currently_declared AND h.stock_code IS NOT NULL
		GROUP BY h.stock_code, h.holder
		ORDER BY max(c.declarer_count) ASC, h.stock_code, h.holder`, canonical)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r DistinctiveHoldingRow
		if err := rows.Scan(&r.StockCode, &r.CompanyName, &r.Industry, &r.Holder,
			&r.CurrentlyDeclared, &r.CorpusDeclarerCount, &r.ShortPercent); err != nil {
			return nil, err
		}
		out.Holdings = append(out.Holdings, &r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out.Holdings) > distinctiveHoldingsCap {
		out.MoreCount = int32(len(out.Holdings) - distinctiveHoldingsCap)
		out.Holdings = out.Holdings[:distinctiveHoldingsCap]
	}
	out.AsAt, err = s.registerAsAt(ctx)
	if err != nil {
		return nil, err
	}
	return out, nil
}
