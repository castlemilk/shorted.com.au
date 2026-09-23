package shorts

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// councilSlugPattern is the shape lga.slug is minted in (lowercase words joined
// by hyphens, an optional -<code> suffix). Anything else cannot name a council,
// so it is answered NotFound without a query.
var councilSlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

const councilSlugMaxLen = 96

// ListCouncils returns every council with a page in one state (kind council or
// unincorporated), with the rollups the council index and choropleth colour by.
//
// The price-drop share is derived from the ToS-restricted crawl, so it obeys
// the HOUSING_DROP_LISTINGS_ENABLED kill switch like every crawl-derived read
// (GetSuburbProfile's listing_stats, and every drops read once 000124's
// policy lands): off means it is stripped. The check runs OUTSIDE the cache so
// a flip takes effect on the next request, on a clone so the cached object is
// never mutated. See withoutCouncilDrops.
func (s *ShortsServer) ListCouncils(ctx context.Context, req *connect.Request[shortsv1alpha1.ListCouncilsRequest]) (*connect.Response[shortsv1alpha1.ListCouncilsResponse], error) {
	params, err := normalizeHousingParams(housingParams{stateCode: req.Msg.StateCode}, housingParamRules{requireState: true})
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	cached, err := s.cache.GetOrSet(s.cache.GetCouncilsKey(params.stateCode), func() (interface{}, error) {
		rows, err := s.store.ListCouncils(params.stateCode)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.CouncilSummary, 0, len(rows))
		for _, r := range rows {
			if r != nil {
				out = append(out, councilSummaryProto(r))
			}
		}
		resp := &shortsv1alpha1.ListCouncilsResponse{Councils: out, LgaVintage: shortsstore.CouncilLgaVintage}
		resp.PriceDropsAsOf, resp.PriceDropsDataThrough = councilDropsFreshness(rows)
		return resp, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListCouncils: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list councils"))
	}
	resp := cached.(*shortsv1alpha1.ListCouncilsResponse)
	if !dropListingsEnabled() {
		resp = withoutCouncilDropShares(resp)
	}
	return connect.NewResponse(resp), nil
}

// councilDropsFreshness is the response-level as_of / data_through for the
// councils' price-drop shares: the earliest computation time and the newest
// crawl observation behind any published share. Both nil without a share.
func councilDropsFreshness(rows []*shortsstore.CouncilSummaryRow) (asOf, dataThrough *timestamppb.Timestamp) {
	var earliest, newest time.Time
	for _, r := range rows {
		if r == nil || r.PriceDropShare == nil {
			continue
		}
		if r.PriceDropsAsOf != nil && (earliest.IsZero() || r.PriceDropsAsOf.Before(earliest)) {
			earliest = *r.PriceDropsAsOf
		}
		if r.PriceDropsDataThrough != nil && r.PriceDropsDataThrough.After(newest) {
			newest = *r.PriceDropsDataThrough
		}
	}
	if !earliest.IsZero() {
		asOf = timestamppb.New(earliest)
	}
	if !newest.IsZero() {
		dataThrough = timestamppb.New(newest)
	}
	return asOf, dataThrough
}

// withoutCouncilDropShares is the kill-switch view of a cached ListCouncils
// response: a clone with every crawl-derived field removed.
func withoutCouncilDropShares(resp *shortsv1alpha1.ListCouncilsResponse) *shortsv1alpha1.ListCouncilsResponse {
	stripped, _ := proto.Clone(resp).(*shortsv1alpha1.ListCouncilsResponse)
	stripped.PriceDropsAsOf, stripped.PriceDropsDataThrough = nil, nil
	for _, c := range stripped.Councils {
		c.PriceDropShare = nil
	}
	return stripped
}

// withoutCouncilDrops is the kill-switch view of a cached council profile.
func withoutCouncilDrops(resp *shortsv1alpha1.GetCouncilProfileResponse) *shortsv1alpha1.GetCouncilProfileResponse {
	stripped, _ := proto.Clone(resp).(*shortsv1alpha1.GetCouncilProfileResponse)
	if p := stripped.GetProfile(); p != nil {
		p.PriceDrops = nil
		if p.Summary != nil {
			p.Summary.PriceDropShare = nil
		}
	}
	return stripped
}

// normalizeCouncilSlug trims and lower-cases a slug. ok=false means it cannot
// be a council slug at all.
func normalizeCouncilSlug(raw string) (string, bool) {
	slug := strings.ToLower(strings.TrimSpace(raw))
	return slug, len(slug) <= councilSlugMaxLen && councilSlugPattern.MatchString(slug)
}

