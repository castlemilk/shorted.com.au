package shorts

// Handlers for the register DISCOVERY layer (docs/feature/politicians/
// explorer-ui.md §7).
//
// The ask these serve is anomaly-findability, and the editorial rules forbid
// labelling a named member's interests anomalous. So the design is neutral
// surfaces where an unusual pattern becomes a FINDABLE FACT: counts, dates and
// juxtapositions, with the inference left entirely to the reader.
//
// Concretely, that means:
//
//   - "most active" is a count ordering and is the strongest characterisation
//     permitted beside a named member. No response here has a field that could
//     carry "unusual", "spike", "risk", "watch" or a flag, and none may gain one.
//   - every measure is DATED-ONLY, on the same event definition as the changes
//     feed, and the rows that discipline excludes are counted and published
//     (undated_current_count) instead of being silently absent.
//   - the short percentage on a distinctive holding is THE COMPANY's ASIC
//     figure. It rides with the same mandatory disclosure the overlap rpc
//     serves, because a member's name beside a short figure is exactly the
//     juxtaposition editorial rule 2 governs.

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// registerActivityWindows are the only windows this surface serves. A request
// between two of them rounds UP (see clampRegisterActivityWindow) so a caller
// never gets less than it asked for, and the cache key set stays four wide.
var registerActivityWindows = []int32{30, 90, 180, 365}

// clampRegisterActivityWindow normalises the window BEFORE the cache key is
// built. The store clamps again — a store method is its own entry point — and
// both use the same rule, so the key and the query can never disagree.
func clampRegisterActivityWindow(windowDays int32) int32 {
	if windowDays <= 0 {
		return 90
	}
	for _, window := range registerActivityWindows {
		if windowDays <= window {
			return window
		}
	}
	return registerActivityWindows[len(registerActivityWindows)-1]
}

func weeklyEventCountProto(r *shortsstore.WeeklyEventCountRow) *shortsv1alpha1.WeeklyEventCount {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.WeeklyEventCount{
		WeekStart: r.WeekStart, AddedCount: r.AddedCount, RemovedCount: r.RemovedCount,
	}
}

func activeMemberProto(r *shortsstore.ActiveMemberRow) *shortsv1alpha1.ActiveMember {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.ActiveMember{
		Slug: r.Slug, DisplayName: r.DisplayName, PartyAb: r.PartyAb,
		Chamber: r.Chamber, Division: r.Division, EventCount: r.EventCount,
	}
}

func newlyDeclaredCompanyProto(r *shortsstore.NewlyDeclaredCompanyRow) *shortsv1alpha1.NewlyDeclaredCompany {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.NewlyDeclaredCompany{
		StockCode: r.StockCode, CompanyName: r.CompanyName, Industry: r.Industry,
		FirstDeclaredOn: r.FirstDeclaredOn, DeclarerCount: r.DeclarerCount,
	}
}

func declarerCountChangeProto(r *shortsstore.DeclarerCountChangeRow) *shortsv1alpha1.DeclarerCountChange {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.DeclarerCountChange{
		StockCode: r.StockCode, CompanyName: r.CompanyName, Industry: r.Industry,
		DeclarersNow: r.DeclarersNow, DeclarersAtWindowStart: r.DeclarersAtWindowStart,
	}
}

func registerActivityProto(r *shortsstore.RegisterActivityRow) *shortsv1alpha1.GetRegisterActivityResponse {
	if r == nil {
		return nil
	}
	out := &shortsv1alpha1.GetRegisterActivityResponse{
		WindowDays:          r.WindowDays,
		UndatedCurrentCount: r.UndatedCurrentCount,
		AsAt:                registerTimestamp(r.AsAt),
		SourceLicence:       registerLicence,
	}
	for _, week := range r.Weeks {
		out.Weeks = append(out.Weeks, weeklyEventCountProto(week))
	}
	for _, member := range r.ActiveMembers {
		out.ActiveMembers = append(out.ActiveMembers, activeMemberProto(member))
	}
	for _, company := range r.NewlyDeclaredCompanies {
		out.NewlyDeclaredCompanies = append(out.NewlyDeclaredCompanies, newlyDeclaredCompanyProto(company))
	}
	for _, change := range r.DeclarerCountChanges {
		out.DeclarerCountChanges = append(out.DeclarerCountChanges, declarerCountChangeProto(change))
	}
	return out
}

