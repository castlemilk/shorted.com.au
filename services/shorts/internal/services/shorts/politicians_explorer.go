package shorts

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func politicianTermProto(r *shortsstore.PoliticianTermRow) *shortsv1alpha1.PoliticianTerm {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.PoliticianTerm{
		Parliament: r.Parliament,
		Chamber:    r.Chamber,
		Division:   r.Division,
		StateCode:  r.StateCode,
		Party:      r.Party,
		PartyAb:    r.PartyAb,
	}
}

func registerItemCountProto(r *shortsstore.RegisterItemCountRow) *shortsv1alpha1.RegisterItemCount {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.RegisterItemCount{
		ItemNo:          r.ItemNo,
		ItemLabel:       r.ItemLabel,
		CurrentCount:    r.CurrentCount,
		PoliticianCount: r.PoliticianCount,
		AllTimeCount:    r.AllTimeCount,
	}
}

func registerHolderCountProto(r *shortsstore.RegisterHolderCountRow) *shortsv1alpha1.RegisterHolderCount {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.RegisterHolderCount{
		Holder:       registerHolderProto(r.Holder),
		CurrentCount: r.CurrentCount,
	}
}

func registerMonthlyCountProto(r *shortsstore.RegisterMonthlyCountRow) *shortsv1alpha1.RegisterMonthlyCount {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.RegisterMonthlyCount{Month: r.Month, DeclaredCount: r.DeclaredCount}
}

func registerIndustryTrendProto(r *shortsstore.RegisterIndustryTrendRow) *shortsv1alpha1.RegisterIndustryTrend {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.RegisterIndustryTrend{Industry: r.Industry, CurrentCount: r.CurrentCount, Count_90DAgo: r.Count90dAgo}
}

func registerIndustryCountProto(r *shortsstore.RegisterIndustryCountRow) *shortsv1alpha1.RegisterIndustryCount {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.RegisterIndustryCount{Industry: r.Industry, CompanyCount: r.CompanyCount}
}

func registerSourceDocumentProto(r *shortsstore.RegisterSourceDocumentRow) *shortsv1alpha1.RegisterSourceDocument {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.RegisterSourceDocument{
		Label: r.Label, SourceUrl: r.SourceURL, Parliament: r.Parliament, Chamber: r.Chamber,
	}
}

func registerChangeEventProto(r *shortsstore.RegisterChangeRow) *shortsv1alpha1.RegisterChangeEvent {
	if r == nil {
		return nil
	}
	return &shortsv1alpha1.RegisterChangeEvent{
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
		EntityKind:   r.EntityKind,
	}
}

func politicianSummaryProto(r *shortsstore.PoliticianSummaryRow) *shortsv1alpha1.PoliticianSummary {
	if r == nil {
		return nil
	}
	out := &shortsv1alpha1.PoliticianSummary{
		Politician:           politicianProto(r.Politician),
		DistinctCompanyCount: r.DistinctCompanyCount,
		PropertyCount:        r.PropertyCount,
		GiftsTravelCount:     r.GiftsTravelCount,
		LiabilityCount:       r.LiabilityCount,
		Changes_90D:          r.Changes90d,
		UndatedCount:         r.UndatedCount,
	}
	for _, item := range r.ItemCounts {
		out.ItemCounts = append(out.ItemCounts, registerItemCountProto(item))
	}
	for _, point := range r.Trend {
		out.Trend = append(out.Trend, registerMonthlyCountProto(point))
	}
	return out
}

