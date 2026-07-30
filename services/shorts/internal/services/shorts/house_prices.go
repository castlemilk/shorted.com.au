package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// GetHousingOverview returns the latest house-price headline metrics (mean/median
// price, price index, debt-to-income) per region with QoQ/YoY change.
func (s *ShortsServer) GetHousingOverview(ctx context.Context, req *connect.Request[shortsv1alpha1.GetHousingOverviewRequest]) (*connect.Response[shortsv1alpha1.GetHousingOverviewResponse], error) {
	regionType := req.Msg.RegionType

	cacheKey := s.cache.GetHousingOverviewKey(regionType)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetHousingOverview(regionType)
		if err != nil {
			return nil, err
		}
		metrics := make([]*shortsv1alpha1.HousingMetric, 0, len(rows))
		var asOf *timestamppb.Timestamp
		for _, r := range rows {
			if r == nil {
				continue
			}
			ts := timestamppb.New(r.Period)
			if asOf == nil || r.Period.After(asOf.AsTime()) {
				asOf = ts
			}
			metrics = append(metrics, &shortsv1alpha1.HousingMetric{
				RegionCode:    r.RegionCode,
				RegionName:    r.RegionName,
				RegionType:    r.RegionType,
				StateCode:     r.StateCode,
				Measure:       r.Measure,
				DwellingType:  r.DwellingType,
				Value:         r.Value,
				Unit:          r.Unit,
				Period:        ts,
				IsPreliminary: r.IsPreliminary,
				QoqPct:        r.QoQPct,
				YoyPct:        r.YoYPct,
			})
		}
		return &shortsv1alpha1.GetHousingOverviewResponse{Metrics: metrics, AsOf: asOf}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetHousingOverview: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get housing overview"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetHousingOverviewResponse)), nil
}

// GetHousePriceSeries returns a single quarterly time series for a region and measure.
func (s *ShortsServer) GetHousePriceSeries(ctx context.Context, req *connect.Request[shortsv1alpha1.GetHousePriceSeriesRequest]) (*connect.Response[shortsv1alpha1.GetHousePriceSeriesResponse], error) {
	m := req.Msg
	if m.RegionCode == "" || m.Measure == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("region_code and measure are required"))
	}

	cacheKey := s.cache.GetHousePriceSeriesKey(m.RegionCode, m.Measure, m.DwellingType)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		res, err := s.store.GetHousePriceSeries(m.RegionCode, m.Measure, m.DwellingType)
		if err != nil {
			return nil, err
		}
		points := make([]*shortsv1alpha1.HousePricePoint, 0, len(res.Points))
		for _, p := range res.Points {
			points = append(points, &shortsv1alpha1.HousePricePoint{
				Period:        timestamppb.New(p.Period),
				Value:         p.Value,
				IsPreliminary: p.IsPreliminary,
			})
		}
		return &shortsv1alpha1.GetHousePriceSeriesResponse{
			RegionCode:    res.RegionCode,
			RegionName:    res.RegionName,
			Measure:       res.Measure,
			DwellingType:  res.DwellingType,
			Unit:          res.Unit,
			Source:        res.Source,
			SourceLicence: res.SourceLicence,
			Points:        points,
		}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetHousePriceSeries: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get house price series"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetHousePriceSeriesResponse)), nil
}

