//go:build integration

package shorts

// Integration checks for the AEC funding read layer. Like the register suites
// beside it, these run against an EXISTING database and never start a
// container: what they smoke is the live ingested corpus, which is where every
// defect this layer can have actually lives.
//
// Each test measures its own expectation from the raw tables and then asserts
// the store agrees. A test that hard-codes a figure would only prove the figure
// was copied, not that the query means what it claims.

import (
	"context"
	"strings"
	"testing"
)

func openAECFundingDB(t *testing.T) (*postgresStore, func(), context.Context) {
	t.Helper()
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	ctx := context.Background()
	var present bool
	if err := pool.QueryRow(ctx,
		`SELECT to_regclass('mv_aec_party_funding') IS NOT NULL`).Scan(&present); err != nil {
		cleanup()
		t.Skipf("cannot inspect the aec schema: %v", err)
	}
	if !present {
		cleanup()
		t.Skip("migration 000105 is not applied in this database")
	}
	return &postgresStore{db: pool}, cleanup, ctx
}

// The overview's party rollups must reconcile to the raw returns they claim to
// summarise. mv_aec_party_funding is a materialised view, so a stale refresh
// would serve last month's totals under this month's as-at with nothing else
// noticing.
func TestDonationsOverviewPartyTotalsMatchTheRawReturns(t *testing.T) {
	store, cleanup, ctx := openAECFundingDB(t)
	defer cleanup()

	overview, err := store.GetDonationsOverview("", 100)
	if err != nil {
		t.Fatalf("GetDonationsOverview: %v", err)
	}
	if overview.FinancialYear == "" {
		t.Skip("no financial years in this corpus")
	}
	if len(overview.Parties) == 0 {
		t.Fatalf("financial year %q has no party rollups", overview.FinancialYear)
	}
	t.Logf("financial year %s: %d party groups, as at %s",
		overview.FinancialYear, len(overview.Parties), overview.AsAt.Format("2006-01-02T15:04:05Z07:00"))

	if overview.AsAt.IsZero() {
		t.Error("as_at is zero; every figure here needs the ingest snapshot to be citable")
	}

	for _, p := range overview.Parties {
		var returnCount int32
		var receipts, payments, debts int64
		if err := store.db.QueryRow(ctx, `
			SELECT count(*)::INTEGER,
			       COALESCE(sum(total_receipts_cents), 0),
			       COALESCE(sum(total_payments_cents), 0),
			       COALESCE(sum(total_debts_cents), 0)
			FROM aec_party_returns
			WHERE financial_year = $1 AND party_group_key = $2`,
			overview.FinancialYear, p.PartyGroup).
			Scan(&returnCount, &receipts, &payments, &debts); err != nil {
			t.Fatalf("raw totals for %s: %v", p.PartyGroup, err)
		}
		if p.PartyReturnCount != returnCount || p.TotalReceiptsCents != receipts ||
			p.TotalPaymentsCents != payments || p.TotalDebtsCents != debts {
			t.Errorf("%s rollup = (returns %d, receipts %d, payments %d, debts %d), raw = (%d, %d, %d, %d) — the MV is stale",
				p.PartyGroup, p.PartyReturnCount, p.TotalReceiptsCents, p.TotalPaymentsCents, p.TotalDebtsCents,
				returnCount, receipts, payments, debts)
		}
		// Every old-scheme row is right-censored, and that has to be readable
		// from the data rather than assumed by the surface.
		if p.FinancialYearEnd < 2027 && !p.ThresholdCensored {
			t.Errorf("%s %s is not marked threshold_censored", p.PartyGroup, p.FinancialYear)
		}
		if (p.FinancialYearEnd >= 2027) != p.PostReformScheme {
			t.Errorf("%s %s post_reform_scheme = %v for FY ending %d",
				p.PartyGroup, p.FinancialYear, p.PostReformScheme, p.FinancialYearEnd)
		}
	}

	// Ordering is by an amount the AEC published, descending, and nothing else.
	for i := 1; i < len(overview.Parties); i++ {
		if overview.Parties[i-1].TotalReceiptsCents < overview.Parties[i].TotalReceiptsCents {
			t.Fatalf("party rollups are not ordered by declared receipts descending at index %d", i)
		}
	}

	c := overview.Corpus
	if c == nil {
		t.Fatal("corpus counts are required: a surface must be able to state its own boundaries")
	}
	t.Logf("corpus: party_returns=%d receipts=%d donations_made=%d mp_returns=%d (%d resolved) candidate_returns=%d (%d resolved, %d nil) candidate_donations=%d matched_payer_names=%d FY%d-FY%d",
		c.PartyReturnCount, c.ReceiptCount, c.DonationMadeCount,
		c.MPReturnCount, c.MPReturnResolvedCount,
		c.CandidateReturnCount, c.CandidateReturnResolvedCount, c.NilCandidateReturnCount,
		c.CandidateDonationCount, c.MatchedPayerNameCount,
		c.FirstFinancialYearEnd, c.LastFinancialYearEnd)
	if c.MPReturnResolvedCount > c.MPReturnCount || c.CandidateReturnResolvedCount > c.CandidateReturnCount {
		t.Error("more returns resolved than exist")
	}
}