func politicianExplorerProfileProto(r *shortsstore.PoliticianExplorerProfileRow) *shortsv1alpha1.GetPoliticianExplorerProfileResponse {
	if r == nil {
		return nil
	}
	out := &shortsv1alpha1.GetPoliticianExplorerProfileResponse{
		Politician:    politicianProto(r.Politician),
		CanonicalSlug: r.CanonicalSlug,
		UndatedCount:  r.UndatedCount,
		AsAt:          registerTimestamp(r.AsAt),
		SourceLicence: registerLicence,
	}
	for _, term := range r.Terms {
		out.Terms = append(out.Terms, politicianTermProto(term))
	}
	for _, item := range r.ItemCounts {
		out.ItemCounts = append(out.ItemCounts, registerItemCountProto(item))
	}
	for _, holder := range r.HolderCounts {
		out.HolderCounts = append(out.HolderCounts, registerHolderCountProto(holder))
	}
	for _, industry := range r.IndustryCounts {
		out.IndustryCounts = append(out.IndustryCounts, registerIndustryCountProto(industry))
	}
	for _, point := range r.Timeline {
		out.Timeline = append(out.Timeline, registerMonthlyCountProto(point))
	}
	for _, change := range r.RecentChanges {
		out.RecentChanges = append(out.RecentChanges, registerChangeEventProto(change))
	}
	for _, document := range r.SourceDocuments {
		out.SourceDocuments = append(out.SourceDocuments, registerSourceDocumentProto(document))
	}
	out.ExtractedParliaments = append(out.ExtractedParliaments, r.ExtractedParliaments...)
	out.PartialParliaments = append(out.PartialParliaments, r.PartialParliaments...)
	out.PendingParliaments = append(out.PendingParliaments, r.PendingParliaments...)
	return out
}

func comparePoliticiansProto(r *shortsstore.PoliticianComparisonRow) *shortsv1alpha1.ComparePoliticiansResponse {
	if r == nil {
		return nil
	}
	out := &shortsv1alpha1.ComparePoliticiansResponse{
		A:             politicianSummaryProto(r.SummaryA),
		B:             politicianSummaryProto(r.SummaryB),
		OnlyAMore:     r.OnlyAMore,
		OnlyBMore:     r.OnlyBMore,
		AsAt:          registerTimestamp(r.AsAt),
		SourceLicence: registerLicence,
	}
	for _, holder := range r.HolderCountsA {
		out.HolderCountsA = append(out.HolderCountsA, registerHolderCountProto(holder))
	}
	for _, holder := range r.HolderCountsB {
		out.HolderCountsB = append(out.HolderCountsB, registerHolderCountProto(holder))
	}
	for _, company := range r.SharedCompanies {
		shared := &shortsv1alpha1.SharedDeclaredCompany{
			StockCode: company.StockCode, CompanyName: company.CompanyName, Industry: company.Industry,
			CurrentlyDeclaredA: company.CurrentlyDeclaredA, CurrentlyDeclaredB: company.CurrentlyDeclaredB,
		}
		for _, holder := range company.HoldersA {
			shared.HoldersA = append(shared.HoldersA, registerHolderProto(holder))
		}
		for _, holder := range company.HoldersB {
			shared.HoldersB = append(shared.HoldersB, registerHolderProto(holder))
		}
		out.SharedCompanies = append(out.SharedCompanies, shared)
	}
	for _, company := range r.OnlyCompaniesA {
		out.OnlyACompanies = append(out.OnlyACompanies, politicianOnlyCompanyProto(company))
	}
	for _, company := range r.OnlyCompaniesB {
		out.OnlyBCompanies = append(out.OnlyBCompanies, politicianOnlyCompanyProto(company))
	}
	out.ExtractedParliamentsA = append(out.ExtractedParliamentsA, r.ExtractedParliamentsA...)
	out.PartialParliamentsA = append(out.PartialParliamentsA, r.PartialParliamentsA...)
	out.PendingParliamentsA = append(out.PendingParliamentsA, r.PendingParliamentsA...)
	out.ExtractedParliamentsB = append(out.ExtractedParliamentsB, r.ExtractedParliamentsB...)
	out.PartialParliamentsB = append(out.PartialParliamentsB, r.PartialParliamentsB...)
	out.PendingParliamentsB = append(out.PendingParliamentsB, r.PendingParliamentsB...)
	return out
}

func politicianOnlyCompanyProto(r *shortsstore.PoliticianOnlyCompanyRow) *shortsv1alpha1.PoliticianOnlyCompany {
	if r == nil {
		return nil
	}
	out := &shortsv1alpha1.PoliticianOnlyCompany{
		StockCode: r.StockCode, CompanyName: r.CompanyName, Industry: r.Industry,
		CurrentlyDeclared: r.CurrentlyDeclared,
	}
	for _, holder := range r.Holders {
		out.Holders = append(out.Holders, registerHolderProto(holder))
	}
	return out
}