// ListStateSuburbs lists every suburb in a state with price + headline demographics.
func (s *ShortsServer) ListStateSuburbs(ctx context.Context, req *connect.Request[shortsv1alpha1.ListStateSuburbsRequest]) (*connect.Response[shortsv1alpha1.ListStateSuburbsResponse], error) {
	m := req.Msg
	if m.StateCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("state_code is required"))
	}
	cacheKey := s.cache.GetStateSuburbsKey(m.StateCode, m.Query, m.Limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListStateSuburbs(m.StateCode, m.Query, m.Limit)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.SuburbSummary, 0, len(rows))
		for _, r := range rows {
			if r == nil {
				continue
			}
			ss := &shortsv1alpha1.SuburbSummary{
				SalCode: r.SALCode, SalName: r.SALName, StateCode: r.StateCode,
				Postcode: r.Postcode, LatestMedianPrice: r.LatestMedianPrice,
				YoyPct: r.YoYPct, Population: r.Population, MedianAge: r.MedianAge,
				MedianWeeklyHhdIncome: r.MedianWeeklyHhdIncome, RegionCode: r.RegionCode,
				PctBornOverseas: r.PctBornOverseas, TopReligion: r.TopReligion,
				TopLanguage: r.TopLanguage, PctTopLanguage: r.PctTopLanguage,
				FederalDivision: r.FederalDivision, FederalMember: r.FederalMember,
				FederalParty: r.FederalParty, FederalPartyAb: r.FederalPartyAb,
				FederalTppAlp: r.FederalTppAlp, StateDistrict: r.StateDistrict,
				StateMember: r.StateMember, StateParty: r.StateParty, StatePartyAb: r.StatePartyAb,
				DominantNbnTech: r.DominantNbnTech, ConnectivityQualityScore: r.ConnectivityQualityScore,
				CrimeBreakInsRank: r.CrimeBreakInsRank, CrimeViolentRank: r.CrimeViolentRank,
				CrimeMotorVehicleRank: r.CrimeMotorVehicleRank,
				PoliticianPropertyCount: r.PoliticianPropertyCount,
				Amenities: &shortsv1alpha1.SuburbAmenities{
					SchoolsTotal: r.SchoolsTotal, SupermarketsTotal: r.SupermarketsTotal,
					ColesCount: r.ColesCount, WoolworthsCount: r.WoolworthsCount,
					AldiCount: r.AldiCount, IgaCount: r.IgaCount, PubsBars: r.PubsBars,
					ParksCount: r.ParksCount, LibrariesCount: r.LibrariesCount,
					NearestSupermarketKm: r.NearestSupermarketKm, AmenityDensityScore: r.AmenityDensityScore,
					HospitalsCount: r.HospitalsCount, GpCount: r.GpCount, PharmacyCount: r.PharmacyCount,
					NearestTrainKm: r.NearestTrainKm, NearestHospitalKm: r.NearestHospitalKm,
					DistToCoastKm: r.DistToCoastKm,
					SchoolsGov:    r.SchoolsGov, SchoolsCatholic: r.SchoolsCatholic, SchoolsIndependent: r.SchoolsIndependent,
					SchoolsPrimary: r.SchoolsPrimary, SchoolsSecondary: r.SchoolsSecondary, NearestSecondaryKm: r.NearestSecondaryKm,
				},
			}
			if r.LatestPeriod != nil {
				ss.LatestPeriod = timestamppb.New(*r.LatestPeriod)
			}
			out = append(out, ss)
		}
		return &shortsv1alpha1.ListStateSuburbsResponse{Suburbs: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListStateSuburbs: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list state suburbs"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListStateSuburbsResponse)), nil
}

// bannerFallbackBlurb returns a deterministic one-line blurb from the archetype,
// used when no agy-generated banner_blurb exists yet.
func bannerFallbackBlurb(archetype, salName, lgaName string) string {
	descr := map[string]string{
		"coastal-beach":  "a coastal suburb",
		"harbour":        "a harbourside suburb",
		"river-valley":   "a riverside suburb",
		"urban-skyline":  "an inner-city suburb",
		"inner-terraces": "a dense inner suburb",
		"leafy-suburban": "a leafy residential suburb",
		"parkland":       "a green, park-rich suburb",
		"hills-ranges":   "a suburb in the hills",
		"bushland":       "a bushland suburb",
		"farmland":       "a rural suburb",
	}
	d := descr[archetype]
	if d == "" {
		d = "a residential suburb"
	}
	name := salName
	if name == "" {
		return ""
	}
	if lgaName != "" {
		return fmt.Sprintf("%s is %s of %s.", name, d, lgaName)
	}
	return fmt.Sprintf("%s is %s.", name, d)
}