// The matched-payer counters must describe THE CORPUS, not the layer the corpus
// was matched against. The first cut published the substrate — every listed
// company whose name could conceivably be matched — as a matched count, which
// read an order of magnitude high and would have been rendered as "N listed
// companies appear in the data".
func TestDonationsCorpusPublishesMatchedPayersNotTheMatchSubstrate(t *testing.T) {
	store, cleanup, ctx := openAECFundingDB(t)
	defer cleanup()

	overview, err := store.GetDonationsOverview("", 25)
	if err != nil {
		t.Fatalf("GetDonationsOverview: %v", err)
	}
	c := overview.Corpus
	if c == nil {
		t.Fatal("corpus counts are required")
	}

	// Measured from the raw tables, not copied from the store.
	var names, codes, substrate int32
	if err := store.db.QueryRow(ctx, `
		SELECT
			(SELECT count(*)::INTEGER FROM (
				SELECT m.name_norm FROM aec_receipts r
				JOIN v_aec_company_name_matches m ON m.name_norm = r.received_from_norm
				UNION
				SELECT m.name_norm FROM aec_donations_made d
				JOIN v_aec_company_name_matches m ON m.name_norm = d.donor_name_norm) n),
			(SELECT count(*)::INTEGER FROM (
				SELECT m.stock_code FROM aec_receipts r
				JOIN v_aec_company_name_matches m ON m.name_norm = r.received_from_norm
				UNION
				SELECT m.stock_code FROM aec_donations_made d
				JOIN v_aec_company_name_matches m ON m.name_norm = d.donor_name_norm) s),
			(SELECT count(DISTINCT stock_code)::INTEGER FROM v_aec_company_name_matches)`).
		Scan(&names, &codes, &substrate); err != nil {
		t.Fatalf("measure matched payers: %v", err)
	}
	t.Logf("matched payer names=%d codes=%d against a substrate of %d company names",
		names, codes, substrate)

	if c.MatchedPayerNameCount != names {
		t.Errorf("matched_payer_name_count = %d, corpus holds %d", c.MatchedPayerNameCount, names)
	}
	if c.MatchedPayerCodeCount != codes {
		t.Errorf("matched_payer_code_count = %d, corpus holds %d", c.MatchedPayerCodeCount, codes)
	}
	if c.MatchableCompanyNameCount != substrate {
		t.Errorf("matchable_company_name_count = %d, the match layer holds %d",
			c.MatchableCompanyNameCount, substrate)
	}
	// The property that made the old field a lie: the substrate is much larger
	// than anything the corpus matched, so publishing it as a matched count
	// overstates the company presence in the data.
	if names > 0 && c.MatchedPayerNameCount == c.MatchableCompanyNameCount {
		t.Error("the matched count equals the substrate; one of them is not measuring what it says")
	}
}

