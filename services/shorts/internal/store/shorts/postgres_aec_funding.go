package shorts

// Read models for the AEC funding layer (migration 000105,
// docs/feature/politicians/donations.md).
//
// This file is the ONLY read path over the aec_* tables, and four properties
// hold for every query in it:
//
//  1. AMOUNTS ARE INTEGER CENTS, verbatim as lodged. Nothing here divides,
//     ratios, indexes or scores. The only ordering is by an amount the source
//     itself published, because any derived measure would be ours rather than
//     the AEC's and could not be cited to them.
//  2. NO FUZZY JOIN. Donor→company goes through v_aec_company_name_matches
//     (curated alias, else exact normalised name, ambiguous names excluded
//     entirely); branch→party group goes through v_aec_party_group_names, which
//     is the source's own Party Group column. Neither is ever LIKE-matched.
//  3. THE MEMBER LAYER ONLY EVER SERVES ROWS THAT NAME THE MEMBER, joined on
//     politician_id — the resolved FK, never a name. Party money never reaches
//     GetPoliticianFunding, and an unresolved return (every Senator return, and
//     any ambiguous name) is reachable from no member response at all.
//  4. as_at IS THE INGEST SNAPSHOT. The AEC regenerates the bulk zips
//     continuously as amendments land, so a published financial year is never
//     frozen and no other clock can honestly caption these figures.

import (
	"context"
	"strings"
	"time"
)

// AEC vocabulary. The receipt-type buckets are exhaustive over the source's own
// values ('Donation Received', 'Other Receipt', 'Subscription', 'Public
// Funding', 'Unspecified' and blank), which is what lets the split be proved to
// sum to the total instead of quietly dropping a bucket nobody thought of.
const (
	receiptTypeDonation     = "Donation Received"
	receiptTypeOther        = "Other Receipt"
	receiptTypeSubscription = "Subscription"
	receiptTypePublicFund   = "Public Funding"
)

// PartyFundingRow is one party group in one financial year, straight from
// mv_aec_party_funding. Every field is a sum or a distinct count over lodged
// returns; none is derived from another.
type PartyFundingRow struct {
	PartyGroup       string
	FinancialYear    string
	FinancialYearEnd int32
	PartyReturnCount int32

	TotalReceiptsCents int64
	TotalPaymentsCents int64
	TotalDebtsCents    int64

	ItemisedReceiptCount  int32
	ItemisedReceiptsCents int64
	DistinctPayerCount    int32
	ListedPayerCount      int32
	ListedPayerCents      int64

	DonationCount          int32
	DeclaredDonationsCents int64
	DistinctDonorCount     int32
	ListedDonorCount       int32
	ListedDonorCents       int64

	ThresholdCensored bool
	PostReformScheme  bool
}

// FinancialYearOptionRow is one selectable year and how many party groups it holds.
type FinancialYearOptionRow struct {
	FinancialYear    string
	FinancialYearEnd int32
	PartyGroupCount  int32
}

// DonationsCorpusRow is what the corpus actually contains. It exists so a
// surface can state its own boundaries: the member layer is thin, and a page
// that renders it without its coverage lies by construction.
type DonationsCorpusRow struct {
	PartyReturnCount             int32
	ReceiptCount                 int32
	DonationMadeCount            int32
	MPReturnCount                int32
	MPReturnResolvedCount        int32
	CandidateReturnCount         int32
	CandidateReturnResolvedCount int32
	NilCandidateReturnCount      int32
	CandidateDonationCount       int32
	FirstFinancialYearEnd        int32
	LastFinancialYearEnd         int32
	ListedCompanyMatchCount      int32
}

// DonationsOverviewRow is the funding explorer's landing payload.
type DonationsOverviewRow struct {
	FinancialYear  string
	Parties        []*PartyFundingRow
	AvailableYears []*FinancialYearOptionRow
	Corpus         *DonationsCorpusRow
	AsAt           time.Time
}

// DonorRecipientRow is what one payer paid into one party group.
type DonorRecipientRow struct {
	PartyGroup  string
	AmountCents int64
}