// GetSuburbProfile returns one suburb's full profile.
func (s *ShortsServer) GetSuburbProfile(ctx context.Context, req *connect.Request[shortsv1alpha1.GetSuburbProfileRequest]) (*connect.Response[shortsv1alpha1.GetSuburbProfileResponse], error) {
	m := req.Msg
	if m.SalCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sal_code is required"))
	}
	cacheKey := s.cache.GetSuburbProfileKey(m.SalCode)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		p, err := s.store.GetSuburbProfile(m.SalCode)
		if err != nil {
			return nil, err
		}
		summary := &shortsv1alpha1.SuburbSummary{
			SalCode: p.Summary.SALCode, SalName: p.Summary.SALName, StateCode: p.Summary.StateCode,
			Postcode: p.Summary.Postcode, LatestMedianPrice: p.Summary.LatestMedianPrice,
			YoyPct: p.Summary.YoYPct, Population: p.Summary.Population, MedianAge: p.Summary.MedianAge,
			MedianWeeklyHhdIncome: p.Summary.MedianWeeklyHhdIncome, RegionCode: p.Summary.RegionCode,
			PctBornOverseas: p.Summary.PctBornOverseas, TopReligion: p.Summary.TopReligion,
			TopLanguage: p.Summary.TopLanguage, PctTopLanguage: p.Summary.PctTopLanguage,
			FederalDivision: p.Summary.FederalDivision, FederalMember: p.Summary.FederalMember,
			FederalParty: p.Summary.FederalParty, FederalPartyAb: p.Summary.FederalPartyAb,
			FederalTppAlp: p.Summary.FederalTppAlp, StateDistrict: p.Summary.StateDistrict,
			StateMember: p.Summary.StateMember, StateParty: p.Summary.StateParty, StatePartyAb: p.Summary.StatePartyAb,
			DominantNbnTech: p.Summary.DominantNbnTech, ConnectivityQualityScore: p.Summary.ConnectivityQualityScore,
			Amenities: &shortsv1alpha1.SuburbAmenities{
				SchoolsTotal: p.Summary.SchoolsTotal, SupermarketsTotal: p.Summary.SupermarketsTotal,
				ColesCount: p.Summary.ColesCount, WoolworthsCount: p.Summary.WoolworthsCount,
				AldiCount: p.Summary.AldiCount, IgaCount: p.Summary.IgaCount, PubsBars: p.Summary.PubsBars,
				ParksCount: p.Summary.ParksCount, LibrariesCount: p.Summary.LibrariesCount,
				NearestSupermarketKm: p.Summary.NearestSupermarketKm, AmenityDensityScore: p.Summary.AmenityDensityScore,
				HospitalsCount: p.Summary.HospitalsCount, GpCount: p.Summary.GpCount, PharmacyCount: p.Summary.PharmacyCount,
				NearestTrainKm: p.Summary.NearestTrainKm, NearestHospitalKm: p.Summary.NearestHospitalKm,
				DistToCoastKm: p.Summary.DistToCoastKm,
				SchoolsGov:    p.Summary.SchoolsGov, SchoolsCatholic: p.Summary.SchoolsCatholic, SchoolsIndependent: p.Summary.SchoolsIndependent,
				SchoolsPrimary: p.Summary.SchoolsPrimary, SchoolsSecondary: p.Summary.SchoolsSecondary, NearestSecondaryKm: p.Summary.NearestSecondaryKm,
			},
		}
		if p.Summary.LatestPeriod != nil {
			summary.LatestPeriod = timestamppb.New(*p.Summary.LatestPeriod)
		}
		similar := make([]*shortsv1alpha1.SimilarSuburb, 0, len(p.Similar))
		for _, sm := range p.Similar {
			similar = append(similar, &shortsv1alpha1.SimilarSuburb{
				SalCode: sm.SALCode, SalName: sm.SALName, StateCode: sm.StateCode,
				LatestMedianPrice: sm.LatestMedianPrice, RegionCode: sm.RegionCode,
				Similarity: 1.0 / (1.0 + sm.Distance),
			})
		}
		banner := &shortsv1alpha1.SuburbBanner{
			Archetype: p.BannerArchetype,
			Blurb:     p.BannerBlurb,
			BgKey:     p.BannerBgKey,
			BgUrl:     p.BannerBgUrl,
		}
		if banner.BgKey == "" {
			banner.BgKey = banner.Archetype
		}
		if banner.Blurb == "" {
			banner.Blurb = bannerFallbackBlurb(banner.Archetype, p.Summary.SALName, p.LgaName)
		}
		if len(p.BannerLandmarks) > 0 {
			var landmarks []struct {
				Name string `json:"name"`
				Kind string `json:"kind"`
			}
			if err := json.Unmarshal(p.BannerLandmarks, &landmarks); err == nil {
				for _, l := range landmarks {
					banner.Landmarks = append(banner.Landmarks, &shortsv1alpha1.SuburbLandmark{Name: l.Name, Kind: l.Kind})
				}
			}
		}
		var crime *shortsv1alpha1.SuburbCrime
		if len(p.Crime) > 0 {
			crime = &shortsv1alpha1.SuburbCrime{
				SourceJurisdiction: p.Crime[0].Jurisdiction,
				Source:             p.Crime[0].Source,
				SourceLicence:      p.Crime[0].Licence,
			}
			for _, c := range p.Crime {
				crime.Stats = append(crime.Stats, &shortsv1alpha1.SuburbCrimeStat{
					CrimeType: c.CrimeType, RatePer_100K: c.RatePer100k,
					PctRank: c.PctRank, FyEnding: c.FYEnding,
				})
				switch c.CrimeType {
				case "break_ins":
					summary.CrimeBreakInsRank = c.PctRank
				case "violent":
					summary.CrimeViolentRank = c.PctRank
				case "motor_vehicle":
					summary.CrimeMotorVehicleRank = c.PctRank
				}
			}
		}
		return &shortsv1alpha1.GetSuburbProfileResponse{
			Summary: summary,
			Demographics: &shortsv1alpha1.SuburbDemographics{
				Population: p.Summary.Population, MedianAge: p.Summary.MedianAge,
				MedianWeeklyHhdIncome: p.Summary.MedianWeeklyHhdIncome,
				MedianWeeklyPerIncome: p.MedianWeeklyPerIncome, MedianWeeklyRent: p.MedianWeeklyRent,
				MedianMonthlyMortgage: p.MedianMonthlyMortgage, PctOwnedOutright: p.PctOwnedOutright,
				PctOwnedMortgage: p.PctOwnedMortgage, PctRented: p.PctRented,
				DwellingCount: p.DwellingCount, CensusYear: p.CensusYear,
				PctBornOverseas: p.Summary.PctBornOverseas, PctEnglishOnly: p.PctEnglishOnly,
				TopReligion: p.Summary.TopReligion, PctTopReligion: p.PctTopReligion,
				PctNoReligion: p.PctNoReligion, TopLanguage: p.Summary.TopLanguage,
				PctTopLanguage: p.Summary.PctTopLanguage,
			},
			Baselines: &shortsv1alpha1.ComparisonBaselines{
				StateMedianPrice: p.StateMedianPrice, NationalMedianPrice: p.NationalMedianPrice,
				StateMedianWeeklyHhdIncome:    p.StateMedianHhdIncome,
				NationalMedianWeeklyHhdIncome: p.NationalMedianHhdIncome,
			},
			Council: &shortsv1alpha1.LgaInfo{
				LgaCode: p.LgaCode, LgaName: p.LgaName, StateCode: p.LgaState, AreaSqkm: p.LgaAreaSqkm,
				Population: p.LgaPopulation, FedFagAud: p.LgaFagAud, FedFagYear: p.LgaFagYear,
				AvgRates: p.LgaAvgRates, OpSurplusRatio: p.LgaOpSurplusRatio,
				AssetRenewalRatio: p.LgaAssetRenewalRatio, FinSource: p.LgaFinSource, FinYear: p.LgaFinYear,
			},
			Similar: similar,
			Banner:  banner,
			Crime:   crime,
		}, nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("suburb not found"))
		}
		s.logger.Errorf("database error in GetSuburbProfile: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get suburb profile"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetSuburbProfileResponse)), nil
}

