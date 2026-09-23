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
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

var australianStateCodes = map[string]struct{}{
	"ACT": {}, "NSW": {}, "NT": {}, "QLD": {},
	"SA": {}, "TAS": {}, "VIC": {}, "WA": {},
}

var housingRegionTypes = map[string]struct{}{
	"national": {}, "state": {}, "gccsa": {}, "rest_of_state": {},
	"suburb": {}, "lga": {},
}

type housingParams struct {
	stateCode, query, regionType, sort string
	salCode, regionCode, addressKey    string
	measure, dwellingType              string
	limit, windowDays                  int32
}

type housingParamRules struct {
	requireState        bool
	validateRegionType  bool
	defaultSort         string
	allowedSorts        map[string]struct{}
	defaultLimit        int32
	maxLimit            int32
	defaultWindowDays   int32
	maxWindowDays       int32
	defaultDwellingType string
}

// normalizeHousingParams is the single normalization boundary for housing RPC
// store calls and cache keys. Free-text queries are additionally kept out of the
// shared MemoryCache by their handlers so anonymous searches cannot mint one
// large entry per request.
func normalizeHousingParams(raw housingParams, rules housingParamRules) (housingParams, error) {
	normalized := raw
	normalized.stateCode = strings.ToUpper(strings.TrimSpace(raw.stateCode))
	if rules.requireState && normalized.stateCode == "" {
		return housingParams{}, fmt.Errorf("state_code is required")
	}
	if normalized.stateCode != "" {
		if _, ok := australianStateCodes[normalized.stateCode]; !ok {
			return housingParams{}, fmt.Errorf("state_code must be an Australian state or territory code")
		}
	}

	normalized.query = strings.ToLower(strings.Join(strings.Fields(raw.query), " "))
	normalized.regionType = strings.ToLower(strings.TrimSpace(raw.regionType))
	if rules.validateRegionType && normalized.regionType != "" {
		if _, ok := housingRegionTypes[normalized.regionType]; !ok {
			return housingParams{}, fmt.Errorf("invalid region_type")
		}
	}

	normalized.sort = strings.ToLower(strings.TrimSpace(raw.sort))
	if rules.allowedSorts != nil {
		if _, ok := rules.allowedSorts[normalized.sort]; !ok {
			normalized.sort = rules.defaultSort
		}
	}
	if rules.defaultLimit > 0 && (normalized.limit <= 0 || normalized.limit > rules.maxLimit) {
		normalized.limit = rules.defaultLimit
	}
	if rules.defaultWindowDays > 0 && (normalized.windowDays <= 0 || normalized.windowDays > rules.maxWindowDays) {
		normalized.windowDays = rules.defaultWindowDays
	}

	normalized.salCode = strings.TrimSpace(raw.salCode)
	normalized.regionCode = strings.ToUpper(strings.TrimSpace(raw.regionCode))
	normalized.addressKey = strings.ToLower(strings.TrimSpace(raw.addressKey))
	normalized.measure = strings.ToLower(strings.TrimSpace(raw.measure))
	normalized.dwellingType = strings.ToLower(strings.TrimSpace(raw.dwellingType))
	if rules.defaultDwellingType != "" && normalized.dwellingType == "" {
		normalized.dwellingType = rules.defaultDwellingType
	}

	return normalized, nil
}

func (s *ShortsServer) getHousingCached(cacheable bool, key string, compute func() (interface{}, error)) (interface{}, error) {
	if !cacheable {
		return compute()
	}
	return s.cache.GetOrSet(key, compute)
}

