package shorts

// Handlers for the Registers of Members' and Senators' Interests.
//
// EDITORIAL (docs/influence-editorial-standards.md): the registers disclose WHAT
// is held, never quantity or value. Nothing here computes, infers or exposes a
// holding's size, and every response carries the licence attribution the source
// requires so a consumer cannot render the data unattributed.
//
// THE GATE IS FOUR LAYERS, deliberately. The 2026-07 audit found the housing
// licence gate leaking on the one read path that trusted its upstream:
//
//  1. register_item_securities_public_gate CHECK — a fuzzy match can never be
//     'resolved' at all
//  2. mv_register_public_holdings — only identity-resolved people, only cleanly
//     extracted documents
//  3. the store queries re-assert stock_code IS NOT NULL rather than trusting (2)
//  4. registerEnabled() here, a kill switch returning EMPTY rather than an error

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// registerLicence is served with every response.
const registerLicence = "Parliamentary material; (c) Commonwealth of Australia"

// shortInterestDisclosure is served WITH the short-overlap data, not left to the
// consumer to remember. The percentage describes the company; the registers
// record no quantities, so it can say nothing about anyone's holding.
const shortInterestDisclosure = "Short interest is a market-wide ASIC figure for the company. " +
	"The registers record what is held, never quantity or value, so this says nothing about " +
	"any member's holding, its size, or any gain or loss."

// registerEnabled is the kill switch. Enabled by DEFAULT — no opt-in env is
// needed to ship. Set POLITICIAN_INTERESTS_ENABLED to a falsey value only to take
// the surface down (e.g. a takedown request or a data dispute).
func registerEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("POLITICIAN_INTERESTS_ENABLED"))) {
	case "false", "0", "off", "no":
		return false
	default:
		return true
	}
}

// ---------------------------------------------------------------------------
// Proto mappers
// ---------------------------------------------------------------------------

func registerHolderProto(holder string) shortsv1alpha1.RegisterHolder {
	switch holder {
	case "self":
		return shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_SELF
	case "spouse_partner":
		return shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_SPOUSE_PARTNER
	case "dependent_children":
		return shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_DEPENDENT_CHILDREN
	default:
		return shortsv1alpha1.RegisterHolder_REGISTER_HOLDER_UNSPECIFIED
	}
}

func registerChangeKindProto(kind string) shortsv1alpha1.RegisterChangeKind {
	switch kind {
	case "added":
		return shortsv1alpha1.RegisterChangeKind_REGISTER_CHANGE_KIND_ADDED
	case "removed":
		return shortsv1alpha1.RegisterChangeKind_REGISTER_CHANGE_KIND_REMOVED
	default:
		return shortsv1alpha1.RegisterChangeKind_REGISTER_CHANGE_KIND_UNSPECIFIED
	}
}

func registerChangeKindString(kind shortsv1alpha1.RegisterChangeKind) string {
	switch kind {
	case shortsv1alpha1.RegisterChangeKind_REGISTER_CHANGE_KIND_ADDED:
		return "added"
	case shortsv1alpha1.RegisterChangeKind_REGISTER_CHANGE_KIND_REMOVED:
		return "removed"
	default:
		return ""
	}
}

// registerTimestamp guards against the zero time becoming a 1-Jan-1 date on the
// wire, which a consumer would render as a real (and very wrong) date.
func registerTimestamp(t time.Time) *timestamppb.Timestamp {
	if t.IsZero() || t.Year() <= 1 {
		return nil
	}
	return timestamppb.New(t)
}

func politicianProto(r *shortsstore.PoliticianRow) *shortsv1alpha1.Politician {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.Politician{
		Slug:                  r.Slug,
		DisplayName:           r.DisplayName,
		Surname:               r.Surname,
		GivenNames:            r.GivenNames,
		Honorific:             r.Honorific,
		Chamber:               r.Chamber,
		Division:              r.Division,
		StateCode:             r.StateCode,
		Party:                 r.Party,
		PartyAb:               r.PartyAb,
		FirstParliament:       r.FirstParliament,
		LastParliament:        r.LastParliament,
		AphMpid:               r.APHMPID,
		DeclaredListedCount:   r.DeclaredListedCount,
		DeclaredPropertyCount: r.DeclaredPropertyCount,
	}
}