// GetCouncilProfile returns one council's hub: identity, facts, series, member
// suburbs, rollups, representation, price drops and neighbours.
func (s *ShortsServer) GetCouncilProfile(ctx context.Context, req *connect.Request[shortsv1alpha1.GetCouncilProfileRequest]) (*connect.Response[shortsv1alpha1.GetCouncilProfileResponse], error) {
	params, err := normalizeHousingParams(housingParams{stateCode: req.Msg.StateCode}, housingParamRules{requireState: true})
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	if strings.TrimSpace(req.Msg.Slug) == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("slug is required"))
	}
	slug, ok := normalizeCouncilSlug(req.Msg.Slug)
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("council not found"))
	}
	cached, err := s.cache.GetOrSet(s.cache.GetCouncilProfileKey(params.stateCode, slug), func() (interface{}, error) {
		row, err := s.store.GetCouncilProfile(params.stateCode, slug)
		if err != nil {
			return nil, err
		}
		return &shortsv1alpha1.GetCouncilProfileResponse{Profile: councilProfileProto(params.stateCode, row)}, nil
	})
	if err != nil {
		if errors.Is(err, shortsstore.ErrCouncilNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("council not found"))
		}
		s.logger.Errorf("database error in GetCouncilProfile: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get council profile"))
	}
	resp := cached.(*shortsv1alpha1.GetCouncilProfileResponse)
	if !dropListingsEnabled() {
		resp = withoutCouncilDrops(resp)
	}
	return connect.NewResponse(resp), nil
}

// roundTo keeps the precision the inputs support: shares from a Census-2021
// weighted bridge are not good to more than 0.1 percentage point.
func roundTo(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}

func roundedPtr(v *float64, places int) *float64 {
	if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) {
		return nil
	}
	r := roundTo(*v, places)
	return &r
}

func councilSummaryProto(r *shortsstore.CouncilSummaryRow) *shortsv1alpha1.CouncilSummary {
	out := &shortsv1alpha1.CouncilSummary{
		LgaCode: r.LgaCode, Slug: r.Slug, DisplayName: r.DisplayName, Kind: r.Kind, StateCode: r.StateCode,
		Population: r.Population, ErpYear: r.ErpYear,
		PopGrowthPct:      roundedPtr(r.PopGrowthPct, 2),
		AreaSqkm:          roundedPtr(r.AreaSqkm, 1),
		DensityPerSqkm:    roundedPtr(r.DensityPerSqkm, 1),
		MemberSuburbCount: r.MemberSuburbCount,
		FagPerResident:    roundedPtr(r.FagPerResident, 2),
		FagYear:           r.FagYear,
		ApprovalsPer_1000: roundedPtr(r.ApprovalsPer1000, 2),
		ApprovalsThrough:  r.ApprovalsThrough,
		SeifaIrsadDecile:  r.SeifaIrsadDecile,
		FloodSharePct:     roundedPtr(r.FloodSharePct, 1),
		BushfireSharePct:  roundedPtr(r.BushfireSharePct, 1),
		PriceDropShare:    roundedPtr(r.PriceDropShare, 3),
	}
	if r.HouseMedian != nil && r.HouseMedianPeriod != "" {
		out.CouncilHouseMedian, out.CouncilHouseMedianPeriod = r.HouseMedian, r.HouseMedianPeriod
	}
	if r.DataThrough != nil {
		out.DataThrough = r.DataThrough.Format("2006-01-02")
	}
	return out
}

// councilSeriesFrequency labels each lga_series measure's period grain.
func councilSeriesFrequency(measure string) string {
	switch {
	case measure == "erp":
		return "annual"
	case strings.HasPrefix(measure, "dwelling_approvals_") && measure != "dwelling_approvals_fy":
		return "monthly"
	default:
		return "fy"
	}
}