// listed_group_count must be a property of the YEAR, not of the page. The
// explorer renders a top-N of party groups and tells a reader how many groups
// with listed payers it did not show; computing that from the page would report
// zero for the Australian Democrats, who rank 38th on receipts and had ten.
func TestFinancialYearOptionsCountListedGroupsOverTheWholeYear(t *testing.T) {
	store, cleanup, ctx := openAECFundingDB(t)
	defer cleanup()

	// A deliberately tiny page: the year counts must not move with it.
	overview, err := store.GetDonationsOverview("", 1)
	if err != nil {
		t.Fatalf("GetDonationsOverview: %v", err)
	}
	if len(overview.AvailableYears) == 0 {
		t.Skip("no financial years in this corpus")
	}
	for _, y := range overview.AvailableYears {
		var groups, listed int32
		if err := store.db.QueryRow(ctx, `
			SELECT count(*)::INTEGER, count(*) FILTER (WHERE listed_payer_count > 0)::INTEGER
			FROM mv_aec_party_funding WHERE financial_year = $1`, y.FinancialYear).
			Scan(&groups, &listed); err != nil {
			t.Fatalf("measure %s: %v", y.FinancialYear, err)
		}
		if y.PartyGroupCount != groups {
			t.Errorf("%s party_group_count = %d, year holds %d", y.FinancialYear, y.PartyGroupCount, groups)
		}
		if y.ListedGroupCount != listed {
			t.Errorf("%s listed_group_count = %d, year holds %d", y.FinancialYear, y.ListedGroupCount, listed)
		}
		if y.ListedGroupCount > y.PartyGroupCount {
			t.Errorf("%s counts more groups with listed payers than groups", y.FinancialYear)
		}
	}
}

// The rollup's caption must come from the rollup's own clock. If as_at were read
// from the base tables, a failed refresh would put a fresh timestamp on the
// figures of the snapshot the load replaced.
func TestDonationsOverviewAsAtComesFromTheLastSuccessfulRefresh(t *testing.T) {
	store, cleanup, ctx := openAECFundingDB(t)
	defer cleanup()

	var logged *string
	if err := store.db.QueryRow(ctx, `
		SELECT to_char(corpus_snapshot_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF')
		FROM aec_refresh_log WHERE succeeded ORDER BY refreshed_at DESC LIMIT 1`).Scan(&logged); err != nil {
		t.Skipf("no successful refresh recorded in this database: %v", err)
	}
	overview, err := store.GetDonationsOverview("", 1)
	if err != nil {
		t.Fatalf("GetDonationsOverview: %v", err)
	}
	if logged == nil {
		if !overview.AsAt.IsZero() {
			t.Error("as_at is set from a refresh that recorded no corpus snapshot")
		}
		return
	}
	var matches bool
	if err := store.db.QueryRow(ctx, `
		SELECT (SELECT corpus_snapshot_at FROM aec_refresh_log
		        WHERE succeeded ORDER BY refreshed_at DESC LIMIT 1) = $1::timestamptz`,
		overview.AsAt).Scan(&matches); err != nil {
		t.Fatalf("compare as_at: %v", err)
	}
	if !matches {
		t.Errorf("as_at %s is not the snapshot the rollup was last rebuilt from (%s)",
			overview.AsAt, *logged)
	}
}