// ListHousingRegions lists selectable house-price regions (suburbs/LGAs/etc),
// optionally filtered by region_type, state, or name — powers the suburb explorer.
func (s *ShortsServer) ListHousingRegions(ctx context.Context, req *connect.Request[shortsv1alpha1.ListHousingRegionsRequest]) (*connect.Response[shortsv1alpha1.ListHousingRegionsResponse], error) {
	m := req.Msg

	cacheKey := s.cache.GetHousingRegionsKey(m.RegionType, m.StateCode, m.Query, m.Limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetHousingRegions(m.RegionType, m.StateCode, m.Query, m.Limit)
		if err != nil {
			return nil, err
		}
		regions := make([]*shortsv1alpha1.HousingRegion, 0, len(rows))
		for _, r := range rows {
			if r == nil {
				continue
			}
			hr := &shortsv1alpha1.HousingRegion{
				RegionCode:  r.RegionCode,
				RegionName:  r.RegionName,
				RegionType:  r.RegionType,
				StateCode:   r.StateCode,
				Postcode:    r.Postcode,
				LatestValue: r.LatestValue,
			}
			if r.LatestPeriod != nil {
				hr.LatestPeriod = timestamppb.New(*r.LatestPeriod)
			}
			regions = append(regions, hr)
		}
		return &shortsv1alpha1.ListHousingRegionsResponse{Regions: regions}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListHousingRegions: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list housing regions"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListHousingRegionsResponse)), nil
}

// ListSuburbPriceDrops ranks suburbs by recent for-sale asking-price reductions.
// This is the DERIVED aggregate surface (mv_suburb_price_drops) — no addresses or
// individual listings are returned, so it is always public.
func (s *ShortsServer) ListSuburbPriceDrops(ctx context.Context, req *connect.Request[shortsv1alpha1.ListSuburbPriceDropsRequest]) (*connect.Response[shortsv1alpha1.ListSuburbPriceDropsResponse], error) {
	m := req.Msg
	cacheKey := s.cache.GetSuburbPriceDropsKey(m.StateCode, m.Sort, m.Limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListSuburbPriceDrops(m.StateCode, m.Sort, m.Limit)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.SuburbPriceDrop, 0, len(rows))
		for _, r := range rows {
			if r == nil {
				continue
			}
			out = append(out, &shortsv1alpha1.SuburbPriceDrop{
				RegionCode: r.RegionCode, SalCode: r.SALCode, SalName: r.SALName, StateCode: r.StateCode,
				Postcode: r.Postcode, DroppedListingCount: r.DroppedListingCount, AvgDropPct: r.AvgDropPct,
				MedianDropPct: r.MedianDropPct, MaxDropPct: r.MaxDropPct, MaxDropAbs: r.MaxDropAbs,
				TotalActiveListings: r.TotalActiveListings, DroppedShare: r.DroppedShare,
				ForSaleCount: r.ForSaleCount, AvgAsking: r.AvgAsking, MedianAsking: r.MedianAsking,
				SoldCount: r.SoldCount, AvgSold: r.AvgSold, MedianSold: r.MedianSold,
				DroppedValue: r.DroppedValue,
			})
		}
		return &shortsv1alpha1.ListSuburbPriceDropsResponse{Suburbs: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListSuburbPriceDrops: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list suburb price drops"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListSuburbPriceDropsResponse)), nil
}

// dropListingsEnabled gates the per-listing deep-link drill-down. That path reads
// ToS-restricted listing rows, so it is OFF by default and enabled only once the
// operator has confirmed the publish posture (HOUSING_DROP_LISTINGS_ENABLED=true).
// dropListingsEnabled gates the per-address / per-listing surfaces (the
// drops-by-address board, per-address history, suburb-drop deep-links, and the
// suburb drops panel) that read the ToS-restricted REA/Domain listing rows.
// Enabled by DEFAULT — no opt-in env is needed to ship it live. Set
// HOUSING_DROP_LISTINGS_ENABLED to a falsey value ("false"/"0"/"off"/"no") only
// as an explicit kill switch (e.g. a takedown request).
func dropListingsEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("HOUSING_DROP_LISTINGS_ENABLED"))) {
	case "false", "0", "off", "no":
		return false
	default:
		return true
	}
}