func declaredInterestProto(r *shortsstore.DeclaredInterestRow) *shortsv1alpha1.DeclaredInterest {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.DeclaredInterest{
		ItemNo:            r.ItemNo,
		ItemLabel:         r.ItemLabel,
		Holder:            registerHolderProto(r.Holder),
		DeclaredText:      r.DeclaredText,
		SecondaryText:     attributableSecondaryText(r.ItemNo, r.SecondaryText),
		StockCode:         r.StockCode,
		CompanyName:       r.CompanyName,
		Industry:          r.Industry,
		SalCode:           r.SalCode,
		SuburbName:        r.SuburbName,
		PropertyState:     r.PropertyState,
		MatchMethod:       r.MatchMethod,
		DeclaredFrom:      registerTimestamp(r.DeclaredFrom),
		DeclaredFromKnown: r.DeclaredFromKnown,
		DeclaredTo:        registerTimestamp(r.DeclaredTo),
		CurrentlyDeclared: r.CurrentlyDeclared,
		SourceUrl:         r.SourceURL,
		SourceLicence:     firstNonBlank(r.SourceLicence, registerLicence),
	}
}

func partyCountsProto(rows []*shortsstore.PartyCountRow) []*shortsv1alpha1.PartyCount {
	out := make([]*shortsv1alpha1.PartyCount, 0, len(rows))
	for _, r := range rows {
		out = append(out, &shortsv1alpha1.PartyCount{
			PartyAb:         r.PartyAb,
			Party:           r.Party,
			PoliticianCount: r.PoliticianCount,
		})
	}
	return out
}

func stockRollupProto(r *shortsstore.PoliticianStockRollupRow) *shortsv1alpha1.PoliticianStockRollup {
	return &shortsv1alpha1.PoliticianStockRollup{
		StockCode:       r.StockCode,
		CompanyName:     r.CompanyName,
		Industry:        r.Industry,
		PoliticianCount: r.PoliticianCount,
		PartyCounts:     partyCountsProto(r.PartyCounts),
		ShortPercent:    r.ShortPercent,
	}
}

func firstNonBlank(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// clampLimit normalises a limit BEFORE it reaches the cache key, so the key can
// never diverge from the query that produced the cached value.
func clampLimit(requested, def, max int32) int32 {
	if requested <= 0 {
		return def
	}
	if requested > max {
		return max
	}
	return requested
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func (s *ShortsServer) GetParliamentOverview(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetParliamentOverviewRequest],
) (*connect.Response[shortsv1alpha1.GetParliamentOverviewResponse], error) {
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetParliamentOverviewResponse{}), nil
	}

	cached, err := s.cache.GetOrSet(s.cache.ParliamentOverviewKey(), func() (interface{}, error) {
		row, err := s.store.GetRegisterOverview()
		if err != nil {
			return nil, err
		}
		return &shortsv1alpha1.GetParliamentOverviewResponse{
			PoliticianCount:     row.PoliticianCount,
			StatementCount:      row.StatementCount,
			DeclaredRowCount:    row.DeclaredRowCount,
			ResolvedListedCount: row.ResolvedListedCount,
			ResolvedSuburbCount: row.ResolvedSuburbCount,
			FirstParliament:     row.FirstParliament,
			LastParliament:      row.LastParliament,
			AsAt:                registerTimestamp(row.AsAt),
			RefreshedAt:         registerTimestamp(row.RefreshedAt),
			SourceLicence:       registerLicence,
		}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetParliamentOverview: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load parliament overview"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetParliamentOverviewResponse)), nil
}

func (s *ShortsServer) ListPoliticians(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListPoliticiansRequest],
) (*connect.Response[shortsv1alpha1.ListPoliticiansResponse], error) {
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListPoliticiansResponse{}), nil
	}

	m := req.Msg
	chamber := strings.ToLower(strings.TrimSpace(m.Chamber))
	state := strings.ToUpper(strings.TrimSpace(m.StateCode))
	party := strings.ToUpper(strings.TrimSpace(m.PartyAb))
	query := strings.TrimSpace(m.Query)
	limit := clampLimit(m.Limit, 100, 500)
	offset := max32(m.Offset, 0)

	cached, err := s.cache.GetOrSet(
		s.cache.ListPoliticiansKey(chamber, state, party, query, limit, offset),
		func() (interface{}, error) {
			rows, total, err := s.store.ListPoliticians(chamber, state, party, query, limit, offset)
			if err != nil {
				return nil, err
			}
			out := make([]*shortsv1alpha1.Politician, 0, len(rows))
			for _, r := range rows {
				out = append(out, politicianProto(r))
			}
			return &shortsv1alpha1.ListPoliticiansResponse{Politicians: out, Total: total}, nil
		})
	if err != nil {
		s.logger.Errorf("database error in ListPoliticians: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list politicians"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListPoliticiansResponse)), nil
}

