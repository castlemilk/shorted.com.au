package shorts

// Read models for the politician explorer. Holding aggregates are sourced from
// the two explorer materialized views; company sets, industry movement, recent
// changes and source documents read the same public holdings surface as the
// existing register endpoints.

import (
	"context"
	"fmt"
	"strings"
	"time"
)

type RegisterItemCountRow struct {
	ItemNo          int32
	ItemLabel       string
	CurrentCount    int32
	PoliticianCount int32
	AllTimeCount    int32
}

type RegisterHolderCountRow struct {
	Holder       string
	CurrentCount int32
}

type RegisterMonthlyCountRow struct {
	Month         string
	DeclaredCount int32
}

type RegisterIndustryTrendRow struct {
	Industry     string
	CurrentCount int32
	Count90dAgo  int32
}

type RegisterIndustryCountRow struct {
	Industry     string
	CompanyCount int32
}

type RegisterSourceDocumentRow struct {
	Label      string
	SourceURL  string
	Parliament int32
	Chamber    string
}

type PoliticianSummaryRow struct {
	Politician           *PoliticianRow
	ItemCounts           []*RegisterItemCountRow
	DistinctCompanyCount int32
	PropertyCount        int32
	GiftsTravelCount     int32
	LiabilityCount       int32
	Changes90d           int32
	Trend                []*RegisterMonthlyCountRow
	UndatedCount         int32
	AsAt                 time.Time
}

type RegisterExplorerRow struct {
	Overview             *RegisterOverviewRow
	ItemCounts           []*RegisterItemCountRow
	HolderCounts         []*RegisterHolderCountRow
	Changes7d            int32
	MembersChanged7d     int32
	Changes30d           int32
	MembersChanged30d    int32
	IndustryTrends       []*RegisterIndustryTrendRow
	ExtractedParliaments []int32
	PartialParliaments   []int32
	PendingParliaments   []int32
	CurrentDeclaredCount int32
	DistinctCompanyCount int32
	PropertyCount        int32
	GiftsTravelCount     int32
	LiabilityCount       int32
	AsAt                 time.Time
}

type PoliticianExplorerProfileRow struct {
	Politician           *PoliticianRow
	CanonicalSlug        string
	Terms                []*PoliticianTermRow
	ItemCounts           []*RegisterItemCountRow
	HolderCounts         []*RegisterHolderCountRow
	IndustryCounts       []*RegisterIndustryCountRow
	Timeline             []*RegisterMonthlyCountRow
	UndatedCount         int32
	RecentChanges        []*RegisterChangeRow
	SourceDocuments      []*RegisterSourceDocumentRow
	ExtractedParliaments []int32
	PartialParliaments   []int32
	PendingParliaments   []int32
	AsAt                 time.Time
}

type SharedDeclaredCompanyRow struct {
	StockCode          string
	CompanyName        string
	Industry           string
	HoldersA           []string
	HoldersB           []string
	CurrentlyDeclaredA bool
	CurrentlyDeclaredB bool
}

type PoliticianOnlyCompanyRow struct {
	StockCode         string
	CompanyName       string
	Industry          string
	Holders           []string
	CurrentlyDeclared bool
}

type PoliticianComparisonRow struct {
	SummaryA              *PoliticianSummaryRow
	SummaryB              *PoliticianSummaryRow
	HolderCountsA         []*RegisterHolderCountRow
	HolderCountsB         []*RegisterHolderCountRow
	SharedCompanies       []*SharedDeclaredCompanyRow
	OnlyCompaniesA        []*PoliticianOnlyCompanyRow
	OnlyCompaniesB        []*PoliticianOnlyCompanyRow
	OnlyAMore             int32
	OnlyBMore             int32
	ExtractedParliamentsA []int32
	PartialParliamentsA   []int32
	PendingParliamentsA   []int32
	ExtractedParliamentsB []int32
	PartialParliamentsB   []int32
	PendingParliamentsB   []int32
	AsAt                  time.Time
}

type politicianRollupScanRow struct {
	Current                                                                                         [14]int32
	AllTime                                                                                         [14]int32
	SelfCurrent, SpousePartnerCurrent, DependentChildrenCurrent, UnspecifiedCurrent                 int32
	DistinctCompanyCount, PropertyCount, GiftsTravelCount, LiabilityCount, Changes90d, UndatedCount int32
}

func politicianScanDest(r *PoliticianRow) []any {
	return []any{
		&r.Slug, &r.DisplayName, &r.Surname, &r.GivenNames, &r.Honorific,
		&r.Chamber, &r.Division, &r.StateCode, &r.Party, &r.PartyAb,
		&r.FirstParliament, &r.LastParliament, &r.APHMPID,
		&r.DeclaredListedCount, &r.DeclaredPropertyCount,
		&r.PhotoURL, &r.PhotoLicence, &r.PhotoAuthor, &r.PhotoSourceURL,
	}
}

func politicianRollupDest(r *politicianRollupScanRow) []any {
	dest := make([]any, 0, 38)
	for i := range r.Current {
		dest = append(dest, &r.Current[i])
	}
	for i := range r.AllTime {
		dest = append(dest, &r.AllTime[i])
	}
	dest = append(dest,
		&r.SelfCurrent, &r.SpousePartnerCurrent, &r.DependentChildrenCurrent, &r.UnspecifiedCurrent,
		&r.DistinctCompanyCount, &r.PropertyCount, &r.GiftsTravelCount, &r.LiabilityCount,
		&r.Changes90d, &r.UndatedCount,
	)
	return dest
}

