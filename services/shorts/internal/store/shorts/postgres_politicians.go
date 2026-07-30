package shorts

// Read path for the Registers of Members' and Senators' Interests.
//
// EDITORIAL (docs/influence-editorial-standards.md): every query here reads
// mv_register_public_holdings, which already carries three guarantees baked in
// upstream — only identity-resolved people, only cleanly-extracted documents, and
// a stock_code that a CHECK constraint proved was matched by a publishable method
// (curated alias, member-stated ticker, or exact name).
//
// Defence in depth: the queries ALSO filter stock_code IS NOT NULL where a code
// is required, rather than trusting the view. The 2026-07 audit found the housing
// licence gate leaking on exactly one read path that trusted its upstream.

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// PoliticianRow is one parliamentarian.
type PoliticianRow struct {
	Slug                  string
	DisplayName           string
	Surname               string
	GivenNames            string
	Honorific             string
	Chamber               string
	Division              string
	StateCode             string
	Party                 string
	PartyAb               string
	FirstParliament       int32
	LastParliament        int32
	APHMPID               string
	DeclaredListedCount   int32
	DeclaredPropertyCount int32

	// Extraction coverage of the CORPUS, populated by GetPolitician only.
	//
	// Corpus-level rather than per-person on purpose: linking an UNextracted
	// document to a person would mean re-implementing aph_identity.go's name
	// normaliser in SQL against register_documents.member_hint, and a wrong join
	// there would mis-attribute a document to the wrong named individual — a
	// worse failure than the coarser claim. "We have not read the 44th" is true
	// for everyone, and it is the claim that stops an empty list reading as
	// "declared nothing".
	ExtractedParliaments []int32
	PartialParliaments   []int32
	PendingParliaments   []int32
}

// DeclaredInterestRow is one holding over one continuous period.
type DeclaredInterestRow struct {
	ItemNo            int32
	ItemLabel         string
	Holder            string
	DeclaredText      string
	SecondaryText     string
	StockCode         string
	CompanyName       string
	Industry          string
	SalCode           string
	SuburbName        string
	PropertyState     string
	MatchMethod       string
	DeclaredFrom      time.Time
	DeclaredFromKnown bool
	DeclaredTo        time.Time
	CurrentlyDeclared bool
	SourceURL         string
	SourceLicence     string
	// EntityKind names WHAT was declared (listed | private_company |
	// family_trust | smsf | managed_fund | foreign). A read surface needs it to
	// describe an unmatched row honestly: "not matched to an ASX listing" is
	// only true of a listed candidate.
	//
	// EMPTY outside items 1 and 4, and a read path must NOT default it to
	// 'listed'. Only those two items carry a security candidate, so nothing
	// else was ever classified — defaulting made the apology appear on 666
	// superannuation accounts, trusts and gifts that were never match attempts.
	// 'not_an_entity' and 'multi_entity' never reach here; the fold drops them.
	EntityKind string
}

// PartyCountRow counts PEOPLE, never money.
type PartyCountRow struct {
	PartyAb         string
	Party           string
	PoliticianCount int32
}

// PoliticianStockRollupRow is one company with the people declaring it.
type PoliticianStockRollupRow struct {
	StockCode       string
	CompanyName     string
	Industry        string
	PoliticianCount int32
	ShortPercent    float64
	PartyCounts     []*PartyCountRow
}

// RegisterOverviewRow is the hub summary.
type RegisterOverviewRow struct {
	PoliticianCount     int32
	StatementCount      int32
	DeclaredRowCount    int32
	ResolvedListedCount int32
	ResolvedSuburbCount int32
	FirstParliament     int32
	LastParliament      int32
	AsAt                time.Time
	RefreshedAt         time.Time
}

// RegisterChangeRow is one add/remove event.
type RegisterChangeRow struct {
	Politician   *PoliticianRow
	Kind         string // 'added' | 'removed'
	ItemNo       int32
	ItemLabel    string
	Holder       string
	DeclaredText string
	StockCode    string
	CompanyName  string
	EntityKind   string
	ChangedOn    time.Time
	SourceURL    string
}