// GetHousingOverview returns the latest house-price headline metrics (mean/median
// price, price index, debt-to-income) per region with QoQ/YoY change.
func (s *ShortsServer) GetHousingOverview(ctx context.Context, req *connect.Request[shortsv1alpha1.GetHousingOverviewRequest]) (*connect.Response[shortsv1alpha1.GetHousingOverviewResponse], error) {
	params, paramErr := normalizeHousingParams(housingParams{regionType: req.Msg.RegionType}, housingParamRules{validateRegionType: true})
	if paramErr != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, paramErr)
	}
	regionType := params.regionType

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
	params, _ := normalizeHousingParams(housingParams{
		regionCode: m.RegionCode, measure: m.Measure, dwellingType: m.DwellingType,
	}, housingParamRules{defaultDwellingType: "all"})
	if params.regionCode == "" || params.measure == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("region_code and measure are required"))
	}

	cacheKey := s.cache.GetHousePriceSeriesKey(params.regionCode, params.measure, params.dwellingType)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		res, err := s.store.GetHousePriceSeries(params.regionCode, params.measure, params.dwellingType)
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
	params, paramErr := normalizeHousingParams(housingParams{
		stateCode: m.StateCode, query: m.Query, limit: m.Limit,
	}, housingParamRules{requireState: true, defaultLimit: 5000, maxLimit: 20000})
	if paramErr != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, paramErr)
	}
	cacheKey := s.cache.GetStateSuburbsKey(params.stateCode, params.query, params.limit)
	cached, err := s.getHousingCached(params.query == "", cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListStateSuburbs(params.stateCode, params.query, params.limit)
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
				CrimeMotorVehicleRank:   r.CrimeMotorVehicleRank,
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
	params, _ := normalizeHousingParams(housingParams{salCode: m.SalCode}, housingParamRules{})
	if params.salCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sal_code is required"))
	}
	cacheKey := s.cache.GetSuburbProfileKey(params.salCode)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		p, err := s.store.GetSuburbProfile(params.salCode)
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
			PoliticianPropertyCount: p.Summary.PoliticianPropertyCount,
			DominantNbnTech:         p.Summary.DominantNbnTech, ConnectivityQualityScore: p.Summary.ConnectivityQualityScore,
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
		attachSuburbSeifa(summary.ProtoReflect(), p.Summary.Seifa)
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
		// Crawl-derived aggregates. Populated inside the cache; the kill switch is
		// applied on READ below so a takedown takes effect immediately rather than
		// waiting out the cache TTL.
		var listingStats *shortsv1alpha1.SuburbListingStats
		if p.ListingStats != nil {
			listingStats = &shortsv1alpha1.SuburbListingStats{
				ForSaleCount: p.ListingStats.ForSaleCount,
				AvgAsking:    p.ListingStats.AvgAsking,
				MedianAsking: p.ListingStats.MedianAsking,
				SoldCount:    p.ListingStats.SoldCount,
				AvgSold:      p.ListingStats.AvgSold,
				MedianSold:   p.ListingStats.MedianSold,
			}
			listingStats.AsOf, listingStats.DataThrough = s.dropsFreshness(mvSuburbListingStats)
		}
		demographics := &shortsv1alpha1.SuburbDemographics{
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
		}
		attachExpandedCensus(demographics.ProtoReflect(), p.ExpandedCensus)
		response := &shortsv1alpha1.GetSuburbProfileResponse{
			Summary:      summary,
			Demographics: demographics,
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
			Similar:      similar,
			Banner:       banner,
			Crime:        crime,
			ListingStats: listingStats,
		}
		attachSuburbElevation(response.ProtoReflect(), p.Elevation)
		response.Hazards = suburbHazardsProto(p.Hazards)
		return response, nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("suburb not found"))
		}
		s.logger.Errorf("database error in GetSuburbProfile: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get suburb profile"))
	}
	resp := cached.(*shortsv1alpha1.GetSuburbProfileResponse)
	// The listing aggregates are the one part of this response derived from
	// ToS-restricted crawl rows, so the kill switch is honoured HERE rather than
	// inside the cached build — flipping HOUSING_DROP_LISTINGS_ENABLED must take
	// effect on the next request, not after the cache TTL. Clone before stripping
	// so the cached object is never mutated.
	if resp.GetListingStats() != nil && !dropListingsEnabled() {
		stripped, _ := proto.Clone(resp).(*shortsv1alpha1.GetSuburbProfileResponse)
		stripped.ListingStats = nil
		return connect.NewResponse(stripped), nil
	}
	return connect.NewResponse(resp), nil
}