func councilProfileProto(stateCode string, p *shortsstore.CouncilProfileRow) *shortsv1alpha1.CouncilProfile {
	info := &shortsv1alpha1.LgaInfo{
		LgaCode: "", LgaName: p.LgaName, StateCode: stateCode, AreaSqkm: p.AreaSqkm,
		FedFagAud: p.FagAud, FedFagYear: p.FagYear,
		AvgRates: p.AvgRates, OpSurplusRatio: p.OpSurplusRatio, AssetRenewalRatio: p.AssetRenewalRatio,
		FinSource: p.FinSource, FinYear: p.FinYear,
	}
	out := &shortsv1alpha1.CouncilProfile{Council: info, LgaVintage: shortsstore.CouncilLgaVintage}
	if p.Summary != nil {
		info.LgaCode = p.Summary.LgaCode
		info.Population = p.Summary.Population
		out.Summary = councilSummaryProto(p.Summary)
	}
	attachCouncilFacts(info, &p.Facts)
	info.DominantShare = nil // a suburb fact; meaningless on the council itself
	if p.FactsAsOf != nil {
		out.FactsAsOf = p.FactsAsOf.UTC().Format("2006-01-02")
	}

	for _, sr := range p.Series {
		series := &shortsv1alpha1.CouncilSeries{
			Measure: sr.Measure, Unit: sr.Unit, Frequency: councilSeriesFrequency(sr.Measure),
			Source: sr.Source, SourceLicence: sr.SourceLicence,
		}
		for _, pt := range sr.Points {
			series.Points = append(series.Points, &shortsv1alpha1.CouncilSeriesPoint{
				Period: pt.Period.Format("2006-01-02"), PeriodLabel: pt.PeriodLabel, Value: pt.Value,
			})
		}
		out.Series = append(out.Series, series)
	}

	for _, sub := range p.Suburbs {
		cs := &shortsv1alpha1.CouncilSuburb{
			SalCode: sub.SALCode, SalName: sub.SALName, Postcode: sub.Postcode, Population: sub.Population,
			Share: roundTo(sub.Share, 3), Dominant: sub.Dominant,
			FloodSharePct:    roundedPtr(sub.FloodSharePct, 1),
			BushfireSharePct: roundedPtr(sub.BushfireSharePct, 1),
			WaterSharePct:    roundedPtr(sub.WaterSharePct, 1),
			SeifaIrsadDecile: sub.SeifaIrsadDecile,
		}
		if sub.VGMedian != nil && sub.VGMedianPeriod != nil {
			cs.VgMedian, cs.VgMedianPeriod = sub.VGMedian, sub.VGMedianPeriod.Format("2006-01-02")
		}
		out.Suburbs = append(out.Suburbs, cs)
	}

	r := p.Rollup
	rollup := &shortsv1alpha1.CouncilRollup{
		MemberSuburbs: r.MemberSuburbs, DominantSuburbs: r.DominantSuburbs,
		FloodSharePct: roundedPtr(r.FloodSharePct, 1), FloodCoveredSuburbs: r.FloodCoveredSuburbs,
		BushfireSharePct: roundedPtr(r.BushfireSharePct, 1), BushfireCoveredSuburbs: r.BushfireCoveredSuburbs,
		WaterSharePct: roundedPtr(r.WaterSharePct, 1), WaterCoveredSuburbs: r.WaterCoveredSuburbs,
		PricedSuburbs: r.PricedSuburbs, MedianMin: r.MedianMin, MedianMax: r.MedianMax,
		MedianOfMedians: r.MedianOfMedians,
	}
	for _, c := range r.Crime {
		rollup.Crime = append(rollup.Crime, &shortsv1alpha1.CouncilCrimeStat{
			CrimeType: c.CrimeType, RatePer_100K: roundTo(c.RatePer100k, 1), FyEnding: c.FYEnding,
			CoveredSuburbs: c.CoveredSuburbs, SourceJurisdiction: c.SourceJurisdiction,
			Source: c.Source, SourceLicence: c.SourceLicence,
		})
	}
	out.Rollup = rollup

	rep := func(rows []shortsstore.CouncilRepresentativeRow) []*shortsv1alpha1.CouncilRepresentative {
		var list []*shortsv1alpha1.CouncilRepresentative
		for _, r := range rows {
			list = append(list, &shortsv1alpha1.CouncilRepresentative{
				Name: r.Name, Member: r.Member, Party: r.Party, PartyAb: r.PartyAb,
				PopulationShare: r.PopulationShare, SuburbCount: r.SuburbCount,
			})
		}
		return list
	}
	out.FederalElectorates, out.StateDistricts = rep(p.FederalSeats), rep(p.StateSeats)

	if d := p.PriceDrops; d != nil {
		drops := &shortsv1alpha1.CouncilPriceDrops{
			DroppedListingCount: d.Dropped, TrackedListingCount: d.Tracked,
			DroppedShare: roundTo(d.DroppedShare, 3), MedianDropPct: roundedPtr(d.MedianDropPct, 4),
			SuburbsTracked: d.SuburbsTracked,
		}
		if !d.AsOf.IsZero() {
			drops.AsOf = timestamppb.New(d.AsOf)
		}
		if d.DataThrough != nil {
			drops.DataThrough = timestamppb.New(*d.DataThrough)
		}
		for _, sd := range d.Suburbs {
			share := 0.0
			if sd.Tracked > 0 {
				share = roundTo(float64(sd.Dropped)/float64(sd.Tracked), 3)
			}
			drops.Suburbs = append(drops.Suburbs, &shortsv1alpha1.CouncilDropSuburb{
				SalCode: sd.SALCode, SalName: sd.SALName, Postcode: sd.Postcode,
				DroppedListingCount: sd.Dropped, TrackedListingCount: sd.Tracked,
				DroppedShare: share, MedianDropPct: roundedPtr(sd.MedianDropPct, 4),
			})
		}
		out.PriceDrops = drops
	}

	for _, n := range p.Neighbours {
		out.Neighbours = append(out.Neighbours, &shortsv1alpha1.CouncilNeighbour{
			LgaCode: n.LgaCode, Slug: n.Slug, DisplayName: n.DisplayName, Kind: n.Kind,
			StateCode: n.StateCode, SharesBorder: n.SharesBorder, SharedSuburbs: n.SharedSuburbs,
		})
	}
	return out
}