// TopDonorRow is one payer's itemised receipts for one financial year.
//
// DonorName is VERBATIM as lodged and DonorNameNorm is the key the spellings
// were grouped by — both are published so a reader can see exactly what was
// combined rather than trusting that it was combined correctly.
type TopDonorRow struct {
	DonorName     string
	DonorNameNorm string
	TotalCents    int64
	ReceiptCount  int32

	DonationCents      int64
	OtherReceiptCents  int64
	SubscriptionCents  int64
	PublicFundingCents int64
	UnspecifiedCents   int64

	Recipients []*DonorRecipientRow

	// Set only by v_aec_company_name_matches: curated alias, else exact
	// normalised name. Empty means "not matched", never "not listed".
	StockCode   string
	CompanyName string
	MatchMethod string
}

// TopDonorsRow is one page of payers plus the real population size.
type TopDonorsRow struct {
	FinancialYear string
	PartyGroup    string
	Donors        []*TopDonorRow
	Total         int32
	AsAt          time.Time
}

// PartyFundingDetailRow is one party group's whole funding history plus the
// focus year's payer lists.
type PartyFundingDetailRow struct {
	PartyGroup          string
	Series              []*PartyFundingRow
	FinancialYear       string
	TopDonors           []*TopDonorRow
	ListedCompanyPayers []*TopDonorRow
	BranchNames         []string
	AsAt                time.Time
}

// MemberAnnualReturnRow is one lodged member/senator annual return.
type MemberAnnualReturnRow struct {
	FinancialYear       string
	FinancialYearEnd    int32
	ReturnType          string
	Chamber             string
	MemberName          string
	TotalDonationsCents int64
	DonorCount          int32
	SourceURL           string
}

// CandidateDonationRow is one itemised gift named in a candidate return.
type CandidateDonationRow struct {
	DonorName    string
	DonationDate string // YYYY-MM-DD; empty when the return omits it
	AmountCents  int64
}

// CandidateElectionReturnRow is one election return lodged by the member as a
// candidate. NilReturn true is a lodged declaration of no gifts — a publishable
// fact, not an absence.
type CandidateElectionReturnRow struct {
	Event              string
	EventYear          int32
	ReturnType         string
	CandidateName      string
	PartyName          string
	ElectorateName     string
	ElectorateState    string
	NilReturn          bool
	AmendmentNo        int32
	TotalGiftCents     int64
	DonorCount         int32
	ExpenditureCents   int64
	DiscretionaryCents int64
	Donations          []*CandidateDonationRow
	// Corpus-wide coverage for this event, carried ON the row it caveats so an
	// empty Donations list can never be read as "received nothing".
	EventReturnCount         int32
	EventItemisedReturnCount int32
	SourceURL                string
}

// PoliticianFundingRow is one member's funding returns. Nothing in it is a
// party figure.
type PoliticianFundingRow struct {
	CanonicalSlug    string
	AnnualReturns    []*MemberAnnualReturnRow
	CandidateReturns []*CandidateElectionReturnRow
	AsAt             time.Time
}

// partyFundingColumns is the single SELECT list over mv_aec_party_funding, so
// the overview and the per-party series can never disagree about a figure.
const partyFundingColumns = `
	party_group_key, financial_year, financial_year_end, party_return_count,
	total_receipts_cents, total_payments_cents, total_debts_cents,
	itemised_receipt_count, itemised_receipts_cents, distinct_payer_count,
	listed_payer_count, listed_payer_cents,
	donation_count, donations_cents, distinct_donor_count,
	listed_donor_count, listed_donor_cents,
	threshold_censored, post_reform_scheme`

func scanPartyFunding(scan func(dest ...any) error) (*PartyFundingRow, error) {
	var r PartyFundingRow
	if err := scan(
		&r.PartyGroup, &r.FinancialYear, &r.FinancialYearEnd, &r.PartyReturnCount,
		&r.TotalReceiptsCents, &r.TotalPaymentsCents, &r.TotalDebtsCents,
		&r.ItemisedReceiptCount, &r.ItemisedReceiptsCents, &r.DistinctPayerCount,
		&r.ListedPayerCount, &r.ListedPayerCents,
		&r.DonationCount, &r.DeclaredDonationsCents, &r.DistinctDonorCount,
		&r.ListedDonorCount, &r.ListedDonorCents,
		&r.ThresholdCensored, &r.PostReformScheme,
	); err != nil {
		return nil, err
	}
	return &r, nil
}