// ListHousingRegions lists selectable house-price regions (suburbs/LGAs/etc),
// optionally filtered by region_type, state, or name — powers the suburb explorer.
func (s *ShortsServer) ListHousingRegions(ctx context.Context, req *connect.Request[shortsv1alpha1.ListHousingRegionsRequest]) (*connect.Response[shortsv1alpha1.ListHousingRegionsResponse], error) {
	m := req.Msg
	params, paramErr := normalizeHousingParams(housingParams{
		regionType: m.RegionType, stateCode: m.StateCode, query: m.Query, limit: m.Limit,
	}, housingParamRules{validateRegionType: true, defaultLimit: 2000, maxLimit: 5000})
	if paramErr != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, paramErr)
	}

	cacheKey := s.cache.GetHousingRegionsKey(params.regionType, params.stateCode, params.query, params.limit)
	cached, err := s.getHousingCached(params.query == "", cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetHousingRegions(params.regionType, params.stateCode, params.query, params.limit)
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

// Housing materialized views whose refresh migration 000124 records in
// housing_mv_refresh; the price-drops reads stamp their responses from these.
const (
	mvSuburbListingStats = "mv_suburb_listing_stats"
	mvSuburbPriceDrops   = "mv_suburb_price_drops"
	mvStatePriceDrops    = "mv_state_price_drops"
)

// dropsFreshness returns the as_of / data_through stamp for a response built
// from the named views: the OLDEST refreshed_at and the OLDEST data_through
// among them, so a board joining two views never claims more freshness than
// its staler half. Any view without a recorded refresh — or a database before
// migration 000124, or a failed read — leaves the stamp unset ("unknown"):
// freshness decorates the data, it must never fail the read.
func (s *ShortsServer) dropsFreshness(mvNames ...string) (asOf, dataThrough *timestamppb.Timestamp) {
	rows, err := s.store.GetHousingMVRefresh(mvNames)
	if err != nil {
		s.logger.Warnf("housing_mv_refresh read failed; serving price drops undated: %v", err)
		return nil, nil
	}
	var oldestRefresh, oldestThrough time.Time
	throughKnown := true
	for _, name := range mvNames {
		r, ok := rows[name]
		if !ok {
			return nil, nil
		}
		if oldestRefresh.IsZero() || r.RefreshedAt.Before(oldestRefresh) {
			oldestRefresh = r.RefreshedAt
		}
		if r.DataThrough == nil {
			throughKnown = false
		} else if oldestThrough.IsZero() || r.DataThrough.Before(oldestThrough) {
			oldestThrough = *r.DataThrough
		}
	}
	if oldestRefresh.IsZero() {
		return nil, nil
	}
	asOf = timestamppb.New(oldestRefresh)
	if throughKnown && !oldestThrough.IsZero() {
		dataThrough = timestamppb.New(oldestThrough)
	}
	return asOf, dataThrough
}

// ListSuburbPriceDrops ranks suburbs by recent for-sale asking-price reductions.
// This is the DERIVED aggregate surface (mv_suburb_price_drops) — no addresses or
// individual listings are returned, so it needs no sign-in; it still honours
// the crawl kill switch (see dropListingsEnabled).
func (s *ShortsServer) ListSuburbPriceDrops(ctx context.Context, req *connect.Request[shortsv1alpha1.ListSuburbPriceDropsRequest]) (*connect.Response[shortsv1alpha1.ListSuburbPriceDropsResponse], error) {
	m := req.Msg
	params, paramErr := normalizeHousingParams(housingParams{
		stateCode: m.StateCode, sort: m.Sort, limit: m.Limit,
	}, housingParamRules{
		defaultSort: "count", allowedSorts: map[string]struct{}{"count": {}, "avg": {}, "max": {}, "share": {}, "asking": {}, "sold": {}},
		defaultLimit: 50, maxLimit: 500,
	})
	if paramErr != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, paramErr)
	}
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListSuburbPriceDropsResponse{}), nil
	}
	cacheKey := s.cache.GetSuburbPriceDropsKey(params.stateCode, params.sort, params.limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListSuburbPriceDrops(params.stateCode, params.sort, params.limit)
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
		asOf, dataThrough := s.dropsFreshness(mvSuburbListingStats, mvSuburbPriceDrops)
		return &shortsv1alpha1.ListSuburbPriceDropsResponse{Suburbs: out, AsOf: asOf, DataThrough: dataThrough}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListSuburbPriceDrops: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list suburb price drops"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListSuburbPriceDropsResponse)), nil
}

