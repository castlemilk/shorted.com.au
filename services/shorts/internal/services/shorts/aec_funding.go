package shorts

// Handlers for the AEC funding layer (docs/feature/politicians/donations.md).
//
// SEPARATE SUBSYSTEM FROM THE REGISTER, deliberately. The Registers of
// Members'/Senators' Interests disclose WHAT is held and never how much, and a
// migration guard asserts no magnitude column exists anywhere in them. The AEC
// Transparency Register publishes lodged FUNDING FIGURES under CC BY 4.0, and
// the editorial standards' own worked example blesses rendering them. So
// amounts live here, in cents, and the two layers share only a politician id.
//
// Four rules bind every handler below:
//
//  1. THE NOTES ARE SERVED, NOT REMEMBERED. Right-censoring, the 1 Jan 2027
//     reform break, the member-layer coverage and the verbatim-as-lodged
//     caveat ship as response strings from the constants in this file. Every
//     surface then renders one set of words from one server-side source, and a
//     consumer cannot paraphrase them into a claim the data cannot support.
//  2. NO DERIVED MEASURE. Nothing here computes a ratio, share, index, rank or
//     score. The only ordering is by an amount the AEC itself published.
//  3. ATTRIBUTION HONESTY. GetPoliticianFunding serves only returns that NAME
//     the member. Party money is never attributed to a member, and a return the
//     resolver would not commit to is reachable from no member response.
//  4. THE KILL SWITCH RETURNS EMPTY, never an error — the same shape the
//     register's does, so a takedown degrades a surface instead of breaking it.

import (
	"context"
	"fmt"
	"os"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The licence obligations. CC BY 4.0 requires the credit; the AEC's copyright
// policy requires that nothing imply its endorsement. Both ride on every
// response rather than being left to a page footer someone can forget.
const (
	aecLicence     = "CC-BY-4.0"
	aecAttribution = "© Commonwealth of Australia — AEC Transparency Register"
)

// The mandatory notes. These are the ONLY copy for these facts anywhere in the
// product: the web tier renders these strings verbatim so a wording fix lands
// in one place and every surface inherits it.
const (
	// The single most important thing a reader can misunderstand about this
	// data. A small total is a disclosure fact, not a funding fact.
	aecCensoringNote = "Amounts below the disclosure threshold in force for a given year are not " +
		"published by the AEC and are absent from these figures. A low total means little was " +
		"disclosed, not that little was received."

	// Any series crossing 1 Jan 2027 is two schemes drawn as one line unless
	// this is rendered beside it.
	aecReformNote = "The funding and disclosure reform commences on 1 January 2027, introducing a " +
		"$5,000 disclosure threshold, near-real-time notices and caps. Financial years from " +
		"2026-27 are lodged under that scheme and are not comparable with earlier years."

	// The AEC regenerates the bulk exports continuously as amendments land, so
	// "as at" is the only honest caption for any figure here.
	aecVerbatimNote = "Figures are reproduced as lodged with the AEC, including amendments, and are " +
		"not adjusted. The AEC republishes its bulk data as amendments are received, so a figure " +
		"can change after a financial year closes."

	// The member layer's coverage, stated wherever the member layer is
	// implicated. The Senate sentence is the honest form of a known limitation:
	// the politicians table is House-only, so no Senator return resolves to a
	// member page and none is served on one.
	aecMemberCoverageNote = "Annual member and senator returns are lodged by a small number of " +
		"parliamentarians: the whole corpus holds 52 of them. Senator returns are not yet linked " +
		"to profiles here. A parliamentarian with no return has not been shown to have received " +
		"nothing — most never lodge one."

	// The rule that makes a member funding surface honest at all.
	aecAttributionNote = "Only returns that name this parliamentarian are shown. Money declared as " +
		"given to a party, a branch or an associated entity is not shown here and is not " +
		"attributable to any individual."

	// What the payer lists are over. Without this a reader takes a payer's total
	// for every dollar they moved, when it is only what party branches declared.
	aecDonorScopeNote = "Payers are drawn from itemised receipts declared by party branches, rolled " +
		"up using the AEC's own party group. Receipts declared by associated entities, " +
		"significant third parties and political campaigners that lodged no party return belong " +
		"to no party group and are not counted here. Receipt types are shown separately because " +
		"the source distinguishes them: a subscription or other receipt is not a donation."
)

// aecDonationsEnabled is the kill switch. Enabled by DEFAULT — no opt-in env is
// needed to ship. Set AEC_DONATIONS_ENABLED to a falsey value only to take the
// funding surfaces down (a takedown request or a data dispute), which returns
// EMPTY responses rather than errors so the pages degrade instead of breaking.
//
// It is SEPARATE from POLITICIAN_INTERESTS_ENABLED on purpose: a dispute about
// a funding figure must not be able to take the register down, and vice versa.
func aecDonationsEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("AEC_DONATIONS_ENABLED"))) {
	case "false", "0", "off", "no":
		return false
	default:
		return true
	}
}