func politicianSummarySortString(sort shortsv1alpha1.PoliticianSummarySort) string {
	switch sort {
	case shortsv1alpha1.PoliticianSummarySort_POLITICIAN_SUMMARY_SORT_COMPANIES:
		return "companies"
	case shortsv1alpha1.PoliticianSummarySort_POLITICIAN_SUMMARY_SORT_PROPERTIES:
		return "properties"
	case shortsv1alpha1.PoliticianSummarySort_POLITICIAN_SUMMARY_SORT_RECENT_CHANGES:
		return "recent_changes"
	case shortsv1alpha1.PoliticianSummarySort_POLITICIAN_SUMMARY_SORT_NAME:
		return "name"
	default:
		return "declared_items"
	}
}

func (s *ShortsServer) GetRegisterExplorer(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetRegisterExplorerRequest],
) (*connect.Response[shortsv1alpha1.GetRegisterExplorerResponse], error) {
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetRegisterExplorerResponse{}), nil
	}
	cached, err := s.cache.GetOrSet(s.cache.GetRegisterExplorerKey(), func() (interface{}, error) {
		row, err := s.store.GetRegisterExplorer()
		if err != nil {
			return nil, err
		}
		out := &shortsv1alpha1.GetRegisterExplorerResponse{
			Changes_7D: row.Changes7d, MembersChanged_7D: row.MembersChanged7d,
			Changes_30D: row.Changes30d, MembersChanged_30D: row.MembersChanged30d,
			CurrentDeclaredCount: row.CurrentDeclaredCount,
			DistinctCompanyCount: row.DistinctCompanyCount, PropertyCount: row.PropertyCount,
			GiftsTravelCount: row.GiftsTravelCount, LiabilityCount: row.LiabilityCount,
			AsAt: registerTimestamp(row.AsAt), SourceLicence: registerLicence,
		}
		if row.Overview != nil {
			out.PoliticianCount = row.Overview.PoliticianCount
			out.StatementCount = row.Overview.StatementCount
			out.DeclaredRowCount = row.Overview.DeclaredRowCount
			out.ResolvedListedCount = row.Overview.ResolvedListedCount
			out.ResolvedSuburbCount = row.Overview.ResolvedSuburbCount
			out.FirstParliament = row.Overview.FirstParliament
			out.LastParliament = row.Overview.LastParliament
			if out.AsAt == nil {
				out.AsAt = registerTimestamp(row.Overview.RefreshedAt)
			}
		}
		for _, item := range row.ItemCounts {
			out.ItemCounts = append(out.ItemCounts, registerItemCountProto(item))
		}
		for _, holder := range row.HolderCounts {
			out.HolderCounts = append(out.HolderCounts, registerHolderCountProto(holder))
		}
		for _, trend := range row.IndustryTrends {
			out.IndustryTrends = append(out.IndustryTrends, registerIndustryTrendProto(trend))
		}
		out.ExtractedParliaments = append(out.ExtractedParliaments, row.ExtractedParliaments...)
		out.PartialParliaments = append(out.PartialParliaments, row.PartialParliaments...)
		out.PendingParliaments = append(out.PendingParliaments, row.PendingParliaments...)
		return out, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetRegisterExplorer: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load register explorer"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetRegisterExplorerResponse)), nil
}

func (s *ShortsServer) ListPoliticianSummaries(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListPoliticianSummariesRequest],
) (*connect.Response[shortsv1alpha1.ListPoliticianSummariesResponse], error) {
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListPoliticianSummariesResponse{}), nil
	}
	m := req.Msg
	chamber := strings.ToLower(strings.TrimSpace(m.Chamber))
	state := strings.ToUpper(strings.TrimSpace(m.StateCode))
	party := strings.ToUpper(strings.TrimSpace(m.PartyAb))
	itemNo := m.ItemNo
	if itemNo < 1 || itemNo > 14 {
		itemNo = 0
	}
	query := strings.TrimSpace(m.Query)
	sortKey := politicianSummarySortString(m.Sort)
	limit := clampLimit(m.Limit, 50, 200)
	offset := max32(m.Offset, 0)

	cached, err := s.cache.GetOrSet(
		s.cache.ListPoliticianSummariesKey(chamber, state, party, itemNo, query, sortKey, limit, offset),
		func() (interface{}, error) {
			rows, total, err := s.store.ListPoliticianSummaries(chamber, state, party, itemNo, query, sortKey, limit, offset)
			if err != nil {
				return nil, err
			}
			out := &shortsv1alpha1.ListPoliticianSummariesResponse{Total: total, SourceLicence: registerLicence}
			for _, row := range rows {
				out.Summaries = append(out.Summaries, politicianSummaryProto(row))
				if out.AsAt == nil {
					out.AsAt = registerTimestamp(row.AsAt)
				}
			}
			if len(out.Summaries) == 0 {
				overview, err := s.store.GetRegisterOverview()
				if err != nil {
					return nil, err
				}
				if overview != nil {
					out.AsAt = registerTimestamp(overview.RefreshedAt)
				}
			}
			return out, nil
		})
	if err != nil {
		s.logger.Errorf("database error in ListPoliticianSummaries: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list politician summaries"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListPoliticianSummariesResponse)), nil
}

