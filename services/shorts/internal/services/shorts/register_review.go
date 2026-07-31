package shorts

// RegisterReviewService — the operator console behind the Register of Interests.
//
// NOTHING HERE IS A PUBLIC READ PATH. Every method is VISIBILITY_PRIVATE with
// required_role="admin" in the proto AND listed in internalOnlyMethods, so it
// needs the internal service secret as well as an admin identity. Declaring a
// method PRIVATE alone is not enough: the interceptor treats PRIVATE with no
// required_role as "any authenticated user".
//
// WHY THE CONSOLE EXISTS. §6.1's item-1 gate is 51.18%, and §8.19.1 showed the
// denominator is a DEFAULT bucket — the resolver labels anything it cannot
// otherwise explain 'listed'. So the backlog contains two different things that
// look identical in the number: names we could match and have not, and names
// that are correctly unmatchable (delisted, foreign, unlisted funds, prose). A
// human separating them raises coverage honestly. A machine doing it would be
// guessing about named individuals, which is the one thing this subsystem does
// not do.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	registerreviewv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/registerreview/v1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// decisionWire maps the closed proto enum onto the alias table's vocabulary.
// The enum has no fuzzy member, so there is no wire value that could ask for an
// unpublishable match — the omission is the enforcement.
var decisionWire = map[registerreviewv1.SecurityDecision]string{
	registerreviewv1.SecurityDecision_SECURITY_DECISION_RESOLVED:       "resolved",
	registerreviewv1.SecurityDecision_SECURITY_DECISION_NOT_A_SECURITY: "not_a_security",
	registerreviewv1.SecurityDecision_SECURITY_DECISION_UNLISTED_FUND:  "unlisted_fund",
	registerreviewv1.SecurityDecision_SECURITY_DECISION_FOREIGN:        "foreign",
	registerreviewv1.SecurityDecision_SECURITY_DECISION_SKIP:           "skip",
}

var aliasKindWire = map[registerreviewv1.AliasKind]string{
	registerreviewv1.AliasKind_ALIAS_KIND_EQUITY:       "equity",
	registerreviewv1.AliasKind_ALIAS_KIND_ETF:          "etf",
	registerreviewv1.AliasKind_ALIAS_KIND_LIC:          "lic",
	registerreviewv1.AliasKind_ALIAS_KIND_MANAGED_FUND: "managed_fund",
}

func (s *ShortsServer) ListSecurityQueue(
	ctx context.Context,
	req *connect.Request[registerreviewv1.ListSecurityQueueRequest],
) (*connect.Response[registerreviewv1.ListSecurityQueueResponse], error) {
	rows, totalCandidates, totalRows, err := s.store.ListSecurityReviewQueue(
		req.Msg.GetLimit(), req.Msg.GetOffset(), req.Msg.GetGateOnly())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	items := make([]*registerreviewv1.SecurityQueueItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, queueItemToProto(r))
	}
	return connect.NewResponse(&registerreviewv1.ListSecurityQueueResponse{
		Items:           items,
		TotalCandidates: totalCandidates,
		TotalRows:       totalRows,
	}), nil
}

func queueItemToProto(r *shortsstore.SecurityQueueRow) *registerreviewv1.SecurityQueueItem {
	item := &registerreviewv1.SecurityQueueItem{
		CandidateNorm: r.CandidateNorm,
		Example:       r.Example,
		Occurrences:   r.Occurrences,
		People:        r.People,
		Items:         r.Items,
		Parliaments:   r.Parliaments,
		EntityKinds:   r.EntityKinds,
		GateRows:      r.GateRows,
		SkipCount:     r.SkipCount,
	}
	for _, sm := range r.Samples {
		item.Samples = append(item.Samples, &registerreviewv1.DeclaredSample{
			DeclaredText:   sm.DeclaredText,
			PoliticianName: sm.PoliticianName,
			PoliticianSlug: sm.PoliticianSlug,
			ItemNo:         sm.ItemNo,
			Parliament:     sm.Parliament,
			SourceUrl:      sm.SourceURL,
		})
	}
	if r.Proposal != nil {
		p := &registerreviewv1.AliasProposal{
			ProposedStockCode:   r.Proposal.ProposedStockCode,
			ProposedCompanyName: r.Proposal.ProposedCompanyName,
			Confidence:          r.Proposal.Confidence,
			Rationale:           r.Proposal.Rationale,
			Model:               r.Proposal.Model,
			Status:              r.Proposal.Status,
		}
		for _, l := range r.Proposal.Shortlist {
			p.Shortlist = append(p.Shortlist, listingToProto(l))
		}
		item.Proposal = p
	}
	return item
}