// ---------------------------------------------------------------------------
// Proto mappers
// ---------------------------------------------------------------------------

func partyFundingProto(r *shortsstore.PartyFundingRow) *shortsv1alpha1.PartyFundingSummary {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.PartyFundingSummary{
		PartyGroup:             r.PartyGroup,
		FinancialYear:          r.FinancialYear,
		FinancialYearEnd:       r.FinancialYearEnd,
		PartyReturnCount:       r.PartyReturnCount,
		TotalReceiptsCents:     r.TotalReceiptsCents,
		TotalPaymentsCents:     r.TotalPaymentsCents,
		TotalDebtsCents:        r.TotalDebtsCents,
		ItemisedReceiptCount:   r.ItemisedReceiptCount,
		ItemisedReceiptsCents:  r.ItemisedReceiptsCents,
		DistinctPayerCount:     r.DistinctPayerCount,
		ListedPayerCount:       r.ListedPayerCount,
		ListedPayerCents:       r.ListedPayerCents,
		DonationCount:          r.DonationCount,
		DeclaredDonationsCents: r.DeclaredDonationsCents,
		DistinctDonorCount:     r.DistinctDonorCount,
		ListedDonorCount:       r.ListedDonorCount,
		ListedDonorCents:       r.ListedDonorCents,
		ThresholdCensored:      r.ThresholdCensored,
		PostReformScheme:       r.PostReformScheme,
	}
}

func topDonorProto(r *shortsstore.TopDonorRow) *shortsv1alpha1.TopDonor {
	if r == nil {
		return nil
	}
	out := &shortsv1alpha1.TopDonor{
		DonorName:     r.DonorName,
		DonorNameNorm: r.DonorNameNorm,
		TotalCents:    r.TotalCents,
		ReceiptCount:  r.ReceiptCount,
		// The source's own distinction, carried through rather than summed
		// away. The five buckets are exhaustive over the source vocabulary, so
		// this provably sums to TotalCents.
		ReceiptTypes: &shortsv1alpha1.ReceiptTypeSplit{
			DonationCents:      r.DonationCents,
			OtherReceiptCents:  r.OtherReceiptCents,
			SubscriptionCents:  r.SubscriptionCents,
			PublicFundingCents: r.PublicFundingCents,
			UnspecifiedCents:   r.UnspecifiedCents,
		},
		// Exact normalised name or a curated alias, never fuzzy. Empty means
		// "not matched", which a consumer must not render as "not listed".
		StockCode:   r.StockCode,
		CompanyName: r.CompanyName,
		MatchMethod: r.MatchMethod,
	}
	for _, rec := range r.Recipients {
		out.Recipients = append(out.Recipients, &shortsv1alpha1.DonorRecipientGroup{
			PartyGroup: rec.PartyGroup, AmountCents: rec.AmountCents,
		})
	}
	return out
}

func topDonorsProto(rows []*shortsstore.TopDonorRow) []*shortsv1alpha1.TopDonor {
	out := make([]*shortsv1alpha1.TopDonor, 0, len(rows))
	for _, r := range rows {
		out = append(out, topDonorProto(r))
	}
	return out
}