func (s *ShortsServer) GetPolitician(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetPoliticianRequest],
) (*connect.Response[shortsv1alpha1.GetPoliticianResponse], error) {
	slug := strings.ToLower(strings.TrimSpace(req.Msg.Slug))
	if slug == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("slug is required"))
	}
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetPoliticianResponse{}), nil
	}

	cached, err := s.cache.GetOrSet(s.cache.GetPoliticianKey(slug), func() (interface{}, error) {
		row, interests, represented, err := s.store.GetPolitician(slug)
		if err != nil {
			return nil, err
		}
		out := &shortsv1alpha1.GetPoliticianResponse{
			Politician: politicianProto(row),
			// The web tier redirects when this differs from the requested slug.
			// Slugs are minted once server-side and never derived by consumers.
			CanonicalSlug:      row.Slug,
			RepresentedSuburbs: represented,
			// Served ALWAYS, not just when interests is empty: a consumer needs
			// to know the corpus boundary to caption a short list as well as an
			// absent one.
			ExtractedParliaments: row.ExtractedParliaments,
			PartialParliaments:   row.PartialParliaments,
			PendingParliaments:   row.PendingParliaments,
		}
		for _, i := range interests {
			out.Interests = append(out.Interests, declaredInterestProto(i))
		}
		return out, nil
	})
	if err != nil {
		if isNoRows(err) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("politician not found"))
		}
		s.logger.Errorf("database error in GetPolitician: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load politician"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetPoliticianResponse)), nil
}

func (s *ShortsServer) ListStockPoliticians(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListStockPoliticiansRequest],
) (*connect.Response[shortsv1alpha1.ListStockPoliticiansResponse], error) {
	code := strings.ToUpper(strings.TrimSpace(req.Msg.StockCode))
	if code == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_code is required"))
	}
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListStockPoliticiansResponse{}), nil
	}

	currentOnly := req.Msg.CurrentOnly
	cached, err := s.cache.GetOrSet(
		s.cache.ListStockPoliticiansKey(code, currentOnly),
		func() (interface{}, error) {
			company, people, interests, parties, err := s.store.ListStockPoliticians(code, currentOnly)
			if err != nil {
				return nil, err
			}
			out := &shortsv1alpha1.ListStockPoliticiansResponse{
				StockCode:     code,
				CompanyName:   company,
				PartyCounts:   partyCountsProto(parties),
				SourceLicence: registerLicence,
			}
			seen := map[string]bool{}
			for i := range people {
				out.Interests = append(out.Interests, &shortsv1alpha1.StockPoliticianInterest{
					Politician: politicianProto(people[i]),
					Interest:   declaredInterestProto(interests[i]),
				})
				seen[people[i].Slug] = true
			}
			// Count PEOPLE, not rows: one member declaring a company across three
			// statements is one member.
			out.PoliticianCount = int32(len(seen))
			return out, nil
		})
	if err != nil {
		s.logger.Errorf("database error in ListStockPoliticians: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list stock politicians"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListStockPoliticiansResponse)), nil
}