// A payer's receipt-type split must sum to their total. The source distinguishes
// a donation from an other receipt, a subscription and public funding, and that
// distinction has to survive to the UI — a conference fee is not a donation. If
// the buckets did not sum, a surface rendering "of which donations" would be
// captioning a number that is not the one beside it.
func TestTopDonorsReceiptTypeSplitSumsToTotal(t *testing.T) {
	store, cleanup, _ := openAECFundingDB(t)
	defer cleanup()

	donors, err := store.ListTopDonors("", "", 200, 0)
	if err != nil {
		t.Fatalf("ListTopDonors: %v", err)
	}
	if len(donors.Donors) == 0 {
		t.Skip("no itemised receipts into party branches in this corpus")
	}
	t.Logf("financial year %s: %d distinct payers, page of %d",
		donors.FinancialYear, donors.Total, len(donors.Donors))

	for _, d := range donors.Donors {
		sum := d.DonationCents + d.OtherReceiptCents + d.SubscriptionCents +
			d.PublicFundingCents + d.UnspecifiedCents
		if sum != d.TotalCents {
			t.Errorf("%s split sums to %d, total is %d — a receipt type is being dropped",
				d.DonorName, sum, d.TotalCents)
		}
		var recipientSum int64
		for _, r := range d.Recipients {
			recipientSum += r.AmountCents
		}
		if len(d.Recipients) == 0 {
			t.Errorf("%s has no recipient party group; this list is scoped to party recipients", d.DonorName)
		}
		if recipientSum != d.TotalCents {
			t.Errorf("%s recipient split sums to %d, total is %d", d.DonorName, recipientSum, d.TotalCents)
		}
		if d.DonorNameNorm == "" {
			t.Errorf("%s has no normalised key; the grouping must be inspectable", d.DonorName)
		}
		// A match is exact or curated, never fuzzy. Anything else means the
		// view has grown a match method nobody vetted.
		if d.MatchMethod != "" && d.MatchMethod != "name_exact" && d.MatchMethod != "curated_alias" {
			t.Errorf("%s carries match method %q, want exact or curated only", d.DonorName, d.MatchMethod)
		}
		if (d.StockCode == "") != (d.MatchMethod == "") {
			t.Errorf("%s has stock_code=%q with match=%q; a code without a method is an unaudited join",
				d.DonorName, d.StockCode, d.MatchMethod)
		}
	}

	// Ordering is by the declared amount, descending.
	for i := 1; i < len(donors.Donors); i++ {
		if donors.Donors[i-1].TotalCents < donors.Donors[i].TotalCents {
			t.Fatalf("payers are not ordered by declared amount descending at index %d", i)
		}
	}
}

// The payer list and the party rollup are the same join at two groupings, so a
// party group's payer totals must sum to its itemised_receipts_cents and its
// payer count must equal distinct_payer_count. If they diverge, one of the two
// surfaces on the funding page is quietly describing a different population.
func TestTopDonorsReconcileToThePartyRollup(t *testing.T) {
	store, cleanup, ctx := openAECFundingDB(t)
	defer cleanup()

	// The largest party group of the latest year — measured, not pinned, so the
	// test survives a re-ingest.
	var fy, group string
	if err := store.db.QueryRow(ctx, `
		SELECT financial_year, party_group_key
		FROM mv_aec_party_funding
		WHERE itemised_receipt_count > 0
		ORDER BY financial_year_end DESC, itemised_receipts_cents DESC
		LIMIT 1`).Scan(&fy, &group); err != nil {
		t.Skipf("no party group with itemised receipts: %v", err)
	}
	t.Logf("reconciling %s for %s", group, fy)

	var rollupCents int64
	var rollupPayers int32
	if err := store.db.QueryRow(ctx, `
		SELECT itemised_receipts_cents, distinct_payer_count
		FROM mv_aec_party_funding
		WHERE financial_year = $1 AND party_group_key = $2`, fy, group).
		Scan(&rollupCents, &rollupPayers); err != nil {
		t.Fatalf("rollup for %s %s: %v", group, fy, err)
	}

	// Every payer, not a page: the reconciliation has to be over the whole
	// population or it proves nothing about the total.
	page, err := store.ListTopDonors(fy, group, 200, 0)
	if err != nil {
		t.Fatalf("ListTopDonors: %v", err)
	}
	if page.Total != rollupPayers {
		t.Errorf("payer total = %d, rollup distinct_payer_count = %d", page.Total, rollupPayers)
	}

	var summed int64
	var seen int32
	for offset := int32(0); offset < page.Total; offset += 200 {
		batch, err := store.ListTopDonors(fy, group, 200, offset)
		if err != nil {
			t.Fatalf("ListTopDonors(offset=%d): %v", offset, err)
		}
		if len(batch.Donors) == 0 {
			break
		}
		for _, d := range batch.Donors {
			summed += d.TotalCents
			seen++
		}
	}
	if seen != rollupPayers {
		t.Errorf("paged through %d payers, rollup says %d", seen, rollupPayers)
	}
	if summed != rollupCents {
		t.Errorf("payer totals sum to %d, rollup itemised_receipts_cents = %d", summed, rollupCents)
	}
	t.Logf("%s %s: %d payers summing to %d cents, reconciled", group, fy, seen, summed)
}