func distinctiveHoldingProto(r *shortsstore.DistinctiveHoldingRow) *shortsv1alpha1.DistinctiveHolding {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.DistinctiveHolding{
		StockCode: r.StockCode, CompanyName: r.CompanyName, Industry: r.Industry,
		Holder:            registerHolderProto(r.Holder),
		CurrentlyDeclared: r.CurrentlyDeclared,
		// The count IS the fact. Nothing derives a rarity measure from it here
		// or anywhere downstream; a consumer renders "declared by N members".
		CorpusDeclarerCount: r.CorpusDeclarerCount,
		ShortPercent:        r.ShortPercent,
	}
}

func distinctiveHoldingsProto(r *shortsstore.DistinctiveHoldingsRow) *shortsv1alpha1.ListDistinctiveHoldingsResponse {
	if r == nil {
		return nil
	}
	out := &shortsv1alpha1.ListDistinctiveHoldingsResponse{
		CanonicalSlug: r.CanonicalSlug,
		MoreCount:     r.MoreCount,
		AsAt:          registerTimestamp(r.AsAt),
		SourceLicence: registerLicence,
	}
	for _, holding := range r.Holdings {
		out.Holdings = append(out.Holdings, distinctiveHoldingProto(holding))
		// Served WITH the data the moment any short figure appears, not left to
		// the consumer to remember. Absent when no row carries one, so the
		// caveat never appears without the thing it is caveating.
		if holding.ShortPercent > 0 {
			out.DisclosureNote = shortInterestDisclosure
		}
	}
	return out
}

// GetRegisterActivity serves the activity explorer's rails.
//
// COUNTS AND DATES ONLY, and the rails are ordered by counts. Nothing here
// scores, ranks by anything other than a count, or characterises a member — the
// closest this comes is "most events in the window", which is the same class of
// claim as "most-declared companies" and is why the ordering is safe to publish.
func (s *ShortsServer) GetRegisterActivity(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetRegisterActivityRequest],
) (*connect.Response[shortsv1alpha1.GetRegisterActivityResponse], error) {
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetRegisterActivityResponse{}), nil
	}

	windowDays := clampRegisterActivityWindow(req.Msg.WindowDays)
	cached, err := s.cache.GetOrSet(s.cache.GetRegisterActivityKey(windowDays), func() (interface{}, error) {
		row, err := s.store.GetRegisterActivity(windowDays)
		if err != nil {
			return nil, err
		}
		out := registerActivityProto(row)
		if out == nil {
			out = &shortsv1alpha1.GetRegisterActivityResponse{
				WindowDays: windowDays, SourceLicence: registerLicence,
			}
		}
		// An empty window still states which register it is empty of, and with
		// the register's own as-at (the newest lodgement we hold), never our
		// snapshot-rebuild clock.
		if out.AsAt == nil {
			overview, err := s.store.GetRegisterOverview()
			if err != nil {
				return nil, err
			}
			if overview != nil {
				out.AsAt = registerTimestamp(overview.AsAt)
			}
		}
		return out, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetRegisterActivity: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load register activity"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetRegisterActivityResponse)), nil
}

// ListDistinctiveHoldings serves one member's currently-declared companies with
// the corpus-wide count of members declaring each.
//
// The rail this feeds is captioned "declared by no other member" for a count of
// one — a statement of fact about the register, not a label on the member.
// Nothing in the response says distinctive, unusual or rare.
func (s *ShortsServer) ListDistinctiveHoldings(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListDistinctiveHoldingsRequest],
) (*connect.Response[shortsv1alpha1.ListDistinctiveHoldingsResponse], error) {
	// Lower-cased and trimmed IS the canonical form: slugs are minted once
	// server-side and never reassigned, and the store echoes back the stored
	// slug so a consumer can redirect exactly as GetPolitician's does.
	slug := strings.ToLower(strings.TrimSpace(req.Msg.Slug))
	if slug == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("slug is required"))
	}
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListDistinctiveHoldingsResponse{}), nil
	}

	cached, err := s.cache.GetOrSet(s.cache.ListDistinctiveHoldingsKey(slug), func() (interface{}, error) {
		row, err := s.store.ListDistinctiveHoldings(slug)
		if err != nil {
			return nil, err
		}
		return distinctiveHoldingsProto(row), nil
	})
	if err != nil {
		if isNoRows(err) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("politician not found"))
		}
		s.logger.Errorf("database error in ListDistinctiveHoldings: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load distinctive holdings"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListDistinctiveHoldingsResponse)), nil
}