func (s *ShortsServer) GetPoliticianExplorerProfile(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetPoliticianExplorerProfileRequest],
) (*connect.Response[shortsv1alpha1.GetPoliticianExplorerProfileResponse], error) {
	slug := strings.ToLower(strings.TrimSpace(req.Msg.Slug))
	if slug == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("slug is required"))
	}
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetPoliticianExplorerProfileResponse{}), nil
	}
	topIndustries := clampLimit(req.Msg.TopIndustries, 5, 20)
	cached, err := s.cache.GetOrSet(s.cache.GetPoliticianExplorerProfileKey(slug, topIndustries), func() (interface{}, error) {
		row, err := s.store.GetPoliticianExplorerProfile(slug, topIndustries)
		if err != nil {
			return nil, err
		}
		return politicianExplorerProfileProto(row), nil
	})
	if err != nil {
		if isNoRows(err) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("politician not found"))
		}
		s.logger.Errorf("database error in GetPoliticianExplorerProfile: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load politician explorer profile"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetPoliticianExplorerProfileResponse)), nil
}

func (s *ShortsServer) ComparePoliticians(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ComparePoliticiansRequest],
) (*connect.Response[shortsv1alpha1.ComparePoliticiansResponse], error) {
	// Lower-cased and trimmed IS the canonical form here: slugs are minted once
	// server-side and never reassigned, and a merged-away person has no live row
	// to resolve to (the store filters merged_into_id, so that slug 404s).
	slugA := strings.ToLower(strings.TrimSpace(req.Msg.SlugA))
	slugB := strings.ToLower(strings.TrimSpace(req.Msg.SlugB))
	if slugA == "" || slugB == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("both politician slugs are required"))
	}
	// A member compared with themself is not a degenerate-but-harmless query, it
	// is a WRONG ANSWER: the side-attribution keys on `count(DISTINCT slug) = 2`,
	// so with one slug on both sides every holding lands in only_a and the page
	// reports that the member shares nothing with themself while listing their
	// own holdings as the difference. Refuse it rather than render it.
	if slugA == slugB {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("slug_a and slug_b must be different politicians"))
	}
	if !registerEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ComparePoliticiansResponse{}), nil
	}
	cached, err := s.cache.GetOrSet(s.cache.ComparePoliticiansKey(slugA, slugB), func() (interface{}, error) {
		row, err := s.store.ComparePoliticians(slugA, slugB)
		if err != nil {
			return nil, err
		}
		return comparePoliticiansProto(row), nil
	})
	if err != nil {
		if isNoRows(err) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("politician not found"))
		}
		s.logger.Errorf("database error in ComparePoliticians: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to compare politicians"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ComparePoliticiansResponse)), nil
}