// A party's series must be its own years only, ascending, with the focus year
// constrained to a year the party actually lodged in — falling back to the
// corpus-wide latest would draw an empty donor list under a year the party has
// no return for.
func TestListPartyFundingSeriesAndFocusYear(t *testing.T) {
	store, cleanup, ctx := openAECFundingDB(t)
	defer cleanup()

	var group string
	if err := store.db.QueryRow(ctx, `
		SELECT party_group_key FROM mv_aec_party_funding
		GROUP BY party_group_key
		ORDER BY count(*) DESC, party_group_key
		LIMIT 1`).Scan(&group); err != nil {
		t.Skipf("no party groups: %v", err)
	}

	detail, err := store.ListPartyFunding(group, "", 25)
	if err != nil {
		t.Fatalf("ListPartyFunding(%q): %v", group, err)
	}
	if len(detail.Series) == 0 {
		t.Fatalf("%s has no series", group)
	}
	t.Logf("%s: %d financial years, %d branch names, focus %s",
		group, len(detail.Series), len(detail.BranchNames), detail.FinancialYear)

	for i, r := range detail.Series {
		if r.PartyGroup != group {
			t.Fatalf("series row %d belongs to %q, not %q", i, r.PartyGroup, group)
		}
		if i > 0 && detail.Series[i-1].FinancialYearEnd > r.FinancialYearEnd {
			t.Fatalf("series is not ascending by financial year at index %d", i)
		}
	}
	// The focus year must be one of this party's own years.
	focusFound := false
	for _, r := range detail.Series {
		if r.FinancialYear == detail.FinancialYear {
			focusFound = true
		}
	}
	if !focusFound {
		t.Errorf("focus year %q is not one of %s's lodged years", detail.FinancialYear, group)
	}

	// An unknown requested year falls back to this party's latest, not to the
	// corpus-wide latest.
	fallback, err := store.ListPartyFunding(group, "1066-67", 25)
	if err != nil {
		t.Fatalf("ListPartyFunding with an unknown year: %v", err)
	}
	if fallback.FinancialYear != detail.Series[len(detail.Series)-1].FinancialYear {
		t.Errorf("unknown year fell back to %q, want %s's latest %q",
			fallback.FinancialYear, group, detail.Series[len(detail.Series)-1].FinancialYear)
	}

	// Listed-company payers are a strict subset of the payer list, and every
	// one of them carries a code.
	for _, p := range detail.ListedCompanyPayers {
		if p.StockCode == "" {
			t.Errorf("listed payer %q has no stock code", p.DonorName)
		}
	}
	// The branch names are the rollup's own members, published so the grouping
	// is inspectable rather than asserted.
	if len(detail.BranchNames) == 0 {
		t.Errorf("%s has no branch names", group)
	}
}

