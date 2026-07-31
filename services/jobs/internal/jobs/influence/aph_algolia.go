package influence

// Builds the `politicians` Algolia index from the PUBLISHED register.
//
// WHAT MAY BE INDEXED. Everything here comes from mv_register_public_holdings,
// which is the same view the public read path uses — so the index cannot contain
// a row the site would not already show. That is deliberate and load-bearing:
// a search index is a second read path, and the §8.16/§8.17 lesson is that a
// second path which trusts its own filter is how a withheld row gets published.
// Nothing here queries register_declared_items or register_item_securities.
//
// EDITORIAL RULE 5: no amount, quantity or value field exists below, because
// none exists in the source. The counts are counts of DECLARED THINGS.
//
// Party is deliberately allowed to be EMPTY. It reaches the register through an
// electorate join rather than the APH listing, so it is genuinely absent for
// some members; the UI renders that as "not recorded". Substituting a guess
// would attribute a party to a named individual.

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/algolia"
	"github.com/jackc/pgx/v5/pgxpool"
)

// politicianRecord is one searchable parliamentarian.
//
// Field names are snake_case to match the stocks index convention and the TS
// client that reads both.
type politicianRecord struct {
	ObjectID    string `json:"objectID"`
	Slug        string `json:"slug"`
	DisplayName string `json:"display_name"`
	Surname     string `json:"surname,omitempty"`
	Chamber     string `json:"chamber,omitempty"`
	Division    string `json:"division,omitempty"`
	StateCode   string `json:"state_code,omitempty"`
	Party       string `json:"party,omitempty"`
	PartyAb     string `json:"party_ab,omitempty"`

	FirstParliament int32   `json:"first_parliament,omitempty"`
	LastParliament  int32   `json:"last_parliament,omitempty"`
	Parliaments     []int32 `json:"parliaments,omitempty"`

	// Counts of DECLARED THINGS — never a value, never a size.
	DeclaredListedCount   int32 `json:"declared_listed_count"`
	DeclaredPropertyCount int32 `json:"declared_property_count"`

	// The searchable surface: what this member actually declares. A reader
	// looking for "who declares Woodside" or "who declares property in Bondi"
	// is searching these.
	StockCodes   []string `json:"stock_codes,omitempty"`
	CompanyNames []string `json:"company_names,omitempty"`
	Industries   []string `json:"industries,omitempty"`
	Suburbs      []string `json:"suburbs,omitempty"`

	// A single flag the UI facets on, so "has declared interests" does not have
	// to be expressed as a numeric filter on two separate fields.
	HasInterests bool `json:"has_interests"`
}

// maxIndexedFacetValues caps the per-record arrays. Algolia's record ceiling is
// 10KB on the standard plan and a long-serving member can declare hundreds of
// distinct companies; an oversized record is rejected for the WHOLE batch, so
// the cap is a reliability control, not a display one.
const maxIndexedFacetValues = 60

func politicianIndexName() string {
	if v := strings.TrimSpace(os.Getenv("ALGOLIA_POLITICIANS_INDEX")); v != "" {
		return v
	}
	return "politicians"
}

// politicianIndexSettings configures search + faceting.
//
// An index with DEFAULT settings facets nothing, so the explorer's filter rail
// would render empty with no error to explain it. These are pushed on every run
// so a hand-edit in the Algolia dashboard cannot silently become the contract.
func politicianIndexSettings() map[string]any {
	return map[string]any{
		// Order matters: Algolia ranks an early attribute's match higher. A
		// person's name beats the name of a company they declare, which is what
		// someone typing "Chalmers" means.
		"searchableAttributes": []string{
			"display_name",
			"surname",
			"division",
			"unordered(party)",
			"unordered(company_names)",
			"unordered(stock_codes)",
			"unordered(suburbs)",
			"unordered(industries)",
		},
		"attributesForFaceting": []string{
			"searchable(party_ab)",
			"searchable(party)",
			"chamber",
			"state_code",
			"searchable(industries)",
			"has_interests",
			"parliaments",
		},
		// Rank a member who declares more things higher only as a TIE-BREAK,
		// after textual relevance. It is a proxy for "there is something to
		// read on this profile", not a claim that they matter more.
		"customRanking":         []string{"desc(declared_listed_count)", "desc(declared_property_count)"},
		"attributesToHighlight": []string{"display_name", "division", "company_names", "suburbs"},
		"maxValuesPerFacet":     100,
	}
}