func memberAnnualReturnProto(r *shortsstore.MemberAnnualReturnRow) *shortsv1alpha1.MemberAnnualReturn {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.MemberAnnualReturn{
		FinancialYear:       r.FinancialYear,
		FinancialYearEnd:    r.FinancialYearEnd,
		ReturnType:          r.ReturnType,
		Chamber:             r.Chamber,
		MemberName:          r.MemberName,
		TotalDonationsCents: r.TotalDonationsCents,
		DonorCount:          r.DonorCount,
		SourceUrl:           r.SourceURL,
	}
}

func candidateReturnProto(r *shortsstore.CandidateElectionReturnRow) *shortsv1alpha1.CandidateElectionReturn {
	if r == nil {
		return nil
	}
	out := &shortsv1alpha1.CandidateElectionReturn{
		Event:              r.Event,
		EventYear:          r.EventYear,
		ReturnType:         r.ReturnType,
		CandidateName:      r.CandidateName,
		PartyName:          r.PartyName,
		ElectorateName:     r.ElectorateName,
		ElectorateState:    r.ElectorateState,
		NilReturn:          r.NilReturn,
		AmendmentNo:        r.AmendmentNo,
		TotalGiftCents:     r.TotalGiftCents,
		DonorCount:         r.DonorCount,
		ExpenditureCents:   r.ExpenditureCents,
		DiscretionaryCents: r.DiscretionaryCents,
		// The event's corpus-wide coverage rides ON the row, so an empty
		// donations list cannot be read as "received nothing".
		EventReturnCount:         r.EventReturnCount,
		EventItemisedReturnCount: r.EventItemisedReturnCount,
		SourceUrl:                r.SourceURL,
	}
	for _, d := range r.Donations {
		out.Donations = append(out.Donations, &shortsv1alpha1.CandidateDonation{
			DonorName: d.DonorName, DonationDate: d.DonationDate, AmountCents: d.AmountCents,
		})
	}
	return out
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// clampDonationsLimit normalises a limit BEFORE the cache key is built, so a
// key can never describe a page size other than the one that produced it. The
// store clamps again by the same rule — a store method is its own entry point.
func clampDonationsLimit(requested, def, max int32) int32 {
	return clampLimit(requested, def, max)
}

// normaliseFinancialYear trims only. The FY label is VERBATIM from the source
// ('2011-12' in some years, '1998-1999' in others), so upper- or lower-casing it
// or reformatting it would invent a label the corpus does not contain.
func normaliseFinancialYear(fy string) string {
	return strings.TrimSpace(fy)
}

// GetDonationsOverview serves the funding explorer's landing payload.
//
// The response is deliberately note-heavy: a page of party totals with no
// censoring caveat is the single most misleading thing this data can produce,
// so the caveat ships WITH the totals rather than being a page-level string a
// consumer might drop.
func (s *ShortsServer) GetDonationsOverview(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetDonationsOverviewRequest],
) (*connect.Response[shortsv1alpha1.GetDonationsOverviewResponse], error) {
	if !aecDonationsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetDonationsOverviewResponse{}), nil
	}

	fy := normaliseFinancialYear(req.Msg.FinancialYear)
	limit := clampDonationsLimit(req.Msg.Limit, 25, 100)

	cached, err := s.cache.GetOrSet(s.cache.GetDonationsOverviewKey(fy, limit), func() (interface{}, error) {
		row, err := s.store.GetDonationsOverview(fy, limit)
		if err != nil {
			return nil, err
		}
		out := &shortsv1alpha1.GetDonationsOverviewResponse{
			CensoringNote: aecCensoringNote,
			ReformNote:    aecReformNote,
			CoverageNote:  aecMemberCoverageNote,
			VerbatimNote:  aecVerbatimNote,
			SourceLicence: aecLicence,
			Attribution:   aecAttribution,
		}
		if row == nil {
			return out, nil
		}
		out.FinancialYear = row.FinancialYear
		out.AsAt = registerTimestamp(row.AsAt)
		for _, p := range row.Parties {
			out.Parties = append(out.Parties, partyFundingProto(p))
		}
		for _, y := range row.AvailableYears {
			out.AvailableFinancialYears = append(out.AvailableFinancialYears,
				&shortsv1alpha1.FinancialYearOption{
					FinancialYear:    y.FinancialYear,
					FinancialYearEnd: y.FinancialYearEnd,
					PartyGroupCount:  y.PartyGroupCount,
				})
		}
		if c := row.Corpus; c != nil {
			out.Corpus = &shortsv1alpha1.DonationsCorpusCounts{
				PartyReturnCount:             c.PartyReturnCount,
				ReceiptCount:                 c.ReceiptCount,
				DonationMadeCount:            c.DonationMadeCount,
				MpReturnCount:                c.MPReturnCount,
				MpReturnResolvedCount:        c.MPReturnResolvedCount,
				CandidateReturnCount:         c.CandidateReturnCount,
				CandidateReturnResolvedCount: c.CandidateReturnResolvedCount,
				NilCandidateReturnCount:      c.NilCandidateReturnCount,
				CandidateDonationCount:       c.CandidateDonationCount,
				FirstFinancialYearEnd:        c.FirstFinancialYearEnd,
				LastFinancialYearEnd:         c.LastFinancialYearEnd,
				ListedCompanyMatchCount:      c.ListedCompanyMatchCount,
			}
		}
		return out, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetDonationsOverview: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load donations overview"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetDonationsOverviewResponse)), nil
}

// ListTopDonors serves one page of payers into party branches.
//
// The ordering by amount is the ONLY ranking, and it is over a figure the AEC
// published. Nothing scores a payer, and the response carries the scope note so
// a total here is not read as everything the payer moved.
func (s *ShortsServer) ListTopDonors(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListTopDonorsRequest],
) (*connect.Response[shortsv1alpha1.ListTopDonorsResponse], error) {
	if !aecDonationsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListTopDonorsResponse{}), nil
	}

	m := req.Msg
	fy := normaliseFinancialYear(m.FinancialYear)
	// The party group is the source's own verbatim key ('The Greens',
	// 'Country Liberal Party (NT)'). Case-folding it would fail every lookup.
	partyGroup := strings.TrimSpace(m.PartyGroup)
	limit := clampDonationsLimit(m.Limit, 50, 200)
	offset := max32(m.Offset, 0)

	cached, err := s.cache.GetOrSet(
		s.cache.ListTopDonorsKey(fy, partyGroup, limit, offset),
		func() (interface{}, error) {
			row, err := s.store.ListTopDonors(fy, partyGroup, limit, offset)
			if err != nil {
				return nil, err
			}
			out := &shortsv1alpha1.ListTopDonorsResponse{
				PartyGroup:    partyGroup,
				ScopeNote:     aecDonorScopeNote,
				CensoringNote: aecCensoringNote,
				ReformNote:    aecReformNote,
				VerbatimNote:  aecVerbatimNote,
				SourceLicence: aecLicence,
				Attribution:   aecAttribution,
			}
			if row == nil {
				return out, nil
			}
			out.FinancialYear = row.FinancialYear
			out.PartyGroup = row.PartyGroup
			out.Total = row.Total
			out.AsAt = registerTimestamp(row.AsAt)
			out.Donors = topDonorsProto(row.Donors)
			return out, nil
		})
	if err != nil {
		s.logger.Errorf("database error in ListTopDonors: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list top donors"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListTopDonorsResponse)), nil
}