// politicianSelect is the shared projection. Party comes from the electorate
// join, because the Register listing does not carry it: a member's division maps
// to suburb_demographics.federal_division, which house-price-collector's
// -mode electorates populates with federal_party.
const politicianSelect = `
	SELECT p.slug, p.display_name, p.surname, p.given_names, p.honorific,
	       COALESCE(t.chamber, ''), COALESCE(t.division, ''), COALESCE(t.state_code, ''),
	       COALESCE(t.party, e.federal_party, ''), COALESCE(t.party_ab, e.federal_party_ab, ''),
	       COALESCE(p.first_parliament, 0), COALESCE(p.last_parliament, 0),
	       COALESCE(p.aph_mpid, ''),
	       COALESCE(c.listed_count, 0), COALESCE(c.property_count, 0)
	FROM politicians p
	LEFT JOIN LATERAL (
	    SELECT chamber, division, state_code, party, party_ab
	    FROM politician_terms
	    WHERE politician_id = p.id
	    ORDER BY parliament DESC
	    LIMIT 1
	) t ON TRUE
	LEFT JOIN LATERAL (
	    SELECT federal_party, federal_party_ab
	    FROM suburb_demographics
	    WHERE t.division IS NOT NULL
	      AND upper(btrim(federal_division)) = upper(btrim(t.division))
	      AND federal_party IS NOT NULL
	    LIMIT 1
	) e ON TRUE
	LEFT JOIN LATERAL (
	    SELECT count(DISTINCT stock_code) FILTER (WHERE stock_code IS NOT NULL) AS listed_count,
	           count(DISTINCT sal_code)  FILTER (WHERE sal_code IS NOT NULL)   AS property_count
	    FROM mv_register_public_holdings
	    WHERE politician_id = p.id
	) c ON TRUE
	WHERE p.merged_into_id IS NULL`

func scanPolitician(scan func(dest ...any) error) (*PoliticianRow, error) {
	var r PoliticianRow
	if err := scan(&r.Slug, &r.DisplayName, &r.Surname, &r.GivenNames, &r.Honorific,
		&r.Chamber, &r.Division, &r.StateCode, &r.Party, &r.PartyAb,
		&r.FirstParliament, &r.LastParliament, &r.APHMPID,
		&r.DeclaredListedCount, &r.DeclaredPropertyCount); err != nil {
		return nil, err
	}
	return &r, nil
}

// GetRegisterOverview returns parliament-wide counts and the as-at date.
func (s *postgresStore) GetRegisterOverview() (*RegisterOverviewRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	const q = `
		SELECT
			(SELECT count(*) FROM politicians WHERE merged_into_id IS NULL),
			(SELECT count(*) FROM register_statements),
			(SELECT count(*) FROM register_declared_items WHERE NOT is_nil),
			(SELECT count(DISTINCT stock_code) FROM mv_register_public_holdings WHERE stock_code IS NOT NULL),
			(SELECT count(DISTINCT sal_code)  FROM mv_register_public_holdings WHERE sal_code IS NOT NULL),
			(SELECT COALESCE(min(parliament), 0) FROM politician_terms),
			(SELECT COALESCE(max(parliament), 0) FROM politician_terms),
			(SELECT max(lodged_date) FROM register_statements),
			(SELECT max(refreshed_at) FROM mv_register_public_holdings)`

	var r RegisterOverviewRow
	var asAt, refreshed *time.Time
	if err := s.db.QueryRow(ctx, q).Scan(&r.PoliticianCount, &r.StatementCount,
		&r.DeclaredRowCount, &r.ResolvedListedCount, &r.ResolvedSuburbCount,
		&r.FirstParliament, &r.LastParliament, &asAt, &refreshed); err != nil {
		return nil, err
	}
	if asAt != nil {
		r.AsAt = *asAt
	}
	if refreshed != nil {
		r.RefreshedAt = *refreshed
	}
	return &r, nil
}