func sanitisePoliticianPortrait(r *PoliticianRow) {
	if r.PhotoLicence == "" || r.PhotoSourceURL == "" {
		r.PhotoURL = ""
	}
}

func scanPoliticianSummary(scan func(dest ...any) error) (*PoliticianSummaryRow, *politicianRollupScanRow, error) {
	politician := &PoliticianRow{}
	rollup := &politicianRollupScanRow{}
	dest := politicianScanDest(politician)
	dest = append(dest, politicianRollupDest(rollup)...)
	if err := scan(dest...); err != nil {
		return nil, nil, err
	}
	sanitisePoliticianPortrait(politician)
	return politicianSummaryFromRollup(politician, rollup), rollup, nil
}

func politicianSummaryFromRollup(politician *PoliticianRow, rollup *politicianRollupScanRow) *PoliticianSummaryRow {
	items := make([]*RegisterItemCountRow, 0, 14)
	for i := 0; i < 14; i++ {
		itemNo := int32(i + 1)
		items = append(items, &RegisterItemCountRow{
			ItemNo: itemNo, ItemLabel: registerItemLabel(itemNo),
			CurrentCount: rollup.Current[i], AllTimeCount: rollup.AllTime[i],
		})
	}
	return &PoliticianSummaryRow{
		Politician: politician, ItemCounts: items,
		DistinctCompanyCount: rollup.DistinctCompanyCount,
		PropertyCount:        rollup.PropertyCount, GiftsTravelCount: rollup.GiftsTravelCount,
		LiabilityCount: rollup.LiabilityCount, Changes90d: rollup.Changes90d,
		UndatedCount: rollup.UndatedCount,
	}
}

// summaryItemCurrent names a rollup item column with its LEFT JOIN default
// applied. See politicianSummarySelect: the rollup is an OUTER join, so every
// expression built over it must survive a missing rollup row.
func summaryItemCurrent(itemNo int32) string {
	return fmt.Sprintf("COALESCE(r.item_%d_current_count, 0)", itemNo)
}

// summaryDeclaredItemsTotal is the 14-item current total, used for the default
// sort. Built from summaryItemCurrent so the NULL defaults cannot drift apart
// from the projection.
func summaryDeclaredItemsTotal() string {
	parts := make([]string, 0, 14)
	for itemNo := int32(1); itemNo <= 14; itemNo++ {
		parts = append(parts, summaryItemCurrent(itemNo))
	}
	return strings.Join(parts, " + ")
}

// changes90dCount is the per-member 90-day change count, evaluated at QUERY
// time against CURRENT_DATE.
//
// It is deliberately NOT a column on mv_register_politician_rollup. A window
// materialised into that view freezes its clock at refresh time, while the two
// surfaces rendered beside it — the hub's 7d/30d activity strip in
// GetRegisterExplorer and a member's recent-changes list in
// loadRecentRegisterChanges — both evaluate CURRENT_DATE when the query runs.
// The same page then disagrees with itself by a day for every day the refresh
// is late: a member reading "0 changes (90d)" in the hub table while their own
// profile lists a change from last week. All three now read one clock.
//
// The event definition is copied from the strip's `events` CTE on purpose: a
// dated declared_from is one event, a declared_to is another. The strip's 30d
// total and the sum of these 90d counts are therefore the same measure at two
// window widths, not two measures that happen to share a label.
//
// Cost, measured on the dev corpus (17,144 holdings / 323 members): ~11ms for
// the whole corpus, planned as one grouped pass and hash-joined — not a
// per-row correlated subquery.
const changes90dCount = `
	    SELECT politician_id, count(*)::INTEGER AS changes_90d_count
	    FROM (
	        SELECT politician_id
	        FROM mv_register_public_holdings
	        WHERE declared_from_known AND declared_from >= CURRENT_DATE - 90
	        UNION ALL
	        SELECT politician_id
	        FROM mv_register_public_holdings
	        WHERE declared_to IS NOT NULL AND declared_to >= CURRENT_DATE - 90
	    ) events
	    GROUP BY politician_id`