// loadPoliticianRecords reads the published register into index records.
func loadPoliticianRecords(ctx context.Context, pool *pgxpool.Pool) ([]politicianRecord, error) {
	// One pass over the published MV, aggregated per person. politicians is
	// joined for the identity columns the MV does not carry (surname), and
	// merged-away identities are excluded so a slug that redirects is not
	// independently searchable.
	rows, err := pool.Query(ctx, `
		SELECT p.slug,
		       p.display_name,
		       COALESCE(p.surname, ''),
		       COALESCE(max(h.chamber), ''),
		       COALESCE(max(h.division), ''),
		       COALESCE(max(h.member_state), ''),
		       COALESCE(max(h.party), ''),
		       COALESCE(max(h.party_ab), ''),
		       COALESCE(p.first_parliament, 0),
		       COALESCE(p.last_parliament, 0),
		       count(DISTINCT h.stock_code) FILTER (WHERE h.stock_code IS NOT NULL),
		       count(DISTINCT h.sal_code)   FILTER (WHERE h.sal_code IS NOT NULL),
		       COALESCE(array_agg(DISTINCT h.stock_code)   FILTER (WHERE h.stock_code IS NOT NULL), '{}'),
		       COALESCE(array_agg(DISTINCT h.company_name) FILTER (WHERE h.company_name IS NOT NULL AND btrim(h.company_name) <> ''), '{}'),
		       COALESCE(array_agg(DISTINCT h.industry)     FILTER (WHERE h.industry IS NOT NULL AND btrim(h.industry) <> ''), '{}'),
		       COALESCE(array_agg(DISTINCT h.sal_name)     FILTER (WHERE h.sal_name IS NOT NULL AND btrim(h.sal_name) <> ''), '{}')
		FROM politicians p
		LEFT JOIN mv_register_public_holdings h ON h.politician_id = p.id
		WHERE p.merged_into_id IS NULL
		GROUP BY p.id, p.slug, p.display_name, p.surname, p.first_parliament, p.last_parliament`)
	if err != nil {
		return nil, fmt.Errorf("load politician records: %w", err)
	}
	defer rows.Close()

	var out []politicianRecord
	for rows.Next() {
		var r politicianRecord
		if err := rows.Scan(
			&r.Slug, &r.DisplayName, &r.Surname, &r.Chamber, &r.Division,
			&r.StateCode, &r.Party, &r.PartyAb, &r.FirstParliament, &r.LastParliament,
			&r.DeclaredListedCount, &r.DeclaredPropertyCount,
			&r.StockCodes, &r.CompanyNames, &r.Industries, &r.Suburbs,
		); err != nil {
			return nil, fmt.Errorf("scan politician record: %w", err)
		}

		// objectID is the slug: slugs are minted once and never reassigned
		// (§3.3), so re-running the sync updates a person in place instead of
		// creating a second record for them under a new id.
		r.ObjectID = r.Slug
		r.HasInterests = r.DeclaredListedCount > 0 || r.DeclaredPropertyCount > 0
		r.Parliaments = parliamentRange(r.FirstParliament, r.LastParliament)
		r.StockCodes = capValues(r.StockCodes)
		r.CompanyNames = capValues(r.CompanyNames)
		r.Industries = capValues(r.Industries)
		r.Suburbs = capValues(r.Suburbs)

		out = append(out, r)
	}
	return out, rows.Err()
}

// parliamentRange expands first..last so the UI can facet on a single sitting.
func parliamentRange(first, last int32) []int32 {
	if first <= 0 {
		return nil
	}
	if last < first {
		last = first
	}
	// A guard against a corrupt row producing a million-element array.
	if last-first > 20 {
		last = first + 20
	}
	out := make([]int32, 0, last-first+1)
	for p := first; p <= last; p++ {
		out = append(out, p)
	}
	return out
}

func capValues(v []string) []string {
	if len(v) <= maxIndexedFacetValues {
		return v
	}
	return v[:maxIndexedFacetValues]
}

// runRegisterIndex pushes the register to Algolia.
func runRegisterIndex(ctx context.Context, pool *pgxpool.Pool, dryRun bool) (int, error) {
	appID := strings.TrimSpace(os.Getenv("ALGOLIA_APP_ID"))
	adminKey := strings.TrimSpace(os.Getenv("ALGOLIA_WRITE_KEY"))
	if adminKey == "" {
		adminKey = strings.TrimSpace(os.Getenv("ALGOLIA_ADMIN_KEY"))
	}

	records, err := loadPoliticianRecords(ctx, pool)
	if err != nil {
		return 0, err
	}
	if len(records) == 0 {
		return 0, fmt.Errorf("no politicians to index — refusing to touch the index")
	}

	if dryRun {
		log.Printf("[register-index] DRY RUN %d records; e.g. %s (%s) listed=%d property=%d codes=%d",
			len(records), records[0].DisplayName, records[0].PartyAb,
			records[0].DeclaredListedCount, records[0].DeclaredPropertyCount, len(records[0].StockCodes))
		return len(records), nil
	}

	syncer := algolia.New(appID, adminKey, politicianIndexName())
	if !syncer.IsConfigured() {
		return 0, fmt.Errorf("ALGOLIA_APP_ID and ALGOLIA_WRITE_KEY are required for -mode register-index")
	}

	if err := syncer.ReplaceSettings(ctx, politicianIndexSettings()); err != nil {
		return 0, fmt.Errorf("push index settings: %w", err)
	}

	rows := make([]any, len(records))
	for i, r := range records {
		rows[i] = r
	}
	n, err := syncer.SyncAnyInBatches(ctx, rows, 500)
	if err != nil {
		return n, fmt.Errorf("sync politicians: %w", err)
	}
	return n, nil
}