// dropListingsEnabled is THE kill switch for everything served from the
// ToS-restricted REA/Domain crawl. Enabled by DEFAULT — no opt-in env is needed
// to ship it live. Set HOUSING_DROP_LISTINGS_ENABLED to a falsey value
// ("false"/"0"/"off"/"no") only as an explicit kill switch.
//
// ONE policy, applied identically on every surface: when the switch is off,
// every read DERIVED from crawl rows returns empty (never an error, so the UI
// degrades to its no-data state) — the per-listing / per-address / agency
// surfaces AND the k>=3-floored aggregates: ListSuburbPriceDrops,
// GetPriceDropsOverview, GetDropIndexSeries, the profile's listing_stats, and
// the MCP housing tools that mirror them. A takedown concerns the source's
// data, not how finely we present it, so one flip must leave nothing from that
// source live. It used to differ by surface (the profile and MCP withheld the
// aggregates while ListSuburbPriceDrops kept serving the same MV rows), so a
// takedown left the most visible board up. The check runs outside the backend
// cache on every surface, so a flip takes effect on the next request.
//
// Takedown runbook (both steps are required):
//  1. Set HOUSING_DROP_LISTINGS_ENABLED=false and restart/deploy the API.
//  2. Flush KV and ISR immediately:
//     curl -X POST -H "X-Revalidate-Secret: $REVALIDATION_SECRET" \
//     "$REVALIDATION_URL?path=/price-drops,/housing&flush=housing"
func dropListingsEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("HOUSING_DROP_LISTINGS_ENABLED"))) {
	case "false", "0", "off", "no":
		return false
	default:
		return true
	}
}