// politicianSummarySelect joins the rollup as an OUTER join, not an inner one.
//
// mv_register_politician_rollup is a snapshot: a politician inserted (or
// un-merged) since the last refresh has no row in it. Under an INNER JOIN that
// person vanished from ListPoliticianSummaries entirely — not "listed with no
// declarations", but absent from the hub table AND from its `total`, which is
// a silent false-absence claim about a sitting member. Every rollup column is
// therefore COALESCEd to zero so the person appears with empty explorer
// figures, and the ORDER BY expressions COALESCE too (a bare NULL sorts FIRST
// under `DESC` in Postgres, which would have floated exactly those unrefreshed
// rows to the top of the default sort).
const politicianSummarySelect = `
	SELECT p.slug, p.display_name, p.surname, p.given_names, p.honorific,
	       COALESCE(t.chamber, ''), COALESCE(t.division, ''), COALESCE(t.state_code, ''),
	       COALESCE(t.party, e.federal_party, ''), COALESCE(t.party_ab, e.federal_party_ab, ''),
	       COALESCE(p.first_parliament, 0), COALESCE(p.last_parliament, 0),
	       COALESCE(p.aph_mpid, ''),
	       -- Slots 14/15 are Politician.declared_listed_count /
	       -- declared_property_count, which every other rpc fills from
	       -- politicianSelect's ALL-TIME distinct company/suburb counts. The
	       -- rollup's all-time columns replicate that projection exactly, so the
	       -- same person cannot report a different number depending on which rpc
	       -- was called (and the profile page's declaredListedCount > 0
	       -- indexability rule cannot flip between read paths). The
	       -- currently-declared figures ride on PoliticianSummary's own
	       -- distinct_company_count / property_count fields below.
	       COALESCE(r.alltime_company_count, 0), COALESCE(r.alltime_suburb_count, 0),
	       COALESCE(p.photo_url, ''), COALESCE(p.photo_licence, ''),
	       COALESCE(p.photo_author, ''), COALESCE(p.photo_source_url, ''),
	       COALESCE(r.item_1_current_count, 0), COALESCE(r.item_2_current_count, 0), COALESCE(r.item_3_current_count, 0),
	       COALESCE(r.item_4_current_count, 0), COALESCE(r.item_5_current_count, 0), COALESCE(r.item_6_current_count, 0),
	       COALESCE(r.item_7_current_count, 0), COALESCE(r.item_8_current_count, 0), COALESCE(r.item_9_current_count, 0),
	       COALESCE(r.item_10_current_count, 0), COALESCE(r.item_11_current_count, 0), COALESCE(r.item_12_current_count, 0),
	       COALESCE(r.item_13_current_count, 0), COALESCE(r.item_14_current_count, 0),
	       COALESCE(r.item_1_all_time_count, 0), COALESCE(r.item_2_all_time_count, 0), COALESCE(r.item_3_all_time_count, 0),
	       COALESCE(r.item_4_all_time_count, 0), COALESCE(r.item_5_all_time_count, 0), COALESCE(r.item_6_all_time_count, 0),
	       COALESCE(r.item_7_all_time_count, 0), COALESCE(r.item_8_all_time_count, 0), COALESCE(r.item_9_all_time_count, 0),
	       COALESCE(r.item_10_all_time_count, 0), COALESCE(r.item_11_all_time_count, 0), COALESCE(r.item_12_all_time_count, 0),
	       COALESCE(r.item_13_all_time_count, 0), COALESCE(r.item_14_all_time_count, 0),
	       COALESCE(r.self_current_count, 0), COALESCE(r.spouse_partner_current_count, 0),
	       COALESCE(r.dependent_children_current_count, 0), COALESCE(r.unspecified_current_count, 0),
	       COALESCE(r.distinct_company_count, 0), COALESCE(r.property_count, 0), COALESCE(r.gifts_travel_count, 0),
	       COALESCE(r.liability_count, 0), COALESCE(c.changes_90d_count, 0), COALESCE(r.undated_count, 0)
	FROM politicians p
	LEFT JOIN mv_register_politician_rollup r ON r.politician_id = p.id
	LEFT JOIN (` + changes90dCount + `
	) c ON c.politician_id = p.id
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
	WHERE p.merged_into_id IS NULL`