// ListPartyFunding serves one party group's series and its focus-year payers.
//
// The series carries post_reform_scheme per row: the chart this feeds must
// break at 1 Jan 2027, and that has to be readable from the data rather than
// hard-coded into a component that will outlive whoever remembered it.
func (s *ShortsServer) ListPartyFunding(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListPartyFundingRequest],
) (*connect.Response[shortsv1alpha1.ListPartyFundingResponse], error) {
	partyGroup := strings.TrimSpace(req.Msg.PartyGroup)
	if partyGroup == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("party_group is required"))
	}
	if !aecDonationsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListPartyFundingResponse{}), nil
	}

	fy := normaliseFinancialYear(req.Msg.FinancialYear)
	limit := clampDonationsLimit(req.Msg.Limit, 25, 200)

	cached, err := s.cache.GetOrSet(
		s.cache.ListPartyFundingKey(partyGroup, fy, limit),
		func() (interface{}, error) {
			row, err := s.store.ListPartyFunding(partyGroup, fy, limit)
			if err != nil {
				return nil, err
			}
			out := &shortsv1alpha1.ListPartyFundingResponse{
				PartyGroup:    partyGroup,
				CensoringNote: aecCensoringNote,
				ReformNote:    aecReformNote,
				VerbatimNote:  aecVerbatimNote,
				SourceLicence: aecLicence,
				Attribution:   aecAttribution,
			}
			if row == nil {
				return out, nil
			}
			out.PartyGroup = row.PartyGroup
			out.FinancialYear = row.FinancialYear
			out.BranchNames = row.BranchNames
			out.AsAt = registerTimestamp(row.AsAt)
			for _, r := range row.Series {
				out.Series = append(out.Series, partyFundingProto(r))
			}
			out.TopDonors = topDonorsProto(row.TopDonors)
			out.ListedCompanyPayers = topDonorsProto(row.ListedCompanyPayers)
			return out, nil
		})
	if err != nil {
		s.logger.Errorf("database error in ListPartyFunding: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load party funding"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListPartyFundingResponse)), nil
}