// ListPoliticians browses parliamentarians.
//
// Filters are built dynamically rather than as `WHERE ($1 = ” OR col = $1)`:
// the OR-guard form defeats index usage, which postgres_industry_intelligence.go
// documents having hit.
func (s *postgresStore) ListPoliticians(chamber, stateCode, partyAb, query string, limit, offset int32) ([]*PoliticianRow, int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conds := []string{}
	args := []any{}
	add := func(cond string, val any) {
		args = append(args, val)
		conds = append(conds, fmt.Sprintf(cond, len(args)))
	}
	if chamber != "" {
		add("t.chamber = $%d", chamber)
	}
	if stateCode != "" {
		add("t.state_code = $%d", strings.ToUpper(stateCode))
	}
	if partyAb != "" {
		add("COALESCE(t.party_ab, e.federal_party_ab, '') = $%d", strings.ToUpper(partyAb))
	}
	if query != "" {
		add("p.display_name ILIKE '%%' || $%d || '%%'", query)
	}

	sql := politicianSelect
	if len(conds) > 0 {
		sql += " AND " + strings.Join(conds, " AND ")
	}
	sql += fmt.Sprintf(" ORDER BY p.surname, p.given_names LIMIT $%d OFFSET $%d", len(args)+1, len(args)+2)
	args = append(args, limit, offset)

	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []*PoliticianRow
	for rows.Next() {
		r, err := scanPolitician(rows.Scan)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	var total int32
	if err := s.db.QueryRow(ctx,
		`SELECT count(*) FROM politicians WHERE merged_into_id IS NULL`).Scan(&total); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// GetPolitician returns one profile with its full declared history.
func (s *postgresStore) GetPolitician(slug string) (*PoliticianRow, []*DeclaredInterestRow, []string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	sql := politicianSelect + " AND p.slug = $1 LIMIT 1"
	row, err := scanPolitician(s.db.QueryRow(ctx, sql, slug).Scan)
	if err != nil {
		return nil, nil, nil, err
	}

	interests, err := s.declaredInterests(ctx,
		`SELECT item_no, holder, declared_text, secondary_text,
		        COALESCE(stock_code, ''), COALESCE(company_name, ''), COALESCE(industry, ''),
		        COALESCE(sal_code, ''), COALESCE(sal_name, ''), COALESCE(property_state, ''),
		        declared_from, declared_from_known, declared_to, currently_declared,
		        source_url, source_licence, COALESCE(entity_kind, '')
		 FROM mv_register_public_holdings
		 WHERE slug = $1
		 ORDER BY item_no, currently_declared DESC, declared_from DESC NULLS LAST, declared_text`, slug)
	if err != nil {
		return nil, nil, nil, err
	}

	// Suburbs REPRESENTED — nothing to do with anything owned. Restricted to the
	// member's current division: resolving a historical seat against the current
	// AEC boundary set would return the wrong suburbs.
	var represented []string
	if row.Division != "" {
		srows, err := s.db.Query(ctx, `
			SELECT sal_name FROM suburb_demographics
			WHERE upper(btrim(federal_division)) = upper(btrim($1))
			ORDER BY sal_name`, row.Division)
		if err != nil {
			return nil, nil, nil, err
		}
		defer srows.Close()
		for srows.Next() {
			var name string
			if err := srows.Scan(&name); err != nil {
				return nil, nil, nil, err
			}
			represented = append(represented, name)
		}
		if err := srows.Err(); err != nil {
			return nil, nil, nil, err
		}
	}

	if err := s.loadCoverage(ctx, row); err != nil {
		return nil, nil, nil, err
	}

	return row, interests, represented, nil
}

// fullyReadPct is the share of a parliament's documents that must have parsed
// before we will say we read that parliament.
//
// NOT "at least one". An earlier version of this used `extracted > 0`, which
// claimed the 47th Parliament was covered when 87 of 155 documents had parsed —
// so the ~44% of members whose own document failed rendered an empty list under
// a heading asserting we had looked. That is a false absence claim about a named
// individual, which is the exact failure CoverageNote exists to prevent.
//
// 95 rather than 100: a handful of documents are legitimately quarantined
// (the centred-label layout), and holding a parliament hostage to them would
// report every parliament as partial forever.
const fullyReadPct = 95.0

// loadCoverage records how much of each parliament has actually been read.
//
// 'partial' documents are counted as NOT read: a partial document is quarantined
// from public output, so counting it would re-assert the coverage the quarantine
// exists to deny.
func (s *postgresStore) loadCoverage(ctx context.Context, row *PoliticianRow) error {
	rows, err := s.db.Query(ctx, `
		SELECT parliament,
		       count(*)                                                AS docs,
		       count(*) FILTER (WHERE extract_status = 'extracted')     AS extracted
		FROM register_documents
		WHERE parliament IS NOT NULL
		GROUP BY parliament
		ORDER BY parliament`)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var parliament, docs, extracted int32
		if err := rows.Scan(&parliament, &docs, &extracted); err != nil {
			return err
		}
		switch {
		case extracted == 0:
			row.PendingParliaments = append(row.PendingParliaments, parliament)
		case docs > 0 && 100.0*float64(extracted)/float64(docs) >= fullyReadPct:
			row.ExtractedParliaments = append(row.ExtractedParliaments, parliament)
		default:
			row.PartialParliaments = append(row.PartialParliaments, parliament)
		}
	}
	return rows.Err()
}

func (s *postgresStore) declaredInterests(ctx context.Context, sql string, args ...any) ([]*DeclaredInterestRow, error) {
	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*DeclaredInterestRow
	for rows.Next() {
		var r DeclaredInterestRow
		var from, to *time.Time
		if err := rows.Scan(&r.ItemNo, &r.Holder, &r.DeclaredText, &r.SecondaryText,
			&r.StockCode, &r.CompanyName, &r.Industry, &r.SalCode, &r.SuburbName,
			&r.PropertyState, &from, &r.DeclaredFromKnown, &to, &r.CurrentlyDeclared,
			&r.SourceURL, &r.SourceLicence, &r.EntityKind); err != nil {
			return nil, err
		}
		if from != nil {
			r.DeclaredFrom = *from
		}
		if to != nil {
			r.DeclaredTo = *to
		}
		r.ItemLabel = registerItemLabel(r.ItemNo)
		out = append(out, &r)
	}
	return out, rows.Err()
}

// registerItemLabel names the 14 form items.
func registerItemLabel(itemNo int32) string {
	switch itemNo {
	case 1:
		return "Shareholdings in public and private companies"
	case 2:
		return "Family and business trusts and nominee companies"
	case 3:
		return "Real estate"
	case 4:
		return "Registered directorships of companies"
	case 5:
		return "Partnerships"
	case 6:
		return "Liabilities"
	case 7:
		return "Bonds, debentures and like investments"
	case 8:
		return "Savings or investment accounts"
	case 9:
		return "Other assets"
	case 10:
		return "Other substantial sources of income"
	case 11:
		return "Gifts"
	case 12:
		return "Sponsored travel or hospitality"
	case 13:
		return "Office holder or financial contributor"
	case 14:
		return "Other interests"
	default:
		return ""
	}
}

// ListStockPoliticians answers "who declares an interest in this company".
func (s *postgresStore) ListStockPoliticians(stockCode string, currentOnly bool) (string, []*PoliticianRow, []*DeclaredInterestRow, []*PartyCountRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	code := strings.ToUpper(strings.TrimSpace(stockCode))
	// stock_code IS NOT NULL is redundant given the equality, but states the
	// gate explicitly: only publishably-resolved rows carry a code at all.
	filter := `WHERE stock_code IS NOT NULL AND stock_code = $1`
	if currentOnly {
		filter += ` AND currently_declared`
	}

	var companyName string
	if err := s.db.QueryRow(ctx,
		`SELECT COALESCE(max(company_name), '') FROM mv_register_public_holdings `+filter, code).
		Scan(&companyName); err != nil {
		return "", nil, nil, nil, err
	}

	rows, err := s.db.Query(ctx, `
		SELECT h.slug, h.display_name, COALESCE(h.chamber, ''), COALESCE(h.division, ''),
		       COALESCE(h.member_state, ''), COALESCE(h.party, ''), COALESCE(h.party_ab, ''),
		       h.item_no, h.holder, h.declared_text, h.secondary_text,
		       COALESCE(h.stock_code, ''), COALESCE(h.company_name, ''), COALESCE(h.industry, ''),
		       h.declared_from, h.declared_from_known, h.declared_to, h.currently_declared,
		       h.source_url, h.source_licence
		FROM mv_register_public_holdings h
		`+filter+`
		ORDER BY h.display_name, h.holder, h.declared_from DESC NULLS LAST`, code)
	if err != nil {
		return "", nil, nil, nil, err
	}
	defer rows.Close()

	var people []*PoliticianRow
	var interests []*DeclaredInterestRow
	for rows.Next() {
		var p PoliticianRow
		var r DeclaredInterestRow
		var from, to *time.Time
		if err := rows.Scan(&p.Slug, &p.DisplayName, &p.Chamber, &p.Division,
			&p.StateCode, &p.Party, &p.PartyAb,
			&r.ItemNo, &r.Holder, &r.DeclaredText, &r.SecondaryText,
			&r.StockCode, &r.CompanyName, &r.Industry,
			&from, &r.DeclaredFromKnown, &to, &r.CurrentlyDeclared,
			&r.SourceURL, &r.SourceLicence); err != nil {
			return "", nil, nil, nil, err
		}
		if from != nil {
			r.DeclaredFrom = *from
		}
		if to != nil {
			r.DeclaredTo = *to
		}
		r.ItemLabel = registerItemLabel(r.ItemNo)
		people = append(people, &p)
		interests = append(interests, &r)
	}
	if err := rows.Err(); err != nil {
		return "", nil, nil, nil, err
	}

	parties, err := s.partyCounts(ctx, filter, code)
	if err != nil {
		return "", nil, nil, nil, err
	}
	return companyName, people, interests, parties, nil
}

// partyCounts counts DISTINCT PEOPLE per party, never rows — a member who
// declares one company three times is one person.
func (s *postgresStore) partyCounts(ctx context.Context, filter string, args ...any) ([]*PartyCountRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT COALESCE(NULLIF(party_ab, ''), 'OTH'), COALESCE(NULLIF(party, ''), 'Other'),
		       count(DISTINCT politician_id)
		FROM mv_register_public_holdings
		`+filter+`
		GROUP BY 1, 2
		ORDER BY 3 DESC, 1`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*PartyCountRow
	for rows.Next() {
		var r PartyCountRow
		if err := rows.Scan(&r.PartyAb, &r.Party, &r.PoliticianCount); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// ListPoliticianStocks is parliament's most-declared companies.
func (s *postgresStore) ListPoliticianStocks(limit int32, currentOnly bool) ([]*PoliticianStockRollupRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	filter := `WHERE h.stock_code IS NOT NULL`
	if currentOnly {
		filter += ` AND h.currently_declared`
	}

	rows, err := s.db.Query(ctx, `
		SELECT h.stock_code, COALESCE(max(h.company_name), ''), COALESCE(max(h.industry), ''),
		       count(DISTINCT h.politician_id) AS members,
		       COALESCE(max(ts.current_percent), 0)
		FROM mv_register_public_holdings h
		LEFT JOIN mv_top_shorts ts ON ts.product_code = h.stock_code
		`+filter+`
		GROUP BY h.stock_code
		ORDER BY members DESC, h.stock_code
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*PoliticianStockRollupRow
	for rows.Next() {
		var r PoliticianStockRollupRow
		if err := rows.Scan(&r.StockCode, &r.CompanyName, &r.Industry,
			&r.PoliticianCount, &r.ShortPercent); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// ListSuburbPoliticians answers "who declares property in this suburb".
func (s *postgresStore) ListSuburbPoliticians(salCode string) (string, string, []*PoliticianRow, []*DeclaredInterestRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var suburbName, stateCode string
	if err := s.db.QueryRow(ctx, `
		SELECT COALESCE(sal_name, ''), COALESCE(state_code, '')
		FROM suburb_demographics WHERE sal_code = $1`, salCode).
		Scan(&suburbName, &stateCode); err != nil {
		return "", "", nil, nil, err
	}

	rows, err := s.db.Query(ctx, `
		SELECT h.slug, h.display_name, COALESCE(h.chamber, ''), COALESCE(h.division, ''),
		       COALESCE(h.member_state, ''), COALESCE(h.party, ''), COALESCE(h.party_ab, ''),
		       h.item_no, h.holder, h.declared_text, h.secondary_text,
		       COALESCE(h.sal_code, ''), COALESCE(h.sal_name, ''), COALESCE(h.property_state, ''),
		       h.declared_from, h.declared_from_known, h.declared_to, h.currently_declared,
		       h.source_url, h.source_licence
		FROM mv_register_public_holdings h
		WHERE h.sal_code IS NOT NULL AND h.sal_code = $1
		ORDER BY h.display_name, h.holder`, salCode)
	if err != nil {
		return "", "", nil, nil, err
	}
	defer rows.Close()

	var people []*PoliticianRow
	var interests []*DeclaredInterestRow
	for rows.Next() {
		var p PoliticianRow
		var r DeclaredInterestRow
		var from, to *time.Time
		if err := rows.Scan(&p.Slug, &p.DisplayName, &p.Chamber, &p.Division,
			&p.StateCode, &p.Party, &p.PartyAb,
			&r.ItemNo, &r.Holder, &r.DeclaredText, &r.SecondaryText,
			&r.SalCode, &r.SuburbName, &r.PropertyState,
			&from, &r.DeclaredFromKnown, &to, &r.CurrentlyDeclared,
			&r.SourceURL, &r.SourceLicence); err != nil {
			return "", "", nil, nil, err
		}
		if from != nil {
			r.DeclaredFrom = *from
		}
		if to != nil {
			r.DeclaredTo = *to
		}
		r.ItemLabel = registerItemLabel(r.ItemNo)
		people = append(people, &p)
		interests = append(interests, &r)
	}
	return suburbName, stateCode, people, interests, rows.Err()
}

// ListStatePoliticianHoldings answers "what do this state's members declare".
//
// "State" means the member's constituency: a senator's state, or the state of a
// House member's division.
func (s *postgresStore) ListStatePoliticianHoldings(stateCode string, limit int32) ([]*PoliticianStockRollupRow, int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	code := strings.ToUpper(strings.TrimSpace(stateCode))

	rows, err := s.db.Query(ctx, `
		SELECT h.stock_code, COALESCE(max(h.company_name), ''), COALESCE(max(h.industry), ''),
		       count(DISTINCT h.politician_id) AS members,
		       COALESCE(max(ts.current_percent), 0)
		FROM mv_register_public_holdings h
		LEFT JOIN mv_top_shorts ts ON ts.product_code = h.stock_code
		WHERE h.stock_code IS NOT NULL AND upper(COALESCE(h.member_state, '')) = $1
		GROUP BY h.stock_code
		ORDER BY members DESC, h.stock_code
		LIMIT $2`, code, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []*PoliticianStockRollupRow
	for rows.Next() {
		var r PoliticianStockRollupRow
		if err := rows.Scan(&r.StockCode, &r.CompanyName, &r.Industry,
			&r.PoliticianCount, &r.ShortPercent); err != nil {
			return nil, 0, err
		}
		out = append(out, &r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	var people int32
	if err := s.db.QueryRow(ctx, `
		SELECT count(DISTINCT politician_id) FROM mv_register_public_holdings
		WHERE upper(COALESCE(member_state, '')) = $1`, code).Scan(&people); err != nil {
		return nil, 0, err
	}
	return out, people, nil
}

// ListRegisterChanges returns add/remove events over time.
//
// An "added" event needs a KNOWN date: an undated base declaration has no point
// on a timeline, and placing it at the parliament's opening would fabricate one.
func (s *postgresStore) ListRegisterChanges(since time.Time, kind, stockCode string, limit, offset int32) ([]*RegisterChangeRow, int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	conds := []string{}
	args := []any{}
	add := func(cond string, val any) {
		args = append(args, val)
		conds = append(conds, fmt.Sprintf(cond, len(args)))
	}
	if !since.IsZero() {
		add("changed_on >= $%d", since)
	}
	if kind == "added" || kind == "removed" {
		add("kind = $%d", kind)
	}
	if stockCode != "" {
		add("stock_code = $%d", strings.ToUpper(stockCode))
	}

	base := `
		WITH events AS (
		    SELECT slug, display_name, COALESCE(chamber, '') AS chamber,
		           COALESCE(division, '') AS division, COALESCE(member_state, '') AS member_state,
		           COALESCE(party, '') AS party, COALESCE(party_ab, '') AS party_ab,
		           'added' AS kind, item_no, holder, declared_text,
		           COALESCE(stock_code, '') AS stock_code, COALESCE(company_name, '') AS company_name,
		           COALESCE(entity_kind, '') AS entity_kind,
		           declared_from AS changed_on, source_url
		    FROM mv_register_public_holdings
		    WHERE declared_from IS NOT NULL AND declared_from_known
		    UNION ALL
		    SELECT slug, display_name, COALESCE(chamber, ''),
		           COALESCE(division, ''), COALESCE(member_state, ''),
		           COALESCE(party, ''), COALESCE(party_ab, ''),
		           'removed', item_no, holder, declared_text,
		           COALESCE(stock_code, ''), COALESCE(company_name, ''),
		           COALESCE(entity_kind, ''),
		           declared_to, source_url
		    FROM mv_register_public_holdings
		    WHERE declared_to IS NOT NULL
		)
		SELECT %s FROM events`
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}

	var total int32
	if err := s.db.QueryRow(ctx, fmt.Sprintf(base, "count(*)")+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	sel := `slug, display_name, chamber, division, member_state, party, party_ab,
	        kind, item_no, holder, declared_text, stock_code, company_name,
	        entity_kind, changed_on, source_url`
	sql := fmt.Sprintf(base, sel) + where +
		fmt.Sprintf(" ORDER BY changed_on DESC, display_name LIMIT $%d OFFSET $%d", len(args)+1, len(args)+2)
	args = append(args, limit, offset)

	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []*RegisterChangeRow
	for rows.Next() {
		var e RegisterChangeRow
		var p PoliticianRow
		var changed *time.Time
		if err := rows.Scan(&p.Slug, &p.DisplayName, &p.Chamber, &p.Division,
			&p.StateCode, &p.Party, &p.PartyAb,
			&e.Kind, &e.ItemNo, &e.Holder, &e.DeclaredText, &e.StockCode,
			&e.CompanyName, &e.EntityKind, &changed, &e.SourceURL); err != nil {
			return nil, 0, err
		}
		if changed != nil {
			e.ChangedOn = *changed
		}
		e.ItemLabel = registerItemLabel(e.ItemNo)
		e.Politician = &p
		out = append(out, &e)
	}
	return out, total, rows.Err()
}

// ListShortInterestOverlap joins declared interests to ASIC short interest.
//
// The percentage is THE COMPANY's, market-wide. The registers record no
// quantities, so it cannot be a property of anyone's holding — the handler
// serves a mandatory caveat alongside it.
func (s *postgresStore) ListShortInterestOverlap(minShortPercent float64, limit int32) ([]*PoliticianStockRollupRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	rows, err := s.db.Query(ctx, `
		SELECT h.stock_code, COALESCE(max(h.company_name), ''), COALESCE(max(h.industry), ''),
		       count(DISTINCT h.politician_id) AS members,
		       max(ts.current_percent) AS short_pct
		FROM mv_register_public_holdings h
		JOIN mv_top_shorts ts ON ts.product_code = h.stock_code
		WHERE h.stock_code IS NOT NULL
		  AND h.currently_declared
		  AND ts.current_percent >= $1
		GROUP BY h.stock_code
		ORDER BY short_pct DESC, members DESC
		LIMIT $2`, minShortPercent, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*PoliticianStockRollupRow
	for rows.Next() {
		var r PoliticianStockRollupRow
		if err := rows.Scan(&r.StockCode, &r.CompanyName, &r.Industry,
			&r.PoliticianCount, &r.ShortPercent); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}