func (s *postgresStore) GetRegisterExplorer() (*RegisterExplorerRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	overview, err := s.GetRegisterOverview()
	if err != nil {
		return nil, err
	}
	// The overview's own as-at is max(lodged_date) — the newest lodgement we
	// hold. Its RefreshedAt (our snapshot-rebuild clock) stays on the overview
	// for the one rpc that publishes it as a separate field; it must never be
	// served as this surface's as_at. See registerAsAt.
	out := &RegisterExplorerRow{Overview: overview, AsAt: overview.AsAt}

	itemRows, err := s.db.Query(ctx, `
		SELECT i.item_no,
		       count(h.item_no) FILTER (WHERE h.currently_declared)::INTEGER,
		       count(DISTINCT h.politician_id) FILTER (WHERE h.currently_declared)::INTEGER,
		       count(h.item_no)::INTEGER
		FROM generate_series(1, 14) AS i(item_no)
		LEFT JOIN mv_register_public_holdings h ON h.item_no = i.item_no
		GROUP BY i.item_no
		ORDER BY i.item_no`)
	if err != nil {
		return nil, err
	}
	for itemRows.Next() {
		var r RegisterItemCountRow
		if err := itemRows.Scan(&r.ItemNo, &r.CurrentCount, &r.PoliticianCount, &r.AllTimeCount); err != nil {
			itemRows.Close()
			return nil, err
		}
		r.ItemLabel = registerItemLabel(r.ItemNo)
		out.ItemCounts = append(out.ItemCounts, &r)
	}
	if err := itemRows.Err(); err != nil {
		itemRows.Close()
		return nil, err
	}
	itemRows.Close()

	out.HolderCounts, err = s.loadHolderCounts(ctx, "")
	if err != nil {
		return nil, err
	}
	if err := s.db.QueryRow(ctx, `
		SELECT
		  COALESCE(sum(item_1_current_count + item_2_current_count + item_3_current_count + item_4_current_count + item_5_current_count + item_6_current_count + item_7_current_count + item_8_current_count + item_9_current_count + item_10_current_count + item_11_current_count + item_12_current_count + item_13_current_count + item_14_current_count), 0)::INTEGER,
		  COALESCE(sum(gifts_travel_count), 0)::INTEGER,
		  COALESCE(sum(liability_count), 0)::INTEGER
		FROM mv_register_politician_rollup`).Scan(
		&out.CurrentDeclaredCount, &out.GiftsTravelCount, &out.LiabilityCount); err != nil {
		return nil, err
	}
	// "Properties" is a count of currently-declared item-3 entries, NOT of the
	// suburbs the resolver managed to place. Distinct suburbs stay available as
	// the overview's resolved_suburb_count, which is labelled as a resolver
	// figure; this tile is labelled as holdings and must count holdings.
	if err := s.db.QueryRow(ctx, `
		SELECT
		  count(DISTINCT stock_code) FILTER (WHERE currently_declared AND stock_code IS NOT NULL)::INTEGER,
		  count(*) FILTER (WHERE item_no = 3 AND currently_declared)::INTEGER
		FROM mv_register_public_holdings`).Scan(&out.DistinctCompanyCount, &out.PropertyCount); err != nil {
		return nil, err
	}

	if err := s.db.QueryRow(ctx, `
		WITH events AS (
		    SELECT politician_id, declared_from AS changed_on
		    FROM mv_register_public_holdings
		    WHERE declared_from_known AND declared_from >= CURRENT_DATE - 30
		    UNION ALL
		    SELECT politician_id, declared_to AS changed_on
		    FROM mv_register_public_holdings
		    WHERE declared_to IS NOT NULL AND declared_to >= CURRENT_DATE - 30
		)
		SELECT
		  count(*) FILTER (WHERE changed_on >= CURRENT_DATE - 7)::INTEGER,
		  count(DISTINCT politician_id) FILTER (WHERE changed_on >= CURRENT_DATE - 7)::INTEGER,
		  count(*)::INTEGER,
		  count(DISTINCT politician_id)::INTEGER
		FROM events`).Scan(&out.Changes7d, &out.MembersChanged7d, &out.Changes30d, &out.MembersChanged30d); err != nil {
		return nil, err
	}

	// Both sides of the movement are DATED-ONLY and use the identical predicate,
	// evaluated at two dates. ~80% of currently-declared rows carry no start
	// date, so an undated-inclusive "now" measured against a dated-only
	// "90 days ago" reported every industry as growing by roughly its undated
	// population — a pure artefact, which `ORDER BY abs(...)` then promoted to
	// the top of the movement list. An industry with no dated activity in the
	// window must report no movement.
	trendRows, err := s.db.Query(ctx, `
		WITH industry_counts AS (
		    SELECT btrim(industry) AS industry,
		           count(DISTINCT stock_code) FILTER (
		               WHERE declared_from_known
		                 AND declared_from <= CURRENT_DATE
		                 AND (declared_to IS NULL OR declared_to > CURRENT_DATE)
		           )::INTEGER AS current_count,
		           count(DISTINCT stock_code) FILTER (
		               WHERE declared_from_known
		                 AND declared_from <= CURRENT_DATE - 90
		                 AND (declared_to IS NULL OR declared_to > CURRENT_DATE - 90)
		           )::INTEGER AS count_90d_ago
		    FROM mv_register_public_holdings
		    WHERE stock_code IS NOT NULL AND industry IS NOT NULL AND btrim(industry) <> ''
		    GROUP BY btrim(industry)
		)
		SELECT industry, current_count, count_90d_ago
		FROM industry_counts
		ORDER BY abs(current_count - count_90d_ago) DESC, industry
		LIMIT 10`)
	if err != nil {
		return nil, err
	}
	for trendRows.Next() {
		var r RegisterIndustryTrendRow
		if err := trendRows.Scan(&r.Industry, &r.CurrentCount, &r.Count90dAgo); err != nil {
			trendRows.Close()
			return nil, err
		}
		out.IndustryTrends = append(out.IndustryTrends, &r)
	}
	if err := trendRows.Err(); err != nil {
		trendRows.Close()
		return nil, err
	}
	trendRows.Close()

	coverage := &PoliticianRow{}
	if err := s.loadCoverage(ctx, coverage); err != nil {
		return nil, err
	}
	out.ExtractedParliaments = coverage.ExtractedParliaments
	out.PartialParliaments = coverage.PartialParliaments
	out.PendingParliaments = coverage.PendingParliaments
	return out, nil
}