// GetPoliticianFunding serves the funding returns that NAME one member.
//
// It never returns a party figure, and it never returns a return the ingest
// resolver would not commit to a politician id — which includes every Senator
// return, because the politicians table is House-only. That is a coverage fact,
// not a bug, and coverage_note states it on every response including the empty
// ones: a member with no returns has not been shown to have received nothing.
func (s *ShortsServer) GetPoliticianFunding(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetPoliticianFundingRequest],
) (*connect.Response[shortsv1alpha1.GetPoliticianFundingResponse], error) {
	// Lower-cased and trimmed IS the canonical form; the store echoes back the
	// stored slug so a consumer redirects exactly as GetPolitician's does.
	slug := strings.ToLower(strings.TrimSpace(req.Msg.Slug))
	if slug == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("slug is required"))
	}
	if !aecDonationsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetPoliticianFundingResponse{}), nil
	}

	cached, err := s.cache.GetOrSet(s.cache.GetPoliticianFundingKey(slug), func() (interface{}, error) {
		row, err := s.store.GetPoliticianFunding(slug)
		if err != nil {
			return nil, err
		}
		// Served whether or not anything resolved. A funding section that
		// renders nothing still has to be able to say what "nothing" means.
		out := &shortsv1alpha1.GetPoliticianFundingResponse{
			CoverageNote:    aecMemberCoverageNote,
			AttributionNote: aecAttributionNote,
			CensoringNote:   aecCensoringNote,
			ReformNote:      aecReformNote,
			VerbatimNote:    aecVerbatimNote,
			SourceLicence:   aecLicence,
			Attribution:     aecAttribution,
		}
		if row == nil {
			return out, nil
		}
		out.CanonicalSlug = row.CanonicalSlug
		out.AsAt = registerTimestamp(row.AsAt)
		for _, r := range row.AnnualReturns {
			out.AnnualReturns = append(out.AnnualReturns, memberAnnualReturnProto(r))
		}
		for _, r := range row.CandidateReturns {
			out.CandidateReturns = append(out.CandidateReturns, candidateReturnProto(r))
		}
		return out, nil
	})
	if err != nil {
		if isNoRows(err) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("politician not found"))
		}
		s.logger.Errorf("database error in GetPoliticianFunding: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load politician funding"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetPoliticianFundingResponse)), nil
}