func listingToProto(l *shortsstore.RegisterListingRow) *registerreviewv1.Listing {
	return &registerreviewv1.Listing{
		StockCode:        l.StockCode,
		CompanyName:      l.CompanyName,
		ExistingUses:     l.ExistingUses,
		IsStopwordTicker: l.IsStopword,
	}
}

func (s *ShortsServer) SearchListings(
	ctx context.Context,
	req *connect.Request[registerreviewv1.SearchListingsRequest],
) (*connect.Response[registerreviewv1.SearchListingsResponse], error) {
	rows, err := s.store.SearchRegisterListings(req.Msg.GetQuery(), req.Msg.GetLimit())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := make([]*registerreviewv1.Listing, 0, len(rows))
	for _, l := range rows {
		out = append(out, listingToProto(l))
	}
	return connect.NewResponse(&registerreviewv1.SearchListingsResponse{Listings: out}), nil
}

func (s *ShortsServer) DecideSecurityCandidate(
	ctx context.Context,
	req *connect.Request[registerreviewv1.DecideSecurityCandidateRequest],
) (*connect.Response[registerreviewv1.DecideSecurityCandidateResponse], error) {
	decision, ok := decisionWire[req.Msg.GetDecision()]
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("decision is required and must be one of the SecurityDecision values"))
	}

	// THE REVIEWER'S IDENTITY COMES FROM THE REQUEST CONTEXT, never from the
	// body. curated_by is the evidence a human made this call, and a body-supplied
	// identity is an identity the caller chose for themselves — the same shape as
	// the Stripe webhook self-grant the 2026-07 audit found.
	reviewer := reviewerFromHeaders(req.Header())
	if reviewer == "" {
		return nil, connect.NewError(connect.CodeUnauthenticated,
			errors.New("no reviewer identity on the request"))
	}

	affected, err := s.store.DecideSecurityCandidate(
		req.Msg.GetCandidateNorm(), decision, req.Msg.GetStockCode(),
		aliasKindWire[req.Msg.GetAliasKind()], req.Msg.GetNote(), reviewer,
		req.Msg.GetStopwordConfirmed())
	if err != nil {
		switch {
		case errors.Is(err, shortsstore.ErrRegisterListingUnknown),
			errors.Is(err, shortsstore.ErrRegisterStopwordUnconfirmed):
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		default:
			return nil, connect.NewError(connect.CodeInternal, err)
		}
	}

	coverage, err := s.store.GetRegisterCoverageStats()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&registerreviewv1.DecideSecurityCandidateResponse{
		RowsAffected: affected,
		Coverage:     coverageToProto(coverage),
	}), nil
}

func (s *ShortsServer) UndoSecurityDecision(
	ctx context.Context,
	req *connect.Request[registerreviewv1.UndoSecurityDecisionRequest],
) (*connect.Response[registerreviewv1.UndoSecurityDecisionResponse], error) {
	deleted, err := s.store.UndoSecurityDecision(req.Msg.GetCandidateNorm())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	coverage, err := s.store.GetRegisterCoverageStats()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&registerreviewv1.UndoSecurityDecisionResponse{
		Deleted:  deleted,
		Coverage: coverageToProto(coverage),
	}), nil
}

func (s *ShortsServer) GetCoverageStats(
	ctx context.Context,
	req *connect.Request[registerreviewv1.GetCoverageStatsRequest],
) (*connect.Response[registerreviewv1.GetCoverageStatsResponse], error) {
	coverage, err := s.store.GetRegisterCoverageStats()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&registerreviewv1.GetCoverageStatsResponse{
		Coverage: coverageToProto(coverage),
	}), nil
}

func coverageToProto(r *shortsstore.RegisterCoverageRow) *registerreviewv1.CoverageStats {
	if r == nil {
		return nil
	}
	return &registerreviewv1.CoverageStats{
		Resolved:          r.Resolved,
		ListedCandidates:  r.ListedCandidates,
		GatePercent:       r.GatePercent,
		BacklogCandidates: r.BacklogCandidates,
		BacklogRows:       r.BacklogRows,
		ClassifiedOut:     r.ClassifiedOut,
		Method:            r.Method,
	}
}

// reviewerFromHeaders reads the admin identity the web tier attached after its
// own requireAdmin() check. The interceptor has already refused the request
// unless it carried the internal secret and an admin role, so this is a label
// for the audit trail rather than the authorisation itself — but it is the label
// that ends up in curated_by, so it is read from the header the gateway sets and
// nowhere else.
func reviewerFromHeaders(h interface{ Get(string) string }) string {
	if v := strings.TrimSpace(h.Get("X-User-Email")); v != "" {
		return strings.ToLower(v)
	}
	return strings.TrimSpace(h.Get("X-User-Id"))
}