// valuationsEnabled independently gates the property.com.au AVM enrichment.
// It is enabled by default, with an explicit kill switch for the source's
// heightened ToS posture.
func valuationsEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("HOUSING_VALUATIONS_ENABLED"))) {
	case "false", "0", "off", "no":
		return false
	default:
		return true
	}
}

// ListSuburbDropListings returns a suburb's recently-reduced listings, each
// deep-linking OUT to the live portal page. Flag-gated: returns an empty list when
// disabled so the UI degrades cleanly to the aggregate-only surface.
func (s *ShortsServer) ListSuburbDropListings(ctx context.Context, req *connect.Request[shortsv1alpha1.ListSuburbDropListingsRequest]) (*connect.Response[shortsv1alpha1.ListSuburbDropListingsResponse], error) {
	m := req.Msg
	if m.SalCode == "" && m.RegionCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sal_code or region_code is required"))
	}
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListSuburbDropListingsResponse{}), nil
	}
	cacheKey := s.cache.GetSuburbDropListingsKey(m.SalCode, m.RegionCode, m.WindowDays, m.Limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListSuburbDropListings(m.SalCode, m.RegionCode, m.WindowDays, m.Limit)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.SuburbDropListing, 0, len(rows))
		for _, r := range rows {
			if r == nil {
				continue
			}
			out = append(out, &shortsv1alpha1.SuburbDropListing{
				Source: r.Source, ListingUrl: r.ListingURL, DisplayAddress: r.DisplayAddress,
				PropertyType: r.PropertyType, Bedrooms: r.Bedrooms, Bathrooms: r.Bathrooms,
				CarSpaces: r.CarSpaces, PrevPrice: r.PrevPrice, Price: r.Price,
				DropPct: r.DropPct, DropAbs: r.DropAbs, ObservedAt: timestamppb.New(r.ObservedAt),
				AddressKey: r.AddressKey, AgencyName: r.AgencyName, AgentNames: r.AgentNames,
			})
		}
		return &shortsv1alpha1.ListSuburbDropListingsResponse{Listings: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListSuburbDropListings: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list suburb drop listings"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListSuburbDropListingsResponse)), nil
}