// A resolved member's funding must be their OWN returns and nothing else: the
// join is on the resolved politician_id, so every row must carry the member's
// own surname and the corpus-wide coverage that keeps an empty gift list from
// reading as "received nothing".
func TestGetPoliticianFundingServesOnlyTheMembersOwnReturns(t *testing.T) {
	store, cleanup, ctx := openAECFundingDB(t)
	defer cleanup()

	// A member with both kinds of return, discovered rather than pinned.
	var slug, surname string
	if err := store.db.QueryRow(ctx, `
		SELECT p.slug, upper(p.surname)
		FROM politicians p
		WHERE p.merged_into_id IS NULL
		  AND EXISTS (SELECT 1 FROM aec_mp_returns m WHERE m.politician_id = p.id)
		  AND EXISTS (SELECT 1 FROM aec_candidate_returns r WHERE r.politician_id = p.id)
		ORDER BY p.slug
		LIMIT 1`).Scan(&slug, &surname); err != nil {
		t.Skipf("no member has both an annual and a candidate return: %v", err)
	}

	funding, err := store.GetPoliticianFunding(slug)
	if err != nil {
		t.Fatalf("GetPoliticianFunding(%q): %v", slug, err)
	}
	if funding.CanonicalSlug != slug {
		t.Errorf("canonical slug = %q, want the stored %q", funding.CanonicalSlug, slug)
	}
	if funding.AsAt.IsZero() {
		t.Error("as_at is zero; a member's funding figures need the ingest snapshot")
	}
	t.Logf("%s: %d annual returns, %d candidate returns",
		slug, len(funding.AnnualReturns), len(funding.CandidateReturns))

	for _, r := range funding.AnnualReturns {
		if !strings.Contains(strings.ToUpper(r.MemberName), surname) {
			t.Errorf("annual return %q does not name %s", r.MemberName, surname)
		}
		if r.SourceURL == "" {
			t.Errorf("annual return %s has no source url", r.FinancialYear)
		}
	}
	for _, r := range funding.CandidateReturns {
		if !strings.Contains(strings.ToUpper(r.CandidateName), surname) {
			t.Errorf("candidate return %q does not name %s", r.CandidateName, surname)
		}
		if r.EventReturnCount <= 0 {
			t.Errorf("%s carries no event coverage; an empty gift list would read as a claim", r.Event)
		}
		if r.EventItemisedReturnCount > r.EventReturnCount {
			t.Errorf("%s coverage = %d of %d", r.Event, r.EventItemisedReturnCount, r.EventReturnCount)
		}
		// The itemised gifts must reconcile to the return they hang off.
		var rawCount int
		if err := store.db.QueryRow(ctx, `
			SELECT count(*) FROM aec_candidate_donations d
			JOIN aec_candidate_returns cr ON cr.id = d.candidate_return_id
			JOIN politicians p ON p.id = cr.politician_id
			WHERE p.slug = $1 AND cr.event = $2 AND cr.return_type = $3
			  AND cr.electorate_name = $4`,
			slug, r.Event, r.ReturnType, r.ElectorateName).Scan(&rawCount); err != nil {
			t.Fatalf("raw donation count: %v", err)
		}
		if len(r.Donations) != rawCount {
			t.Errorf("%s %s carries %d itemised gifts, raw has %d",
				slug, r.Event, len(r.Donations), rawCount)
		}
	}
}