func (s *ShortsServer) ListPoliticianStocks(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListPoliticianStocksRequest],
) (*connect.Response[shortsv1alpha1.ListPoliticianStocksResponse], error) {
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListPoliticianStocksResponse{}), nil
	}

	limit := clampLimit(req.Msg.Limit, 50, 200)
	currentOnly := req.Msg.CurrentOnly

	cached, err := s.cache.GetOrSet(
		s.cache.ListPoliticianStocksKey(limit, currentOnly),
		func() (interface{}, error) {
			rows, err := s.store.ListPoliticianStocks(limit, currentOnly)
			if err != nil {
				return nil, err
			}
			out := &shortsv1alpha1.ListPoliticianStocksResponse{SourceLicence: registerLicence}
			for _, r := range rows {
				out.Stocks = append(out.Stocks, stockRollupProto(r))
			}
			return out, nil
		})
	if err != nil {
		s.logger.Errorf("database error in ListPoliticianStocks: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list politician stocks"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListPoliticianStocksResponse)), nil
}

func (s *ShortsServer) ListSuburbPoliticians(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListSuburbPoliticiansRequest],
) (*connect.Response[shortsv1alpha1.ListSuburbPoliticiansResponse], error) {
	salCode := strings.TrimSpace(req.Msg.SalCode)
	if salCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sal_code is required"))
	}
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListSuburbPoliticiansResponse{}), nil
	}

	cached, err := s.cache.GetOrSet(s.cache.ListSuburbPoliticiansKey(salCode), func() (interface{}, error) {
		suburb, state, people, interests, err := s.store.ListSuburbPoliticians(salCode)
		if err != nil {
			return nil, err
		}
		out := &shortsv1alpha1.ListSuburbPoliticiansResponse{
			SalCode:       salCode,
			SuburbName:    suburb,
			StateCode:     state,
			SourceLicence: registerLicence,
		}
		seen := map[string]bool{}
		for i := range people {
			out.Properties = append(out.Properties, &shortsv1alpha1.SuburbPoliticianProperty{
				Politician: politicianProto(people[i]),
				Interest:   declaredInterestProto(interests[i]),
			})
			seen[people[i].Slug] = true
		}
		out.DeclaringMemberCount = int32(len(seen))
		return out, nil
	})
	if err != nil {
		if isNoRows(err) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("suburb not found"))
		}
		s.logger.Errorf("database error in ListSuburbPoliticians: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list suburb politicians"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListSuburbPoliticiansResponse)), nil
}

func (s *ShortsServer) ListStatePoliticianHoldings(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListStatePoliticianHoldingsRequest],
) (*connect.Response[shortsv1alpha1.ListStatePoliticianHoldingsResponse], error) {
	state := strings.ToUpper(strings.TrimSpace(req.Msg.StateCode))
	if state == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("state_code is required"))
	}
	// Accepts a slug or a code; validated against the existing state vocabulary
	// so an arbitrary string cannot reach the query.
	if !shortsstore.IsValidStateSlug(strings.ToLower(state)) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unknown state %q", req.Msg.StateCode))
	}
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListStatePoliticianHoldingsResponse{}), nil
	}

	limit := clampLimit(req.Msg.Limit, 20, 100)
	cached, err := s.cache.GetOrSet(
		s.cache.ListStatePoliticianHoldingsKey(state, limit),
		func() (interface{}, error) {
			rows, people, err := s.store.ListStatePoliticianHoldings(state, limit)
			if err != nil {
				return nil, err
			}
			out := &shortsv1alpha1.ListStatePoliticianHoldingsResponse{
				StateCode:       state,
				PoliticianCount: people,
				SourceLicence:   registerLicence,
			}
			for _, r := range rows {
				out.Stocks = append(out.Stocks, stockRollupProto(r))
			}
			return out, nil
		})
	if err != nil {
		s.logger.Errorf("database error in ListStatePoliticianHoldings: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list state politician holdings"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListStatePoliticianHoldingsResponse)), nil
}