// valuationsEnabled independently gates the per-address property.com.au AVM and
// sales-history enrichment. Enabled by DEFAULT, like dropListingsEnabled: the card
// attributes the source, deep-links to the property.com.au profile, disclaims that
// the figures are model estimates, and labels a whole-building estimate as such
// (see valuation_granularity, migration 000091). Set HOUSING_VALUATIONS_ENABLED to
// a falsey value ("false"/"0"/"off"/"no") as an explicit kill switch — this source
// carries a heightened ToS posture, so a takedown must be one env flip away.
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
	params, _ := normalizeHousingParams(housingParams{
		salCode: m.SalCode, regionCode: m.RegionCode, windowDays: m.WindowDays, limit: m.Limit,
	}, housingParamRules{defaultWindowDays: 30, maxWindowDays: 365, defaultLimit: 30, maxLimit: 200})
	if params.salCode == "" && params.regionCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sal_code or region_code is required"))
	}
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListSuburbDropListingsResponse{}), nil
	}
	cacheKey := s.cache.GetSuburbDropListingsKey(params.salCode, params.regionCode, params.windowDays, params.limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListSuburbDropListings(params.salCode, params.regionCode, params.windowDays, params.limit)
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
	params, _ := normalizeHousingParams(housingParams{addressKey: m.AddressKey}, housingParamRules{})
	if params.addressKey == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("address_key is required"))
	}
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetPropertyHistoryResponse{}), nil
	}
	cacheKey := s.cache.GetPropertyHistoryKey(params.addressKey)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		res, err := s.store.GetPropertyHistory(params.addressKey)
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
			// All other price-drop surfaces cap >40% as likely listing typo
			// corrections. Re-assert the same publish rule at the response edge.
			if e.EventType == "price_drop" && e.DropPct > 0.40 {
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
			v, verr := s.store.GetPropertyValuation(params.addressKey)
			if verr != nil {
				// The valuation is an enrichment. A failure here, including a
				// pre-migration environment without property_valuations, must never
				// fail the property-history page.
				s.logger.Warnf("GetPropertyValuation(%s): %v", params.addressKey, verr)
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
	response := cached.(*shortsv1alpha1.GetPropertyHistoryResponse)
	if response.Current == nil {
		// GetOrSet inserts before returning. Remove empty/unknown responses
		// immediately so a transient miss is not negative-cached for five minutes.
		s.cache.Delete(cacheKey)
	}
	if !valuationsEnabled() && response.Valuation != nil {
		// The valuation flag may change while a history response is warm. Return a
		// redacted copy so the kill switch takes effect immediately without mutating
		// the shared cached message for a later explicit re-enable. This must be a
		// proto.Clone, not `*response` — a generated message carries an internal
		// MessageState that is not safe to copy by value.
		redacted, _ := proto.Clone(response).(*shortsv1alpha1.GetPropertyHistoryResponse)
		redacted.Valuation = nil
		response = redacted
	}
	return connect.NewResponse(response), nil
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
	params, paramErr := normalizeHousingParams(housingParams{
		stateCode: m.StateCode, sort: m.Sort, windowDays: m.WindowDays, limit: m.Limit,
	}, housingParamRules{
		defaultSort: "pct", allowedSorts: map[string]struct{}{"pct": {}, "abs": {}, "recent": {}},
		defaultWindowDays: 90, maxWindowDays: 365, defaultLimit: 50, maxLimit: 200,
	})
	if paramErr != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, paramErr)
	}
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListAddressPriceDropsResponse{}), nil
	}
	cacheKey := s.cache.GetAddressPriceDropsKey(params.stateCode, params.sort, params.windowDays, params.limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListAddressPriceDrops(params.stateCode, params.sort, params.windowDays, params.limit)
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
// individual listings are returned, so it needs no sign-in (same posture as
// ListSuburbPriceDrops, including the crawl kill switch). Each state row
// carries its crawl coverage; the UI annotates rather than ranks a state below
// the drop index's 0.6 coverage threshold.
func (s *ShortsServer) GetPriceDropsOverview(ctx context.Context, req *connect.Request[shortsv1alpha1.GetPriceDropsOverviewRequest]) (*connect.Response[shortsv1alpha1.GetPriceDropsOverviewResponse], error) {
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetPriceDropsOverviewResponse{}), nil
	}
	cacheKey := s.cache.GetPriceDropsOverviewKey()
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetPriceDropsOverview()
		if err != nil {
			return nil, err
		}
		resp := &shortsv1alpha1.GetPriceDropsOverviewResponse{}
		resp.AsOf, resp.DataThrough = s.dropsFreshness(mvStatePriceDrops)
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
				SuburbsTracked:   r.SuburbsTracked,
				SuburbsSwept_14D: r.SuburbsSwept14d, CatalogSuburbs: r.CatalogSuburbs,
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
// count/depth/value suppressed below 3 dropped addresses). Agent personal names
// are intentionally absent from this aggregate; they remain available only on
// the flag-gated per-listing drill-down. The agency identity itself is harvested
// from ToS-restricted rows, so this surface retains the same
// HOUSING_DROP_LISTINGS_ENABLED kill switch and returns an empty list (not an
// error) when disabled.
func (s *ShortsServer) ListAgencyPriceStats(ctx context.Context, req *connect.Request[shortsv1alpha1.ListAgencyPriceStatsRequest]) (*connect.Response[shortsv1alpha1.ListAgencyPriceStatsResponse], error) {
	m := req.Msg
	params, paramErr := normalizeHousingParams(housingParams{
		stateCode: m.StateCode, sort: m.Sort, limit: m.Limit,
	}, housingParamRules{
		defaultSort: "drops", allowedSorts: map[string]struct{}{"drops": {}, "listings": {}, "avg_cut": {}, "value": {}},
		defaultLimit: 20, maxLimit: 100,
	})
	if paramErr != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, paramErr)
	}
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.ListAgencyPriceStatsResponse{}), nil
	}
	cacheKey := s.cache.GetAgencyPriceStatsKey(params.stateCode, params.sort, params.limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListAgencyPriceStats(params.stateCode, params.sort, params.limit)
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

// dropIndexTrackingSince is 2026-08-13. This is NOT about catalog growth —
// the panel is now sourced from actual sweeps in a trailing window (see
// services/house-price-collector/drop_index.go), which fixed that. It is
// about the numerator's own event window: price_drop events begin 2026-07-14
// in prod, so a trailing 30-day drop-rate numerator is not COMPLETE until 30
// days later, on 2026-08-13 — before that the index rises purely because its
// own event window is still filling in, not because discounting increased.
const dropIndexTrackingSince = "2026-08-13"

// dropIndexGrains are the only grains housing_drop_index_daily holds.
var dropIndexGrains = map[string]struct{}{"national": {}, "state": {}, "suburb": {}}

// dropIndexParams is a validated, normalized GetDropIndexSeries request.
type dropIndexParams struct {
	grain, grainKey, from, to string
}

// normalizeDropIndexParams validates GetDropIndexSeries input. It is a public,
// anonymous RPC whose inputs become a MemoryCache key and a ::date cast, so
// every field is allow-listed or parsed rather than passed through: a malformed
// date used to reach Postgres and come back as CodeInternal, and an arbitrary
// grain_key minted an unbounded number of cache entries. Anything outside the
// documented shapes is InvalidArgument.
//
//   - grain: 'national' (default) | 'state' | 'suburb'.
//   - grain_key: 'AU' for national (the default), an Australian state code for
//     state, a 5-digit ABS SAL code for suburb.
//   - from/to: 'YYYY-MM-DD'. from is clamped up to dropIndexTrackingSince; to
//     defaults to — and is capped at — today (UTC), so a future date cannot
//     mint a fresh cache key per day.
func normalizeDropIndexParams(m *shortsv1alpha1.GetDropIndexSeriesRequest, today time.Time) (dropIndexParams, error) {
	p := dropIndexParams{
		grain:    strings.ToLower(strings.TrimSpace(m.GetGrain())),
		grainKey: strings.ToUpper(strings.TrimSpace(m.GetGrainKey())),
	}
	if p.grain == "" {
		p.grain = "national"
	}
	if _, ok := dropIndexGrains[p.grain]; !ok {
		return p, fmt.Errorf("grain must be one of national, state, suburb")
	}
	switch p.grain {
	case "national":
		if p.grainKey == "" {
			p.grainKey = "AU"
		}
		if p.grainKey != "AU" {
			return p, fmt.Errorf("grain_key for grain national must be AU")
		}
	case "state":
		if _, ok := australianStateCodes[p.grainKey]; !ok {
			return p, fmt.Errorf("grain_key for grain state must be an Australian state code")
		}
	case "suburb":
		if !isSALCode(p.grainKey) {
			return p, fmt.Errorf("grain_key for grain suburb must be a 5-digit SAL code")
		}
	}

	todayISO := today.UTC().Format("2006-01-02")
	p.from = strings.TrimSpace(m.GetFrom())
	p.to = strings.TrimSpace(m.GetTo())
	for _, d := range []struct{ name, value string }{{"from", p.from}, {"to", p.to}} {
		if d.value == "" {
			continue
		}
		if _, err := time.Parse("2006-01-02", d.value); err != nil {
			return p, fmt.Errorf("%s must be a YYYY-MM-DD date", d.name)
		}
	}
	// ISO dates sort lexically, so string comparison is a date comparison.
	if p.from == "" || p.from < dropIndexTrackingSince {
		p.from = dropIndexTrackingSince
	}
	if p.to == "" || p.to > todayISO {
		p.to = todayISO
	}
	if p.from > p.to {
		return p, fmt.Errorf("to must not be before from (%s)", p.from)
	}
	return p, nil
}

// isSALCode reports whether s is an ABS Suburbs and Localities code: exactly
// five ASCII digits.
func isSALCode(s string) bool {
	if len(s) != 5 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// GetDropIndexSeries returns a stored discounting-index series for a grain
// (national/state/suburb). It never serves dates before dropIndexTrackingSince,
// rejects input outside the documented shapes (normalizeDropIndexParams), and
// honours the crawl kill switch like every other crawl-derived read
// (dropListingsEnabled).
//
// as_of is the latest computed_at among the returned points. data_through is
// the EARLIER of the latest returned snapshot's end and the crawl horizon the
// last housing MV refresh recorded: the collector computes a snapshot every
// day whether or not the crawl ran, so a dead rig keeps producing "fresh"
// snapshot dates over frozen data, and the snapshot date alone would claim a
// currency the numbers do not have.
func (s *ShortsServer) GetDropIndexSeries(ctx context.Context, req *connect.Request[shortsv1alpha1.GetDropIndexSeriesRequest]) (*connect.Response[shortsv1alpha1.GetDropIndexSeriesResponse], error) {
	p, paramErr := normalizeDropIndexParams(req.Msg, time.Now())
	if paramErr != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, paramErr)
	}
	if !dropListingsEnabled() {
		return connect.NewResponse(&shortsv1alpha1.GetDropIndexSeriesResponse{TrackingSince: dropIndexTrackingSince}), nil
	}

	cacheKey := s.cache.GetDropIndexSeriesKey(p.grain, p.grainKey, p.from, p.to)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetDropIndexSeries(p.grain, p.grainKey, p.from, p.to)
		if err != nil {
			return nil, err
		}
		resp := &shortsv1alpha1.GetDropIndexSeriesResponse{TrackingSince: dropIndexTrackingSince}
		resp.Points = make([]*shortsv1alpha1.DropIndexPoint, 0, len(rows))
		var computedAt time.Time
		lastSnapshot := ""
		for _, r := range rows {
			if r == nil {
				continue
			}
			resp.Points = append(resp.Points, &shortsv1alpha1.DropIndexPoint{
				SnapshotDate: r.SnapshotDate, DropRate: r.DropRate, MedianDropPct: r.MedianDropPct,
				PanelSuburbs: r.PanelSuburbs, CoverageRatio: r.CoverageRatio, IsGap: r.IsGap,
				ActiveAddresses: r.ActiveAddresses, DroppedAddresses: r.DroppedAddresses,
				WithdrawnThenRelisted: r.WithdrawnThenRelisted, DelistedCount: r.DelistedCount,
			})
			if r.ComputedAt.After(computedAt) {
				computedAt = r.ComputedAt
			}
			if r.SnapshotDate > lastSnapshot {
				lastSnapshot = r.SnapshotDate
			}
		}
		if len(resp.Points) == 0 {
			return resp, nil
		}
		if !computedAt.IsZero() {
			resp.AsOf = timestamppb.New(computedAt)
		}
		if day, err := time.Parse("2006-01-02", lastSnapshot); err == nil {
			through := day.Add(24*time.Hour - time.Second)
			if _, crawl := s.dropsFreshness(mvStatePriceDrops); crawl != nil && crawl.AsTime().Before(through) {
				through = crawl.AsTime()
			}
			resp.DataThrough = timestamppb.New(through)
		}
		return resp, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetDropIndexSeries: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get drop index series"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetDropIndexSeriesResponse)), nil
}