// aecSnapshotAt is the ingest clock, taken from the party returns table because
// the whole corpus is snapshot-replaced in ONE transaction — any of the tables
// would give the same instant, and using one of them consistently means two
// responses of one page can never disagree about when the data was taken.
func (s *postgresStore) aecSnapshotAt(ctx context.Context) (time.Time, error) {
	var at *time.Time
	if err := s.db.QueryRow(ctx, `SELECT max(snapshot_at) FROM aec_party_returns`).Scan(&at); err != nil {
		return time.Time{}, err
	}
	if at == nil {
		return time.Time{}, nil
	}
	return *at, nil
}

// resolveFinancialYear turns an empty or unknown request year into the latest
// year the rollup actually holds. It resolves against mv_aec_party_funding
// rather than a constant so the API cannot claim a year the corpus lost.
func (s *postgresStore) resolveFinancialYear(ctx context.Context, financialYear string) (string, error) {
	financialYear = strings.TrimSpace(financialYear)
	if financialYear != "" {
		var exists bool
		if err := s.db.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM mv_aec_party_funding WHERE financial_year = $1)`,
			financialYear).Scan(&exists); err != nil {
			return "", err
		}
		if exists {
			return financialYear, nil
		}
	}
	var latest *string
	if err := s.db.QueryRow(ctx,
		`SELECT financial_year FROM mv_aec_party_funding
		 ORDER BY financial_year_end DESC, financial_year DESC LIMIT 1`).Scan(&latest); err != nil {
		return "", err
	}
	if latest == nil {
		return "", nil
	}
	return *latest, nil
}

// GetDonationsOverview returns one financial year's party-group rollups, the
// selectable years, and the corpus counts a methodology band needs.
//
// An unknown or empty year falls back to the latest held rather than erroring:
// this is the explorer's landing call and a bookmarked dead year should show
// the current corpus, not a 404.
func (s *postgresStore) GetDonationsOverview(financialYear string, limit int32) (*DonationsOverviewRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if limit <= 0 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}

	fy, err := s.resolveFinancialYear(ctx, financialYear)
	if err != nil {
		return nil, err
	}
	out := &DonationsOverviewRow{FinancialYear: fy}
	if out.AsAt, err = s.aecSnapshotAt(ctx); err != nil {
		return nil, err
	}

	if fy != "" {
		rows, err := s.db.Query(ctx,
			`SELECT `+partyFundingColumns+`
			 FROM mv_aec_party_funding
			 WHERE financial_year = $1
			 ORDER BY total_receipts_cents DESC, itemised_receipts_cents DESC, party_group_key
			 LIMIT $2`, fy, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			r, err := scanPartyFunding(rows.Scan)
			if err != nil {
				return nil, err
			}
			out.Parties = append(out.Parties, r)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	yearRows, err := s.db.Query(ctx, `
		SELECT financial_year, financial_year_end, count(*)::INTEGER
		FROM mv_aec_party_funding
		GROUP BY financial_year, financial_year_end
		ORDER BY financial_year_end DESC, financial_year DESC`)
	if err != nil {
		return nil, err
	}
	defer yearRows.Close()
	for yearRows.Next() {
		var y FinancialYearOptionRow
		if err := yearRows.Scan(&y.FinancialYear, &y.FinancialYearEnd, &y.PartyGroupCount); err != nil {
			return nil, err
		}
		out.AvailableYears = append(out.AvailableYears, &y)
	}
	if err := yearRows.Err(); err != nil {
		return nil, err
	}

	// The corpus counts. Every one is a plain count over a lodged-returns table;
	// the resolved counts are deliberately published NEXT TO the totals so the
	// gap between them (Senate returns are unresolvable against a House-only
	// politicians table) is visible rather than implied.
	var c DonationsCorpusRow
	if err := s.db.QueryRow(ctx, `
		SELECT
			(SELECT count(*)::INTEGER FROM aec_party_returns),
			(SELECT count(*)::INTEGER FROM aec_receipts),
			(SELECT count(*)::INTEGER FROM aec_donations_made),
			(SELECT count(*)::INTEGER FROM aec_mp_returns),
			(SELECT count(*)::INTEGER FROM aec_mp_returns WHERE politician_id IS NOT NULL),
			(SELECT count(*)::INTEGER FROM aec_candidate_returns),
			(SELECT count(*)::INTEGER FROM aec_candidate_returns WHERE politician_id IS NOT NULL),
			(SELECT count(*)::INTEGER FROM aec_candidate_returns WHERE nil_return),
			(SELECT count(*)::INTEGER FROM aec_candidate_donations),
			(SELECT COALESCE(min(financial_year_end), 0)::INTEGER FROM aec_party_returns),
			(SELECT COALESCE(max(financial_year_end), 0)::INTEGER FROM aec_party_returns),
			(SELECT count(DISTINCT stock_code)::INTEGER FROM v_aec_company_name_matches)`).
		Scan(&c.PartyReturnCount, &c.ReceiptCount, &c.DonationMadeCount,
			&c.MPReturnCount, &c.MPReturnResolvedCount,
			&c.CandidateReturnCount, &c.CandidateReturnResolvedCount,
			&c.NilCandidateReturnCount, &c.CandidateDonationCount,
			&c.FirstFinancialYearEnd, &c.LastFinancialYearEnd,
			&c.ListedCompanyMatchCount); err != nil {
		return nil, err
	}
	out.Corpus = &c
	return out, nil
}

// topDonorsScopeCTE is the population every payer list is drawn from: itemised
// receipts whose RECIPIENT is a party branch that rolls up to a party group,
// through the source's own Party Group column.
//
// Receipts into associated entities, significant third parties and political
// campaigners that never lodged a party return belong to NO group and are
// excluded rather than force-fitted into one. That is why a payer total here
// reconciles exactly to mv_aec_party_funding.itemised_receipts_cents — the two
// are the same join — and why the response says so in scope_note instead of
// leaving a reader to assume the list is every dollar the payer moved.
const topDonorsScopeCTE = `
	WITH scoped AS (
	    SELECT r.received_from, r.received_from_norm, r.receipt_type,
	           r.amount_cents, g.party_group_key
	    FROM aec_receipts r
	    JOIN v_aec_party_group_names g ON g.name_norm = r.recipient_name_norm
	    WHERE r.financial_year = $1
	      AND ($2 = '' OR g.party_group_key = $2)
	),
	donors AS (
	    SELECT
	        received_from_norm AS donor_name_norm,
	        -- The spelling attached to the largest single receipt. The source is
	        -- unnormalised (five spellings of one entity is normal), so ONE of
	        -- them has to be shown; picking deterministically beats picking
	        -- whichever the planner happened to emit first.
	        (array_agg(received_from ORDER BY amount_cents DESC, received_from))[1] AS donor_name,
	        sum(amount_cents)  AS total_cents,
	        count(*)::INTEGER  AS receipt_count,
	        COALESCE(sum(amount_cents) FILTER (WHERE receipt_type = '` + receiptTypeDonation + `'), 0) AS donation_cents,
	        COALESCE(sum(amount_cents) FILTER (WHERE receipt_type = '` + receiptTypeOther + `'), 0) AS other_receipt_cents,
	        COALESCE(sum(amount_cents) FILTER (WHERE receipt_type = '` + receiptTypeSubscription + `'), 0) AS subscription_cents,
	        COALESCE(sum(amount_cents) FILTER (WHERE receipt_type = '` + receiptTypePublicFund + `'), 0) AS public_funding_cents,
	        -- Everything the source did not classify ('Unspecified' and blank).
	        -- Named rather than dropped, so the five buckets provably sum to
	        -- total_cents and a bucket nobody anticipated cannot vanish.
	        COALESCE(sum(amount_cents) FILTER (
	            WHERE receipt_type NOT IN ('` + receiptTypeDonation + `', '` + receiptTypeOther + `',
	                                       '` + receiptTypeSubscription + `', '` + receiptTypePublicFund + `')
	        ), 0) AS unspecified_cents
	    FROM scoped
	    GROUP BY received_from_norm
	)`

// scanTopDonor reads one donors-CTE row plus its optional company match.
func scanTopDonor(scan func(dest ...any) error) (*TopDonorRow, error) {
	var r TopDonorRow
	if err := scan(&r.DonorNameNorm, &r.DonorName, &r.TotalCents, &r.ReceiptCount,
		&r.DonationCents, &r.OtherReceiptCents, &r.SubscriptionCents,
		&r.PublicFundingCents, &r.UnspecifiedCents,
		&r.StockCode, &r.CompanyName, &r.MatchMethod); err != nil {
		return nil, err
	}
	return &r, nil
}

const topDonorSelectList = `
	    d.donor_name_norm, d.donor_name, d.total_cents, d.receipt_count,
	    d.donation_cents, d.other_receipt_cents, d.subscription_cents,
	    d.public_funding_cents, d.unspecified_cents,
	    COALESCE(m.stock_code, ''), COALESCE(m.company_name, ''), COALESCE(m.match_method, '')`

// loadDonorRecipients attaches the party groups each payer paid into. It runs
// over the SAME scoped CTE as the totals, so a recipient split can never sum to
// something other than the total beside it.
func (s *postgresStore) loadDonorRecipients(ctx context.Context, fy, partyGroup string, donors []*TopDonorRow) error {
	if len(donors) == 0 {
		return nil
	}
	norms := make([]string, 0, len(donors))
	byNorm := make(map[string]*TopDonorRow, len(donors))
	for _, d := range donors {
		norms = append(norms, d.DonorNameNorm)
		byNorm[d.DonorNameNorm] = d
	}
	rows, err := s.db.Query(ctx, `
		WITH scoped AS (
		    SELECT r.received_from_norm, r.amount_cents, g.party_group_key
		    FROM aec_receipts r
		    JOIN v_aec_party_group_names g ON g.name_norm = r.recipient_name_norm
		    WHERE r.financial_year = $1
		      AND ($2 = '' OR g.party_group_key = $2)
		      AND r.received_from_norm = ANY($3)
		)
		SELECT received_from_norm, party_group_key, sum(amount_cents)
		FROM scoped
		GROUP BY 1, 2
		ORDER BY 1, 3 DESC, 2`, fy, partyGroup, norms)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var norm, group string
		var amount int64
		if err := rows.Scan(&norm, &group, &amount); err != nil {
			return err
		}
		if d, ok := byNorm[norm]; ok {
			d.Recipients = append(d.Recipients, &DonorRecipientRow{PartyGroup: group, AmountCents: amount})
		}
	}
	return rows.Err()
}

// ListTopDonors returns one page of payers for a financial year, ordered by the
// total the RECIPIENT declared receiving from them.
//
// The ordering is the only ranking, and it is over an amount the source
// published. Nothing here scores a payer or compares them to anything.
func (s *postgresStore) ListTopDonors(financialYear, partyGroup string, limit, offset int32) (*TopDonorsRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	partyGroup = strings.TrimSpace(partyGroup)
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}

	fy, err := s.resolveFinancialYear(ctx, financialYear)
	if err != nil {
		return nil, err
	}
	out := &TopDonorsRow{FinancialYear: fy, PartyGroup: partyGroup}
	if out.AsAt, err = s.aecSnapshotAt(ctx); err != nil {
		return nil, err
	}
	if fy == "" {
		return out, nil
	}

	// The REAL population, not the page size: a surface states how many payers
	// there are rather than how many it happened to render.
	if err := s.db.QueryRow(ctx, topDonorsScopeCTE+`
		SELECT count(*)::INTEGER FROM donors`, fy, partyGroup).Scan(&out.Total); err != nil {
		return nil, err
	}

	rows, err := s.db.Query(ctx, topDonorsScopeCTE+`
		SELECT `+topDonorSelectList+`
		FROM donors d
		LEFT JOIN v_aec_company_name_matches m ON m.name_norm = d.donor_name_norm
		ORDER BY d.total_cents DESC, d.donor_name_norm
		LIMIT $3 OFFSET $4`, fy, partyGroup, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		d, err := scanTopDonor(rows.Scan)
		if err != nil {
			return nil, err
		}
		out.Donors = append(out.Donors, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.loadDonorRecipients(ctx, fy, partyGroup, out.Donors); err != nil {
		return nil, err
	}
	return out, nil
}

// listedCompanyPayers returns the focus year's payers that carry an ASX code.
//
// An INNER join to the match view: an unmatched payer is not "a company we
// could not identify", it is simply not in this list. The view already excludes
// normalised names that collide across stock codes.
func (s *postgresStore) listedCompanyPayers(ctx context.Context, fy, partyGroup string, limit int32) ([]*TopDonorRow, error) {
	rows, err := s.db.Query(ctx, topDonorsScopeCTE+`
		SELECT `+topDonorSelectList+`
		FROM donors d
		JOIN v_aec_company_name_matches m ON m.name_norm = d.donor_name_norm
		ORDER BY d.total_cents DESC, d.donor_name_norm
		LIMIT $3`, fy, partyGroup, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*TopDonorRow{}
	for rows.Next() {
		d, err := scanTopDonor(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ListPartyFunding returns one party group's whole funding series plus the
// focus year's payer lists.
//
// The series is ASCENDING by year and carries post_reform_scheme on every row,
// because the consumer of this method is a chart and the 1 Jan 2027 break has
// to be annotatable from the data rather than remembered.
func (s *postgresStore) ListPartyFunding(partyGroup, financialYear string, limit int32) (*PartyFundingDetailRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	partyGroup = strings.TrimSpace(partyGroup)
	if limit <= 0 {
		limit = 25
	}
	if limit > 200 {
		limit = 200
	}

	out := &PartyFundingDetailRow{PartyGroup: partyGroup}
	var err error
	if out.AsAt, err = s.aecSnapshotAt(ctx); err != nil {
		return nil, err
	}
	if partyGroup == "" {
		return out, nil
	}

	rows, err := s.db.Query(ctx,
		`SELECT `+partyFundingColumns+`
		 FROM mv_aec_party_funding
		 WHERE party_group_key = $1
		 ORDER BY financial_year_end ASC, financial_year ASC`, partyGroup)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		r, err := scanPartyFunding(rows.Scan)
		if err != nil {
			return nil, err
		}
		out.Series = append(out.Series, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out.Series) == 0 {
		return out, nil
	}

	// The focus year, constrained to years THIS GROUP lodged in: falling back to
	// the corpus-wide latest would serve a party its neighbours' year and draw
	// an empty donor list under a year the party has no return for.
	fy := strings.TrimSpace(financialYear)
	found := false
	for _, r := range out.Series {
		if r.FinancialYear == fy {
			found = true
			break
		}
	}
	if !found {
		fy = out.Series[len(out.Series)-1].FinancialYear
	}
	out.FinancialYear = fy

	donors, err := s.ListTopDonors(fy, partyGroup, limit, 0)
	if err != nil {
		return nil, err
	}
	out.TopDonors = donors.Donors

	if out.ListedCompanyPayers, err = s.listedCompanyPayers(ctx, fy, partyGroup, limit); err != nil {
		return nil, err
	}
	if err := s.loadDonorRecipients(ctx, fy, partyGroup, out.ListedCompanyPayers); err != nil {
		return nil, err
	}

	// The branches that lodged under this group, verbatim. The rollup is the
	// source's own Party Group column, and publishing its members makes the
	// grouping inspectable instead of asserted.
	branchRows, err := s.db.Query(ctx,
		`SELECT DISTINCT party_name FROM aec_party_returns
		 WHERE party_group_key = $1 ORDER BY party_name`, partyGroup)
	if err != nil {
		return nil, err
	}
	defer branchRows.Close()
	for branchRows.Next() {
		var name string
		if err := branchRows.Scan(&name); err != nil {
			return nil, err
		}
		out.BranchNames = append(out.BranchNames, name)
	}
	if err := branchRows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// GetPoliticianFunding returns the AEC returns that NAME one member.
//
// Both queries join on politician_id — the resolved FK written by the ingest
// resolver, which is NULL on any ambiguity. Nothing here matches a name, so an
// unresolved return (every Senator return, because the politicians table is
// House-only; and any name the resolver would not commit to) is unreachable
// from this method by construction rather than by a filter someone could drop.
//
// A member with no rows gets an EMPTY response, not a 404: they exist, and the
// absence of a return is not evidence they received nothing. The coverage
// strings the handler attaches say exactly that.
func (s *postgresStore) GetPoliticianFunding(slug string) (*PoliticianFundingRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	slug = strings.ToLower(strings.TrimSpace(slug))

	// Canonical-slug handling exactly as GetPolitician does it: merged rows are
	// excluded so a retired slug 404s rather than silently resolving, and the
	// stored slug is echoed back for the consumer's redirect.
	var canonical string
	if err := s.db.QueryRow(ctx,
		`SELECT slug FROM politicians WHERE slug = $1 AND merged_into_id IS NULL`, slug).
		Scan(&canonical); err != nil {
		return nil, err
	}
	out := &PoliticianFundingRow{CanonicalSlug: canonical}
	var err error
	if out.AsAt, err = s.aecSnapshotAt(ctx); err != nil {
		return nil, err
	}

	annualRows, err := s.db.Query(ctx, `
		SELECT m.financial_year, m.financial_year_end, m.return_type, m.chamber,
		       m.member_name, m.total_donations_cents, m.donor_count, m.source_url
		FROM aec_mp_returns m
		JOIN politicians p ON p.id = m.politician_id
		WHERE p.slug = $1
		ORDER BY m.financial_year_end DESC, m.financial_year DESC`, canonical)
	if err != nil {
		return nil, err
	}
	defer annualRows.Close()
	for annualRows.Next() {
		var r MemberAnnualReturnRow
		if err := annualRows.Scan(&r.FinancialYear, &r.FinancialYearEnd, &r.ReturnType,
			&r.Chamber, &r.MemberName, &r.TotalDonationsCents, &r.DonorCount,
			&r.SourceURL); err != nil {
			return nil, err
		}
		out.AnnualReturns = append(out.AnnualReturns, &r)
	}
	if err := annualRows.Err(); err != nil {
		return nil, err
	}

	// The candidate returns, each carrying its EVENT's corpus-wide coverage.
	// Computed in the same statement as the row it caveats so the two can never
	// be assembled from different snapshots.
	candidateRows, err := s.db.Query(ctx, `
		WITH event_coverage AS (
		    SELECT r.event,
		           count(*)::INTEGER AS event_return_count,
		           count(DISTINCT d.candidate_return_id)::INTEGER AS event_itemised_return_count
		    FROM aec_candidate_returns r
		    LEFT JOIN aec_candidate_donations d ON d.candidate_return_id = r.id
		    GROUP BY r.event
		)
		SELECT r.id, r.event, COALESCE(r.event_year, 0), r.return_type, r.candidate_name,
		       r.party_name, r.electorate_name, r.electorate_state, r.nil_return,
		       r.amendment_no, r.total_gift_cents, r.donor_count,
		       r.expenditure_cents, r.discretionary_cents, r.source_url,
		       c.event_return_count, c.event_itemised_return_count
		FROM aec_candidate_returns r
		JOIN politicians p ON p.id = r.politician_id
		JOIN event_coverage c ON c.event = r.event
		WHERE p.slug = $1
		ORDER BY r.event_year DESC NULLS LAST, r.event, r.return_type`, canonical)
	if err != nil {
		return nil, err
	}
	defer candidateRows.Close()

	byID := map[string]*CandidateElectionReturnRow{}
	ids := []string{}
	for candidateRows.Next() {
		var id string
		var r CandidateElectionReturnRow
		if err := candidateRows.Scan(&id, &r.Event, &r.EventYear, &r.ReturnType, &r.CandidateName,
			&r.PartyName, &r.ElectorateName, &r.ElectorateState, &r.NilReturn,
			&r.AmendmentNo, &r.TotalGiftCents, &r.DonorCount,
			&r.ExpenditureCents, &r.DiscretionaryCents, &r.SourceURL,
			&r.EventReturnCount, &r.EventItemisedReturnCount); err != nil {
			return nil, err
		}
		out.CandidateReturns = append(out.CandidateReturns, &r)
		byID[id] = &r
		ids = append(ids, id)
	}
	if err := candidateRows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}

	// Itemised gifts, keyed by candidate_return_id — the return's own FK, never
	// the candidate's name.
	donationRows, err := s.db.Query(ctx, `
		SELECT candidate_return_id, donor_name, donation_date, amount_cents
		FROM aec_candidate_donations
		WHERE candidate_return_id = ANY($1)
		ORDER BY amount_cents DESC, donor_name`, ids)
	if err != nil {
		return nil, err
	}
	defer donationRows.Close()
	for donationRows.Next() {
		var id string
		var d CandidateDonationRow
		var date *time.Time
		if err := donationRows.Scan(&id, &d.DonorName, &date, &d.AmountCents); err != nil {
			return nil, err
		}
		if date != nil {
			d.DonationDate = date.Format("2006-01-02")
		}
		if r, ok := byID[id]; ok {
			r.Donations = append(r.Donations, &d)
		}
	}
	if err := donationRows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