// THE ATTRIBUTION-HONESTY TEST. Every unresolved return — which is every
// Senator return, because the politicians table is House-only, plus any name
// the resolver would not commit to — must be reachable from NO member response.
//
// It is asserted over the whole corpus rather than one example: a single leaked
// name would attribute one person's declared funding to another, which is the
// exact failure the withhold-rather-than-guess rule exists to prevent.
func TestUnresolvedReturnsAppearInNoMemberResponse(t *testing.T) {
	store, cleanup, ctx := openAECFundingDB(t)
	defer cleanup()

	// The WITHHELD names: names the resolver never committed to anyone, anywhere
	// in the corpus.
	//
	// The "anywhere" matters. Resolution is per-return, not per-person: Adam
	// Bandt's 2022 Melbourne return resolves and his 2025 one does not, because
	// he did not hold the division in the parliament the 2025 event elected. A
	// name-only set would therefore flag his own resolved return as a leak. What
	// must never appear is a name that resolved to NOBODY — that is the set the
	// withhold-rather-than-guess rule protects.
	unresolvedRows, err := store.db.Query(ctx, `
		SELECT member_name FROM aec_mp_returns m
		WHERE m.politician_id IS NULL
		  AND NOT EXISTS (SELECT 1 FROM aec_mp_returns r2
		                  WHERE r2.member_name = m.member_name AND r2.politician_id IS NOT NULL)
		UNION
		SELECT candidate_name FROM aec_candidate_returns c
		WHERE c.politician_id IS NULL
		  AND NOT EXISTS (SELECT 1 FROM aec_candidate_returns r2
		                  WHERE r2.candidate_name = c.candidate_name AND r2.politician_id IS NOT NULL)`)
	if err != nil {
		t.Fatalf("unresolved names: %v", err)
	}
	unresolved := map[string]bool{}
	for unresolvedRows.Next() {
		var name string
		if err := unresolvedRows.Scan(&name); err != nil {
			unresolvedRows.Close()
			t.Fatalf("scan unresolved name: %v", err)
		}
		unresolved[name] = true
	}
	unresolvedRows.Close()
	if err := unresolvedRows.Err(); err != nil {
		t.Fatalf("unresolved names: %v", err)
	}
	if len(unresolved) == 0 {
		t.Skip("every return resolved; nothing to withhold")
	}

	var senateUnresolved, senateTotal int
	if err := store.db.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE politician_id IS NULL), count(*)
		FROM aec_mp_returns WHERE chamber = 'senate'`).Scan(&senateUnresolved, &senateTotal); err != nil {
		t.Fatalf("senate counts: %v", err)
	}
	t.Logf("%d distinct unresolved names; %d of %d senator returns are unresolved by design (the politicians table is House-only)",
		len(unresolved), senateUnresolved, senateTotal)
	if senateTotal > 0 && senateUnresolved != senateTotal {
		t.Errorf("%d of %d senator returns resolved to a member; the politicians table is House-only, so any of these is a mis-join",
			senateTotal-senateUnresolved, senateTotal)
	}

	// Every member who has ANY funding row. If an unresolved name surfaced on
	// one of them, this is where it would show.
	slugRows, err := store.db.Query(ctx, `
		SELECT DISTINCT p.slug FROM politicians p
		WHERE p.merged_into_id IS NULL
		  AND (EXISTS (SELECT 1 FROM aec_mp_returns m WHERE m.politician_id = p.id)
		    OR EXISTS (SELECT 1 FROM aec_candidate_returns r WHERE r.politician_id = p.id))
		ORDER BY p.slug`)
	if err != nil {
		t.Fatalf("funded members: %v", err)
	}
	slugs := []string{}
	for slugRows.Next() {
		var slug string
		if err := slugRows.Scan(&slug); err != nil {
			slugRows.Close()
			t.Fatalf("scan slug: %v", err)
		}
		slugs = append(slugs, slug)
	}
	slugRows.Close()
	if err := slugRows.Err(); err != nil {
		t.Fatalf("funded members: %v", err)
	}
	t.Logf("checking %d members with funding rows against %d withheld names", len(slugs), len(unresolved))

	for _, slug := range slugs {
		funding, err := store.GetPoliticianFunding(slug)
		if err != nil {
			t.Fatalf("GetPoliticianFunding(%q): %v", slug, err)
		}
		for _, r := range funding.AnnualReturns {
			if unresolved[r.MemberName] {
				t.Errorf("%s serves the WITHHELD annual return %q", slug, r.MemberName)
			}
		}
		for _, r := range funding.CandidateReturns {
			if unresolved[r.CandidateName] {
				t.Errorf("%s serves the WITHHELD candidate return %q", slug, r.CandidateName)
			}
			// Stronger than the name check and independent of it: the exact row
			// served must be one the resolver bound to THIS member. A row
			// reached by any other path is a mis-attribution regardless of
			// whether its name appears elsewhere.
			var boundHere bool
			if err := store.db.QueryRow(ctx, `
				SELECT EXISTS (
				    SELECT 1 FROM aec_candidate_returns cr
				    JOIN politicians p ON p.id = cr.politician_id
				    WHERE p.slug = $1 AND cr.event = $2 AND cr.return_type = $3
				      AND cr.candidate_name = $4 AND cr.electorate_name = $5
				)`, slug, r.Event, r.ReturnType, r.CandidateName, r.ElectorateName).
				Scan(&boundHere); err != nil {
				t.Fatalf("verify binding for %s: %v", slug, err)
			}
			if !boundHere {
				t.Errorf("%s serves %q / %q which is not bound to them by politician_id",
					slug, r.Event, r.CandidateName)
			}
		}
	}
}

// A member with no funding returns gets an EMPTY response, not a 404 and not an
// error: they exist, and the absence of a return is not evidence that they
// received nothing. A retired or unknown slug still 404s.
func TestGetPoliticianFundingEmptyForUnfundedAndMissingMembers(t *testing.T) {
	store, cleanup, ctx := openAECFundingDB(t)
	defer cleanup()

	var slug string
	if err := store.db.QueryRow(ctx, `
		SELECT p.slug FROM politicians p
		WHERE p.merged_into_id IS NULL
		  AND NOT EXISTS (SELECT 1 FROM aec_mp_returns m WHERE m.politician_id = p.id)
		  AND NOT EXISTS (SELECT 1 FROM aec_candidate_returns r WHERE r.politician_id = p.id)
		ORDER BY p.slug LIMIT 1`).Scan(&slug); err != nil {
		t.Skipf("every member has a funding return: %v", err)
	}

	funding, err := store.GetPoliticianFunding(slug)
	if err != nil {
		t.Fatalf("GetPoliticianFunding(%q) on an unfunded member: %v", slug, err)
	}
	if len(funding.AnnualReturns) != 0 || len(funding.CandidateReturns) != 0 {
		t.Errorf("%s has no funding rows but the store returned some", slug)
	}
	if funding.CanonicalSlug != slug {
		t.Errorf("canonical slug = %q, want %q", funding.CanonicalSlug, slug)
	}

	if _, err := store.GetPoliticianFunding("definitely-not-a-member-000105"); err == nil {
		t.Error("an unknown slug must error (the handler maps it to NotFound), not return empty")
	}
}

// A named end-to-end check against the live corpus: the crossbencher whose
// funding is the most-cited example of what this layer exists to publish.
//
// It is pinned by SLUG, which is minted once and never reassigned, and skips
// rather than fails if the member is absent — a re-extraction that drops a
// person is a different problem than this test's.
func TestMoniqueRyanFundingResolves(t *testing.T) {
	store, cleanup, ctx := openAECFundingDB(t)
	defer cleanup()

	var exists bool
	if err := store.db.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM politicians WHERE slug = 'monique-ryan' AND merged_into_id IS NULL)`).
		Scan(&exists); err != nil {
		t.Fatalf("look up monique-ryan: %v", err)
	}
	if !exists {
		t.Skip("monique-ryan is not in this corpus")
	}

	funding, err := store.GetPoliticianFunding("monique-ryan")
	if err != nil {
		t.Fatalf("GetPoliticianFunding(monique-ryan): %v", err)
	}
	if len(funding.AnnualReturns) == 0 {
		t.Error("monique-ryan has no annual member returns; she is one of the ~16 members who lodge them")
	}
	if len(funding.CandidateReturns) == 0 {
		t.Error("monique-ryan has no candidate election returns")
	}
	for _, r := range funding.AnnualReturns {
		t.Logf("annual %s: %s, %d cents from %d donors",
			r.FinancialYear, r.MemberName, r.TotalDonationsCents, r.DonorCount)
		if r.Chamber != "house" {
			t.Errorf("annual return chamber = %q, want house", r.Chamber)
		}
	}
	for _, r := range funding.CandidateReturns {
		t.Logf("candidate %s (%s): nil=%v, %d cents from %d donors, %d itemised, event coverage %d/%d",
			r.Event, r.ElectorateName, r.NilReturn, r.TotalGiftCents, r.DonorCount,
			len(r.Donations), r.EventItemisedReturnCount, r.EventReturnCount)
		if r.ElectorateName == "" {
			t.Error("candidate return carries no electorate")
		}
	}
}