// GetPropertyHistory returns the full asking-price timeline for a single physical
// address (stable address_key), merging every listing/relist seen at that address.
// It reads the raw (proprietary-tos-restricted) listing rows — the SAME posture as
// ListSuburbDropListings — so it is flag-gated behind HOUSING_DROP_LISTINGS_ENABLED
// and returns an empty response (not an error) when the flag is off, so the UI
// degrades cleanly to the aggregate-only surface.
func (s *ShortsServer) GetPropertyHistory(ctx context.Context, req *connect.Request[shortsv1alpha1.GetPropertyHistoryRequest]) (*connect.Response[shortsv1alpha1.GetPropertyHistoryResponse], error) {
	m := req.Msg
	if m.AddressKey == "" {
		return connect.NewResponse(&shortsv1alpha1.GetPropertyHistoryResponse{}), nil
	}
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetPropertyHistoryResponse{}), nil
	}
	cacheKey := s.cache.GetPropertyHistoryKey(m.AddressKey)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		res, err := s.store.GetPropertyHistory(m.AddressKey)
		if err != nil {
			return nil, err
		}
		// Valuation work is seeded from property_listings address keys, so an
		// address without a listing cannot have a reachable valuation.
		if res == nil || res.Current == nil {
			return &shortsv1alpha1.GetPropertyHistoryResponse{}, nil
		}
		c := res.Current
		current := &shortsv1alpha1.PropertyListingSnapshot{
			Source: c.Source, ListingId: c.ListingID, ListingUrl: c.ListingURL,
			Price: c.Price, PriceDisplay: c.PriceDisplay, PriceKind: c.PriceKind,
			ListingStatus: c.ListingStatus, IsActive: c.IsActive,
			Bedrooms: c.Bedrooms, Bathrooms: c.Bathrooms, CarSpaces: c.CarSpaces,
			LandSizeSqm: c.LandSizeSqm, PropertyType: c.PropertyType,
			FirstSeenAt: c.FirstSeenAt.Format(time.RFC3339),
			LastSeenAt:  c.LastSeenAt.Format(time.RFC3339),
			AgencyName:  c.AgencyName, AgentNames: c.AgentNames,
		}
		events := make([]*shortsv1alpha1.PropertyPriceEvent, 0, len(res.Events))
		for _, e := range res.Events {
			if e == nil {
				continue
			}
			events = append(events, &shortsv1alpha1.PropertyPriceEvent{
				ObservedAt: e.ObservedAt.Format(time.RFC3339), EventType: e.EventType,
				Source: e.Source, ListingId: e.ListingID,
				Price: e.Price, PrevPrice: e.PrevPrice, DropAbs: e.DropAbs, DropPct: e.DropPct,
				ListingStatus: e.ListingStatus, PrevStatus: e.PrevStatus,
			})
		}
		var valuation *shortsv1alpha1.PropertyValuation
		if valuationsEnabled() {
			v, verr := s.store.GetPropertyValuation(m.AddressKey)
			if verr != nil {
				// The valuation is an enrichment. A failure here, including a
				// pre-migration environment without property_valuations, must never
				// fail the property-history page.
				s.logger.Warnf("GetPropertyValuation(%s): %v", m.AddressKey, verr)
			} else if v != nil {
				valuation = toPropertyValuationProto(v)
			}
		}
		return &shortsv1alpha1.GetPropertyHistoryResponse{
			AddressKey: res.AddressKey, DisplayAddress: res.DisplayAddress,
			Suburb: res.Suburb, StateCode: res.StateCode, Postcode: res.Postcode,
			Current: current, Events: events, NumListings: res.NumListings,
			FirstPrice: res.FirstPrice, CurrentPrice: res.CurrentPrice,
			DistinctDwellings: res.DistinctDwellings,
			Valuation:         valuation,
		}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetPropertyHistory: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get property history"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetPropertyHistoryResponse)), nil
}