func (s *ShortsServer) ListRegisterChanges(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListRegisterChangesRequest],
) (*connect.Response[shortsv1alpha1.ListRegisterChangesResponse], error) {
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListRegisterChangesResponse{}), nil
	}

	m := req.Msg
	var since time.Time
	if m.Since != nil {
		since = m.Since.AsTime()
	}
	kind := registerChangeKindString(m.Kind)
	code := strings.ToUpper(strings.TrimSpace(m.StockCode))
	limit := clampLimit(m.Limit, 100, 500)
	offset := max32(m.Offset, 0)

	cached, err := s.cache.GetOrSet(
		s.cache.ListRegisterChangesKey(since, kind, code, limit, offset),
		func() (interface{}, error) {
			rows, total, err := s.store.ListRegisterChanges(since, kind, code, limit, offset)
			if err != nil {
				return nil, err
			}
			out := &shortsv1alpha1.ListRegisterChangesResponse{Total: total, SourceLicence: registerLicence}
			for _, r := range rows {
				out.Events = append(out.Events, &shortsv1alpha1.RegisterChangeEvent{
					Politician:   politicianProto(r.Politician),
					Kind:         registerChangeKindProto(r.Kind),
					ItemNo:       r.ItemNo,
					ItemLabel:    r.ItemLabel,
					Holder:       registerHolderProto(r.Holder),
					DeclaredText: r.DeclaredText,
					StockCode:    r.StockCode,
					CompanyName:  r.CompanyName,
					ChangedOn:    registerTimestamp(r.ChangedOn),
					SourceUrl:    r.SourceURL,
				})
			}
			return out, nil
		})
	if err != nil {
		s.logger.Errorf("database error in ListRegisterChanges: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list register changes"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListRegisterChangesResponse)), nil
}

func (s *ShortsServer) ListShortInterestOverlap(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListShortInterestOverlapRequest],
) (*connect.Response[shortsv1alpha1.ListShortInterestOverlapResponse], error) {
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListShortInterestOverlapResponse{}), nil
	}

	minPct := req.Msg.MinShortPercent
	if minPct <= 0 {
		minPct = 2.0
	}
	limit := clampLimit(req.Msg.Limit, 50, 200)

	cached, err := s.cache.GetOrSet(
		s.cache.ListShortInterestOverlapKey(minPct, limit),
		func() (interface{}, error) {
			rows, err := s.store.ListShortInterestOverlap(minPct, limit)
			if err != nil {
				return nil, err
			}
			// The caveat is served WITH the data, not left to the consumer to
			// remember: a member's name beside a rising short line is exactly the
			// juxtaposition editorial rule 2 governs.
			out := &shortsv1alpha1.ListShortInterestOverlapResponse{
				DisclosureNote: shortInterestDisclosure,
				SourceLicence:  registerLicence,
			}
			for _, r := range rows {
				out.Overlaps = append(out.Overlaps, &shortsv1alpha1.ShortInterestOverlap{
					StockCode:       r.StockCode,
					CompanyName:     r.CompanyName,
					Industry:        r.Industry,
					ShortPercent:    r.ShortPercent,
					PoliticianCount: r.PoliticianCount,
					PartyCounts:     partyCountsProto(r.PartyCounts),
				})
			}
			return out, nil
		})
	if err != nil {
		s.logger.Errorf("database error in ListShortInterestOverlap: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list short interest overlap"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListShortInterestOverlapResponse)), nil
}

// isNoRows distinguishes "this politician does not exist" (a 404) from a real
// database failure (a 500).
func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

func max32(a, b int32) int32 {
	if a > b {
		return a
	}
	return b
}