func (s *postgresStore) ListPoliticianSummaries(chamber, stateCode, partyAb string, itemNo int32, query, sortKey string, limit, offset int32) ([]*PoliticianSummaryRow, int32, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	conds := []string{}
	args := []any{}
	add := func(condition string, arg any) {
		args = append(args, arg)
		conds = append(conds, fmt.Sprintf(condition, len(args)))
	}
	if chamber != "" {
		add("t.chamber = $%d", strings.ToLower(strings.TrimSpace(chamber)))
	}
	if stateCode != "" {
		add("upper(t.state_code) = $%d", strings.ToUpper(strings.TrimSpace(stateCode)))
	}
	if partyAb != "" {
		add("upper(COALESCE(t.party_ab, e.federal_party_ab, '')) = $%d", strings.ToUpper(strings.TrimSpace(partyAb)))
	}
	if itemNo >= 1 && itemNo <= 14 {
		conds = append(conds, summaryItemCurrent(itemNo)+" > 0")
	}
	if query != "" {
		add("p.display_name ILIKE '%%' || $%d || '%%'", strings.TrimSpace(query))
	}
	where := ""
	if len(conds) > 0 {
		where = " AND " + strings.Join(conds, " AND ")
	}

	countArgs := append([]any(nil), args...)
	var total int32
	if err := s.db.QueryRow(ctx, "SELECT count(*) FROM ("+politicianSummarySelect+where+") summaries", countArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	// Every sort expression COALESCEs: the rollup is an OUTER join now, and a
	// bare NULL sorts FIRST under DESC in Postgres, so an unrefreshed member
	// would otherwise lead the table they are least able to fill.
	orderBy := summaryDeclaredItemsTotal() + " DESC, p.surname, p.given_names"
	switch strings.ToLower(strings.TrimSpace(sortKey)) {
	case "companies":
		orderBy = "COALESCE(r.distinct_company_count, 0) DESC, p.surname, p.given_names"
	case "properties":
		orderBy = "COALESCE(r.property_count, 0) DESC, p.surname, p.given_names"
	case "recent_changes":
		orderBy = "COALESCE(c.changes_90d_count, 0) DESC, p.surname, p.given_names"
	case "name":
		orderBy = "p.surname, p.given_names"
	}

	listArgs := append([]any{}, args...)
	listArgs = append(listArgs, limit, offset)
	rows, err := s.db.Query(ctx, politicianSummarySelect+where+
		fmt.Sprintf(" ORDER BY %s LIMIT $%d OFFSET $%d", orderBy, len(args)+1, len(args)+2), listArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []*PoliticianSummaryRow
	var slugs []string
	for rows.Next() {
		summary, _, err := scanPoliticianSummary(rows.Scan)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, summary)
		slugs = append(slugs, summary.Politician.Slug)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := s.loadSummaryTrends(ctx, out, slugs, 12); err != nil {
		return nil, 0, err
	}
	asAt, err := s.registerAsAt(ctx)
	if err != nil {
		return nil, 0, err
	}
	for _, summary := range out {
		summary.AsAt = asAt
	}
	return out, total, nil
}

const registerMonthlySource = "mv_register_politician_monthly"

// summaryTrendQuery windows the monthly snapshot on the SNAPSHOT'S OWN newest
// month, never on wall-clock CURRENT_DATE. mv_register_politician_monthly's
// month grid is frozen at REFRESH time, so a CURRENT_DATE window loses one
// point for every month the refresh is late and returns nothing at all once the
// snapshot is `points` months old — while the count tiles beside the sparkline,
// which have no such window, keep rendering. Anchoring on max(month) yields a
// complete, honestly-dated window from a stale snapshot instead of a silently
// shrinking one. An empty snapshot makes max(month) NULL, the comparison NULL,
// and the result an empty trend rather than an error.
//
// The source is a parameter so the staleness test can run this exact SQL
// against a deliberately-aged copy of the snapshot.
func summaryTrendQuery(source string) string {
	return fmt.Sprintf(`
		WITH snapshot AS (
		    SELECT max(month) AS latest_month FROM %[1]s src
		)
		SELECT p.slug, to_char(m.month, 'YYYY-MM'), m.declared_count
		FROM %[1]s m
		JOIN politicians p ON p.id = m.politician_id
		CROSS JOIN snapshot s
		WHERE p.slug = ANY($1)
		  AND m.month >= (s.latest_month - make_interval(months => $2::INTEGER - 1))::DATE
		ORDER BY p.slug, m.month`, source)
}

func (s *postgresStore) loadSummaryTrends(ctx context.Context, summaries []*PoliticianSummaryRow, slugs []string, points int32) error {
	if len(slugs) == 0 {
		return nil
	}
	if points <= 0 {
		points = 12
	}
	rows, err := s.db.Query(ctx, summaryTrendQuery(registerMonthlySource), slugs, points)
	if err != nil {
		return err
	}
	defer rows.Close()
	trends := map[string][]*RegisterMonthlyCountRow{}
	for rows.Next() {
		var slug, month string
		var count int32
		if err := rows.Scan(&slug, &month, &count); err != nil {
			return err
		}
		trends[slug] = append(trends[slug], &RegisterMonthlyCountRow{Month: month, DeclaredCount: count})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, summary := range summaries {
		trend := trends[summary.Politician.Slug]
		if points > 0 && int32(len(trend)) > points {
			trend = trend[len(trend)-int(points):]
		}
		summary.Trend = trend
	}
	return nil
}

func (s *postgresStore) loadPoliticianTerms(ctx context.Context, slug string) ([]*PoliticianTermRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT parliament, COALESCE(chamber, ''), COALESCE(division, ''),
		       COALESCE(state_code, ''), COALESCE(party, ''), COALESCE(party_ab, '')
		FROM politician_terms
		WHERE politician_id = (SELECT id FROM politicians WHERE slug = $1)
		ORDER BY parliament DESC`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*PoliticianTermRow
	for rows.Next() {
		var term PoliticianTermRow
		if err := rows.Scan(&term.Parliament, &term.Chamber, &term.Division, &term.StateCode, &term.Party, &term.PartyAb); err != nil {
			return nil, err
		}
		out = append(out, &term)
	}
	return out, rows.Err()
}

func (s *postgresStore) loadPoliticianSummaryBySlug(ctx context.Context, slug string) (*PoliticianSummaryRow, *politicianRollupScanRow, error) {
	return scanPoliticianSummary(s.db.QueryRow(ctx,
		politicianSummarySelect+" AND p.slug = $1 LIMIT 1", slug).Scan)
}

func (s *postgresStore) GetPoliticianExplorerProfile(slug string, topIndustries int32) (*PoliticianExplorerProfileRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	summary, _, err := s.loadPoliticianSummaryBySlug(ctx, slug)
	if err != nil {
		return nil, err
	}
	terms, err := s.loadPoliticianTerms(ctx, slug)
	if err != nil {
		return nil, err
	}
	if topIndustries <= 0 {
		topIndustries = 5
	}
	if topIndustries > 20 {
		topIndustries = 20
	}

	profile := &PoliticianExplorerProfileRow{
		Politician:    summary.Politician,
		CanonicalSlug: summary.Politician.Slug,
		Terms:         terms,
		ItemCounts:    summary.ItemCounts,
		UndatedCount:  summary.UndatedCount,
	}
	profile.HolderCounts, err = s.loadHolderCounts(ctx, slug)
	if err != nil {
		return nil, err
	}
	profile.IndustryCounts, err = s.loadIndustryCounts(ctx, slug, topIndustries)
	if err != nil {
		return nil, err
	}
	profile.Timeline, err = s.loadPoliticianTimeline(ctx, slug)
	if err != nil {
		return nil, err
	}
	profile.RecentChanges, err = s.loadRecentRegisterChanges(ctx, slug, 10, summary.Politician)
	if err != nil {
		return nil, err
	}
	profile.SourceDocuments, err = s.loadSourceDocuments(ctx, slug)
	if err != nil {
		return nil, err
	}
	coverage := &PoliticianRow{}
	if err := s.loadCoverage(ctx, coverage); err != nil {
		return nil, err
	}
	profile.ExtractedParliaments = coverage.ExtractedParliaments
	profile.PartialParliaments = coverage.PartialParliaments
	profile.PendingParliaments = coverage.PendingParliaments
	profile.AsAt, err = s.registerAsAt(ctx)
	if err != nil {
		return nil, err
	}
	return profile, nil
}

func (s *postgresStore) loadHolderCounts(ctx context.Context, slug string) ([]*RegisterHolderCountRow, error) {
	where := " WHERE currently_declared"
	args := []any{}
	if strings.TrimSpace(slug) != "" {
		where = " WHERE slug = $1 AND currently_declared"
		args = append(args, slug)
	}
	rows, err := s.db.Query(ctx, `
		SELECT holder, count(*)::INTEGER
		FROM mv_register_public_holdings`+where+`
		GROUP BY holder`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int32{}
	for rows.Next() {
		var holder string
		var count int32
		if err := rows.Scan(&holder, &count); err != nil {
			return nil, err
		}
		counts[holder] = count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	order := []string{"self", "spouse_partner", "dependent_children", "unspecified"}
	out := make([]*RegisterHolderCountRow, 0, len(order))
	for _, holder := range order {
		out = append(out, &RegisterHolderCountRow{Holder: holder, CurrentCount: counts[holder]})
	}
	return out, nil
}

func (s *postgresStore) loadIndustryCounts(ctx context.Context, slug string, limit int32) ([]*RegisterIndustryCountRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT btrim(industry), count(DISTINCT stock_code)::INTEGER
		FROM mv_register_public_holdings
		WHERE slug = $1
		  AND currently_declared
		  AND stock_code IS NOT NULL
		  AND industry IS NOT NULL
		  AND btrim(industry) <> ''
		GROUP BY btrim(industry)
		ORDER BY count(DISTINCT stock_code) DESC, btrim(industry)
		LIMIT $2`, slug, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*RegisterIndustryCountRow
	for rows.Next() {
		var r RegisterIndustryCountRow
		if err := rows.Scan(&r.Industry, &r.CompanyCount); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (s *postgresStore) loadPoliticianTimeline(ctx context.Context, slug string) ([]*RegisterMonthlyCountRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT to_char(m.month, 'YYYY-MM'), m.declared_count
		FROM mv_register_politician_monthly m
		JOIN politicians p ON p.id = m.politician_id
		WHERE p.slug = $1
		ORDER BY m.month`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*RegisterMonthlyCountRow
	for rows.Next() {
		var r RegisterMonthlyCountRow
		if err := rows.Scan(&r.Month, &r.DeclaredCount); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (s *postgresStore) loadRecentRegisterChanges(ctx context.Context, slug string, limit int32, politician *PoliticianRow) ([]*RegisterChangeRow, error) {
	rows, err := s.db.Query(ctx, `
		WITH events AS (
		    SELECT slug, 'added' AS kind, item_no, holder, declared_text,
		           COALESCE(stock_code, '') AS stock_code,
		           COALESCE(company_name, '') AS company_name,
		           declared_from AS changed_on, source_url,
		           COALESCE(entity_kind, '') AS entity_kind
		    FROM mv_register_public_holdings
		    WHERE declared_from IS NOT NULL AND declared_from_known
		    UNION ALL
		    SELECT slug, 'removed', item_no, holder, declared_text,
		           COALESCE(stock_code, ''), COALESCE(company_name, ''),
		           declared_to, source_url, COALESCE(entity_kind, '')
		    FROM mv_register_public_holdings
		    WHERE declared_to IS NOT NULL
		)
		SELECT kind, item_no, holder, declared_text, stock_code, company_name,
		       changed_on, source_url, entity_kind
		FROM events
		WHERE slug = $1 AND changed_on >= CURRENT_DATE - 90
		ORDER BY changed_on DESC, item_no, declared_text
		LIMIT $2`, slug, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*RegisterChangeRow
	for rows.Next() {
		var r RegisterChangeRow
		var changed *time.Time
		if err := rows.Scan(&r.Kind, &r.ItemNo, &r.Holder, &r.DeclaredText,
			&r.StockCode, &r.CompanyName, &changed, &r.SourceURL, &r.EntityKind); err != nil {
			return nil, err
		}
		if changed != nil {
			r.ChangedOn = *changed
		}
		r.ItemLabel = registerItemLabel(r.ItemNo)
		r.Politician = politician
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (s *postgresStore) loadSourceDocuments(ctx context.Context, slug string) ([]*RegisterSourceDocumentRow, error) {
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT
		       COALESCE(NULLIF(d.volume_label, ''), NULLIF(d.volume_range, ''),
		                NULLIF(d.member_hint, ''), d.source_url),
		       d.source_url, COALESCE(d.parliament, 0)::INTEGER, d.chamber
		FROM register_documents d
		JOIN (
		    SELECT DISTINCT source_url
		    FROM mv_register_public_holdings
		    WHERE slug = $1
		) h ON h.source_url = d.source_url
		WHERE d.source_url ILIKE '%aph.gov.au%'
		ORDER BY COALESCE(d.parliament, 0) DESC, d.chamber, d.source_url`, slug)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*RegisterSourceDocumentRow
	for rows.Next() {
		var r RegisterSourceDocumentRow
		if err := rows.Scan(&r.Label, &r.SourceURL, &r.Parliament, &r.Chamber); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// registerAsAt is THE REGISTER'S clock, not ours: the newest lodgement date
// across the statements we hold, which is what the proto documents `as_at` to
// be and what every surface renders as "Register of Members' Interests, as at
// DATE" under editorial rule 1.
//
// It used to read max(refreshed_at) from mv_register_public_holdings — the
// moment WE last rebuilt the snapshot. Those two dates are not close: on the
// dev corpus the newest lodgement is 2026-07-21 and the last refresh is
// 2026-07-31, so every explorer surface asserted ten days of currency we do not
// have, beside the names of individual members, and a nightly refresh over an
// unchanged corpus would keep advancing the claim forever. When the snapshot
// clock matters (it is a staleness signal, not a provenance one) it rides on
// RegisterOverviewRow.RefreshedAt, which the proto carries as its own separate
// `refreshed_at` field.
//
// A zero return means we hold no dated lodgement at all; the caller must leave
// as_at unset rather than substitute a timestamp of ours.
func (s *postgresStore) registerAsAt(ctx context.Context) (time.Time, error) {
	var asAt *time.Time
	if err := s.db.QueryRow(ctx, `SELECT max(lodged_date) FROM register_statements`).Scan(&asAt); err != nil {
		return time.Time{}, err
	}
	if asAt == nil {
		return time.Time{}, nil
	}
	return *asAt, nil
}

// parliamentRange is the CONTIGUOUS span first..last, as a set.
//
// Deliberately contiguous, and deliberately not derived from politician_terms.
// A term row is written only when that member's document has been EXTRACTED
// (influence/aph_load.go's resolvePolitician), so the terms set is a record of
// what we have READ, not of when the person served — and intersecting a
// coverage bucket with it silently answers "have we read this?" twice:
//
//   - the PENDING bucket became unreachable. A pending parliament is one with
//     zero extracted documents, so by construction nobody has a term in it, so
//     `pending ∩ terms` was ALWAYS empty. The one bucket the caveat exists to
//     announce could never be announced.
//   - the PARTIAL bucket inverted. Of two members in a half-read parliament,
//     the one whose document we DID read kept it (they have the term) and the
//     one whose document is still unread lost it (they do not) — the warning
//     appeared against the member it did not apply to and vanished from the
//     member it did, and for a member with no read parliaments at all it
//     collapsed to "coverage for this member is not recorded".
//
// first_parliament/last_parliament are widened by LEAST/GREATEST across every
// document loaded for the person, so the range between them spans the
// parliaments they sat in whether or not the middle ones parsed: Dan Tehan's
// terms are {44,45,48} because the 46th and 47th failed to extract, but his
// range 44..48 correctly says those two half-read parliaments bear on him.
//
// A nil result means WE DO NOT KNOW when they served. Narrowing on a guess
// would publish a false coverage claim about a named person, so the caller
// keeps the corpus-wide buckets whole in that case: a superset is honest, an
// invented subset is not.
func parliamentRange(first, last int32) map[int32]bool {
	if first <= 0 || last < first {
		return nil
	}
	span := make(map[int32]bool, last-first+1)
	for parliament := first; parliament <= last; parliament++ {
		span[parliament] = true
	}
	return span
}

// loadMemberParliamentRange reads the member's served range from the
// politicians row — a column pair that is independent of whether any given
// parliament's documents extracted. See parliamentRange.
func (s *postgresStore) loadMemberParliamentRange(ctx context.Context, slug string) (map[int32]bool, error) {
	var first, last int32
	if err := s.db.QueryRow(ctx, `
		SELECT COALESCE(p.first_parliament, 0)::INTEGER,
		       COALESCE(p.last_parliament, 0)::INTEGER
		FROM politicians p
		WHERE p.slug = $1 AND p.merged_into_id IS NULL`, slug).Scan(&first, &last); err != nil {
		return nil, err
	}
	return parliamentRange(first, last), nil
}

// intersectParliaments narrows one corpus coverage bucket to a member's span,
// preserving the corpus ordering. A nil span means the span is unknown (see
// parliamentRange) and the bucket is returned whole.
func intersectParliaments(corpus []int32, span map[int32]bool) []int32 {
	if span == nil {
		return append([]int32(nil), corpus...)
	}
	var out []int32
	for _, parliament := range corpus {
		if span[parliament] {
			out = append(out, parliament)
		}
	}
	return out
}

type companyComparisonScanRow struct {
	StockCode          string
	CompanyName        string
	Industry           string
	HoldersA           []string
	HoldersB           []string
	CurrentlyDeclaredA bool
	CurrentlyDeclaredB bool
	PoliticianCount    int32
}

func (s *postgresStore) ComparePoliticians(slugA, slugB string) (*PoliticianComparisonRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	summaryA, _, err := s.loadPoliticianSummaryBySlug(ctx, slugA)
	if err != nil {
		return nil, err
	}
	summaryB, _, err := s.loadPoliticianSummaryBySlug(ctx, slugB)
	if err != nil {
		return nil, err
	}
	if err := s.loadSummaryTrends(ctx, []*PoliticianSummaryRow{summaryA, summaryB}, []string{slugA, slugB}, 12); err != nil {
		return nil, err
	}

	out := &PoliticianComparisonRow{SummaryA: summaryA, SummaryB: summaryB}
	out.HolderCountsA, err = s.loadHolderCounts(ctx, slugA)
	if err != nil {
		return nil, err
	}
	out.HolderCountsB, err = s.loadHolderCounts(ctx, slugB)
	if err != nil {
		return nil, err
	}

	rows, err := s.db.Query(ctx, `
		SELECT stock_code,
		       COALESCE(max(company_name), ''),
		       COALESCE(max(industry), ''),
		       COALESCE(array_agg(DISTINCT holder ORDER BY holder) FILTER (WHERE slug = $1), '{}'::TEXT[]),
		       COALESCE(array_agg(DISTINCT holder ORDER BY holder) FILTER (WHERE slug = $2), '{}'::TEXT[]),
		       COALESCE(bool_or(currently_declared) FILTER (WHERE slug = $1), false),
		       COALESCE(bool_or(currently_declared) FILTER (WHERE slug = $2), false),
		       count(DISTINCT slug)::INTEGER
		FROM mv_register_public_holdings
		WHERE stock_code IS NOT NULL AND slug IN ($1, $2)
		GROUP BY stock_code
		ORDER BY stock_code`, slugA, slugB)
	if err != nil {
		return nil, err
	}
	var onlyA, onlyB []*PoliticianOnlyCompanyRow
	for rows.Next() {
		var r companyComparisonScanRow
		if err := rows.Scan(&r.StockCode, &r.CompanyName, &r.Industry, &r.HoldersA, &r.HoldersB,
			&r.CurrentlyDeclaredA, &r.CurrentlyDeclaredB, &r.PoliticianCount); err != nil {
			rows.Close()
			return nil, err
		}
		switch r.PoliticianCount {
		case 2:
			out.SharedCompanies = append(out.SharedCompanies, &SharedDeclaredCompanyRow{
				StockCode: r.StockCode, CompanyName: r.CompanyName, Industry: r.Industry,
				HoldersA: r.HoldersA, HoldersB: r.HoldersB,
				CurrentlyDeclaredA: r.CurrentlyDeclaredA, CurrentlyDeclaredB: r.CurrentlyDeclaredB,
			})
		case 1:
			if len(r.HoldersA) > 0 {
				onlyA = append(onlyA, &PoliticianOnlyCompanyRow{
					StockCode: r.StockCode, CompanyName: r.CompanyName, Industry: r.Industry,
					Holders: r.HoldersA, CurrentlyDeclared: r.CurrentlyDeclaredA,
				})
			} else {
				onlyB = append(onlyB, &PoliticianOnlyCompanyRow{
					StockCode: r.StockCode, CompanyName: r.CompanyName, Industry: r.Industry,
					Holders: r.HoldersB, CurrentlyDeclared: r.CurrentlyDeclaredB,
				})
			}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	out.OnlyAMore = int32(maxInt(len(onlyA)-20, 0))
	out.OnlyBMore = int32(maxInt(len(onlyB)-20, 0))
	if len(onlyA) > 20 {
		onlyA = onlyA[:20]
	}
	if len(onlyB) > 20 {
		onlyB = onlyB[:20]
	}
	out.OnlyCompaniesA, out.OnlyCompaniesB = onlyA, onlyB

	// PER-SIDE coverage. The compare page's caveat exists to say "we have read
	// different parliaments for these two people, so the raw comparison is
	// misleading" — and a caveat that fills both sides from the same
	// corpus-wide buckets can never say that. Filling them identically made the
	// note decorative: the one fact it exists to carry was structurally
	// unable to appear.
	//
	// So each side's buckets are intersected with the parliaments THAT member
	// actually sat in. A member first elected at the 48th is not short-changed
	// by the 46th's partial extraction, and a member who served across 44-48
	// legitimately shows the partial ones.
	coverage := &PoliticianRow{}
	if err := s.loadCoverage(ctx, coverage); err != nil {
		return nil, err
	}
	spanA, err := s.loadMemberParliamentRange(ctx, slugA)
	if err != nil {
		return nil, err
	}
	spanB, err := s.loadMemberParliamentRange(ctx, slugB)
	if err != nil {
		return nil, err
	}
	out.ExtractedParliamentsA = intersectParliaments(coverage.ExtractedParliaments, spanA)
	out.PartialParliamentsA = intersectParliaments(coverage.PartialParliaments, spanA)
	out.PendingParliamentsA = intersectParliaments(coverage.PendingParliaments, spanA)
	out.ExtractedParliamentsB = intersectParliaments(coverage.ExtractedParliaments, spanB)
	out.PartialParliamentsB = intersectParliaments(coverage.PartialParliaments, spanB)
	out.PendingParliamentsB = intersectParliaments(coverage.PendingParliaments, spanB)
	out.AsAt, err = s.registerAsAt(ctx)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