func toPropertyValuationProto(row *shortsstore.PropertyValuationRow) *shortsv1alpha1.PropertyValuation {
	if row == nil {
		return nil
	}
	salesHistory := make([]*shortsv1alpha1.PropertyValuationSale, 0, len(row.SalesHistory))
	for _, sale := range row.SalesHistory {
		salesHistory = append(salesHistory, &shortsv1alpha1.PropertyValuationSale{
			Date:      sale.Date,
			Price:     derefOrZero(sale.Price),
			Agency:    sale.Agency,
			EventType: sale.Type,
		})
	}
	return &shortsv1alpha1.PropertyValuation{
		Source:               row.Source,
		ProfileUrl:           row.ProfileURL,
		FetchedAt:            row.FetchedAt.Format(time.RFC3339),
		EstimateLow:          row.EstimateLow,
		EstimateMid:          row.EstimateMid,
		EstimateHigh:         row.EstimateHigh,
		EstimateConfidence:   row.EstimateConfidence,
		ValuationGranularity: row.ValuationGranularity,
		RentEstimateMid:      row.RentEstimateMid,
		Bedrooms:             row.Bedrooms,
		Bathrooms:            row.Bathrooms,
		CarSpaces:            row.CarSpaces,
		LandSizeSqm:          row.LandSizeSqm,
		BuildingSizeSqm:      row.BuildingSizeSqm,
		YearBuilt:            row.YearBuilt,
		PropertyType:         row.PropertyType,
		SalesHistory:         salesHistory,
	}
}

func derefOrZero(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

// ListAddressPriceDrops ranks individual physical addresses (deduped by
// address_key) by their asking-price reduction over a window, each deep-linking
// to its per-address history page. Reads ToS-restricted listing rows — SAME
// posture as ListSuburbDropListings — so it is flag-gated behind
// HOUSING_DROP_LISTINGS_ENABLED and returns an empty list (not an error) when the
// flag is off, so the UI degrades cleanly to the aggregate-only surface.
func (s *ShortsServer) ListAddressPriceDrops(ctx context.Context, req *connect.Request[shortsv1alpha1.ListAddressPriceDropsRequest]) (*connect.Response[shortsv1alpha1.ListAddressPriceDropsResponse], error) {
	m := req.Msg
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListAddressPriceDropsResponse{}), nil
	}
	cacheKey := s.cache.GetAddressPriceDropsKey(m.StateCode, m.Sort, m.WindowDays, m.Limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListAddressPriceDrops(m.StateCode, m.Sort, m.WindowDays, m.Limit)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.AddressPriceDrop, 0, len(rows))
		for _, r := range rows {
			if r == nil {
				continue
			}
			out = append(out, &shortsv1alpha1.AddressPriceDrop{
				AddressKey: r.AddressKey, DisplayAddress: r.DisplayAddress, Suburb: r.Suburb,
				StateCode: r.StateCode, Postcode: r.Postcode,
				FirstPrice: r.FirstPrice, CurrentPrice: r.CurrentPrice,
				DropAbs: r.DropAbs, DropPct: r.DropPct, NumListings: r.NumListings,
				LatestSource: r.LatestSource, LatestListingUrl: r.LatestListingURL,
				LastObservedAt: r.LastObservedAt.Format(time.RFC3339),
				PropertyType:   r.PropertyType, Bedrooms: r.Bedrooms, Bathrooms: r.Bathrooms,
				AgencyName: r.AgencyName, AgentNames: r.AgentNames,
			})
		}
		return &shortsv1alpha1.ListAddressPriceDropsResponse{Addresses: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListAddressPriceDrops: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list address price drops"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListAddressPriceDropsResponse)), nil
}

// GetPriceDropsOverview returns the per-state rollup of recent asking-price
// reductions plus asking/sold price aggregates, with an 'AU' national summary.
// This is a DERIVED aggregate surface (mv_state_price_drops) — no addresses or
// individual listings are returned, so it is always public (same posture as
// ListSuburbPriceDrops).
func (s *ShortsServer) GetPriceDropsOverview(ctx context.Context, req *connect.Request[shortsv1alpha1.GetPriceDropsOverviewRequest]) (*connect.Response[shortsv1alpha1.GetPriceDropsOverviewResponse], error) {
	cacheKey := s.cache.GetPriceDropsOverviewKey()
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetPriceDropsOverview()
		if err != nil {
			return nil, err
		}
		resp := &shortsv1alpha1.GetPriceDropsOverviewResponse{}
		for _, r := range rows {
			if r == nil {
				continue
			}
			row := &shortsv1alpha1.StatePriceDropSummary{
				StateCode: r.StateCode, DroppedCount: r.DroppedCount,
				AvgDropPct: r.AvgDropPct, MedianDropPct: r.MedianDropPct, MaxDropPct: r.MaxDropPct,
				DroppedValue: r.DroppedValue, TotalActiveListings: r.TotalActiveListings,
				DroppedShare: r.DroppedShare, ForSaleCount: r.ForSaleCount, ForSalePriced: r.ForSalePriced,
				AvgAsking: r.AvgAsking, MedianAsking: r.MedianAsking,
				SoldCount: r.SoldCount, AvgSold: r.AvgSold, MedianSold: r.MedianSold,
				SuburbsTracked: r.SuburbsTracked,
			}
			if r.StateCode == "AU" {
				resp.National = row
			} else {
				resp.States = append(resp.States, row)
			}
		}
		return resp, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetPriceDropsOverview: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get price drops overview"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetPriceDropsOverviewResponse)), nil
}

// ListAgencyPriceStats ranks real-estate agencies by recent asking-price cuts
// (or listing footprint) from mv_agency_stats (>=3 active listings floor; drop
// depth/value suppressed below 3 dropped addresses). Although the rows are
// derived aggregates, they carry agency + agent NAMES harvested from the
// ToS-restricted listing rows — so unlike the anonymous suburb/state
// aggregates, this surface sits behind the same HOUSING_DROP_LISTINGS_ENABLED
// kill switch as the per-listing boards and returns an empty list (not an
// error) when disabled.
func (s *ShortsServer) ListAgencyPriceStats(ctx context.Context, req *connect.Request[shortsv1alpha1.ListAgencyPriceStatsRequest]) (*connect.Response[shortsv1alpha1.ListAgencyPriceStatsResponse], error) {
	m := req.Msg
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListAgencyPriceStatsResponse{}), nil
	}
	// Normalize BEFORE the cache key so casing/junk variants of the same query
	// can't fan out into distinct cache entries.
	stateCode := strings.ToUpper(strings.TrimSpace(m.StateCode))
	sort := m.Sort
	switch sort {
	case "drops", "listings", "avg_cut", "value":
	default:
		sort = "drops"
	}
	limit := m.Limit
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	cacheKey := s.cache.GetAgencyPriceStatsKey(stateCode, sort, limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListAgencyPriceStats(stateCode, sort, limit)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.AgencyPriceStats, 0, len(rows))
		for _, r := range rows {
			if r == nil {
				continue
			}
			out = append(out, &shortsv1alpha1.AgencyPriceStats{
				Source: r.Source, AgencyId: r.AgencyID, AgencyName: r.AgencyName,
				StateCode: r.StateCode, ActiveListings: r.ActiveListings,
				PricedListings: r.PricedListings, AvgAsking: r.AvgAsking,
				MedianAsking: r.MedianAsking, SuburbsCovered: r.SuburbsCovered,
				DroppedCount: r.DroppedCount, AvgDropPct: r.AvgDropPct,
				TotalDropValue: r.TotalDropValue, AgentNames: r.AgentNames,
			})
		}
		return &shortsv1alpha1.ListAgencyPriceStatsResponse{Agencies: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListAgencyPriceStats: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list agency price stats"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListAgencyPriceStatsResponse)), nil
}
