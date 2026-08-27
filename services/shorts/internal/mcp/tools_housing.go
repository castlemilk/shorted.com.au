package mcp

import (
	"context"
	"fmt"
	"os"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Australian housing tools.
//
// These four wrap HousingService, and they are the one place in this package
// where the projection is a LICENCE control rather than a payload one.
//
// The housing subsystem carries two incompatible classes of data on the same
// messages (docs/feature/housing/data-sources.md, README rule 1):
//
//   - ABS, RBA, state Valuer-General, AEC and BOCSAR data is CC-BY. It may be
//     republished with attribution, which is why every series here travels with
//     its source and licence rather than being stripped to bare numbers.
//   - REA, Domain and property.com.au rows carry
//     source_licence='proprietary-tos-restricted' — a column DEFAULT, so the
//     unlicensed state is unstorable. They are NEVER republished raw. Only
//     derived aggregates are a publishable surface.
//
// An MCP tool is republication in its strongest form: the result is pasted into
// a third-party model that will quote it back to a user, out of context and
// without our page's framing. So these tools take the second rule literally:
//
//  1. Counts and medians only from the crawl tiers. No addresses, no listing
//     URLs, no agencies, no per-property facts. The RPCs that serve those
//     (ListSuburbDropListings, ListAddressPriceDrops, GetPropertyHistory,
//     ListAgencyPriceStats) are deliberately NOT on DataSource.
//  2. No extrema. `SuburbPriceDrop.max_drop_abs` is "the largest single
//     reduction" — one restricted listing's exact price movement with an
//     aggregate's name on it. Neither max field is projected, nor
//     dropped_value, which is the same disclosure one step of arithmetic away.
//  3. A k-anonymity floor of kAnonFloor. README's known-open list records that
//     the database rollups floor AGENCIES at three dropped addresses but not
//     SUBURBS, so a one-listing suburb publishes that listing's exact price
//     through the suburb median. This surface closes that gap in the
//     projection: an aggregate over fewer than kAnonFloor listings is dropped,
//     and its suppression is reported rather than hidden.
//  4. The kill switch is honoured before the RPC, not after. A takedown must be
//     one env flip away on every surface that reads crawl rows.
const (
	// kAnonFloor is the minimum number of underlying ToS-restricted listings
	// behind a crawl-derived aggregate before this surface will publish it.
	// Three matches the floor migration 000086 already applies to agency drop
	// depth; below it, a "median" is an individual listing's price.
	kAnonFloor = 3

	// maxHousingSeriesPoints caps a house-price series. These are QUARTERLY, so
	// a full ABS run since 2003 is roughly 90 points and this rarely binds —
	// it exists for the RBA monthly tables and for any region whose history is
	// longer than expected.
	maxHousingSeriesPoints = 160

	// maxHousingOverviewMetrics caps the headline grid. Unfiltered, the RPC
	// returns national + state + capital-city rows across four measures, which
	// is well inside this; the cap bounds a future region_type that is not.
	maxHousingOverviewMetrics = 60

	defaultSuburbDropsLimit = 20
	// maxSuburbDropsLimit sits far inside the handler's own 500 ceiling. The
	// price-drops board is a shortlist to reason over, not an export, and every
	// row is derived from restricted data.
	maxSuburbDropsLimit = 50

	// restrictedLicence is the sentinel that must never reach a published
	// surface. It is a column DEFAULT in the database, so its absence is the
	// affirmative signal, not its presence.
	restrictedLicence = "proprietary-tos-restricted"

	// housingAttribution is a licence obligation, not a footnote: CC-BY
	// requires attribution wherever the data is republished, and a tool result
	// travels without the page that would otherwise carry it.
	housingAttribution = "ABS, RBA and state Valuer-General data, CC-BY 4.0."

	// crawlAggregateCaveat travels with every crawl-derived number, because the
	// single most likely misreading is treating an asking-price median as a
	// sale-price median.
	crawlAggregateCaveat = "These are derived aggregates over current for-sale portal listings — " +
		"asking prices, not settled sales, and not comparable with Valuer-General medians."
)

// australianStates mirrors the handler's own set (house_prices.go). Validating
// here turns a typo into an actionable tool error rather than a Connect
// InvalidArgument the model has to decode.
var australianStates = []string{"ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"}

// overviewRegionTypes is narrower than the RPC's own set on purpose: passing
// "suburb" makes the RPC return every quarterly-ingested suburb (~350 Adelaide
// rows today), which is neither a headline nor within the payload budget.
var overviewRegionTypes = []string{"national", "state", "gccsa"}

// dropListingsEnabled re-reads HOUSING_DROP_LISTINGS_ENABLED, the kill switch
// that gates every surface built on ToS-restricted REA/Domain listing rows.
// Duplicated from the shorts package rather than imported because that package
// imports this one; the semantics (enabled by DEFAULT, falsey values only turn
// it off) are copied exactly, and a drift shows up as this surface staying live
// after a takedown — which is why the duplication is called out here.
func dropListingsEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("HOUSING_DROP_LISTINGS_ENABLED"))) {
	case "false", "0", "off", "no":
		return false
	default:
		return true
	}
}

// isoDay renders a proto timestamp as a plain date. Housing observations are
// quarterly or monthly period ends; a full RFC3339 stamp implies a precision
// that does not exist and costs three times the bytes.
func isoDay(ts *timestamppb.Timestamp) string {
	if ts == nil {
		return ""
	}
	return ts.AsTime().UTC().Format("2006-01-02")
}

// aboveFloor returns value only when at least kAnonFloor observations stand
// behind it, and zero otherwise. One call site per published crawl aggregate,
// so the floor cannot be applied to some and forgotten on others.
func aboveFloor(count int32, value float64) float64 {
	if count < kAnonFloor {
		return 0
	}
	return value
}

// pctOfFraction converts the proto's 0..1 drop fractions to percentages. The
// wire format says "0.06"; a model reading that alongside a yoy_pct of "4.5"
// will get one of them wrong, so this surface publishes percentages throughout.
func pctOfFraction(v float64) float64 {
	return round2(v * 100)
}

// round2 rounds to two decimal places.
//
// The finite() guard is load-bearing and its absence was WORSE here than on
// the paths that marshal a raw float64. Converting a non-finite float to int64
// is undefined in Go, and in practice saturates: round2(+Inf) returned
// 9.223372036854776e+16 and round2(NaN) returned 0. So this path did not fail
// loudly like encoding/json does — it silently published a median house price
// of ninety-two quadrillion dollars as though it were a measurement. Every
// housing and economy float goes through here.
func round2(v float64) float64 {
	v = finite(v)
	return float64(int64(v*100+sign(v)*0.5)) / 100
}

func sign(v float64) float64 {
	if v < 0 {
		return -1
	}
	return 1
}

func normaliseState(raw string) (string, error) {
	state := strings.ToUpper(strings.TrimSpace(raw))
	if state == "" {
		return "", nil
	}
	if !contains(australianStates, state) {
		return "", fmt.Errorf("%q is not an Australian state or territory code: use one of %s",
			raw, strings.Join(australianStates, ", "))
	}
	return state, nil
}

// ---------------------------------------------------------------------------
// get_housing_overview
// ---------------------------------------------------------------------------

type GetHousingOverviewInput struct {
	RegionType string `json:"region_type,omitempty" jsonschema:"Restrict to one geography: national, state or gccsa (greater capital city). Omit for all three."`
}

type HousingOverviewMetric struct {
	Region       string  `json:"region"`
	RegionCode   string  `json:"region_code" jsonschema:"Pass to get_house_price_series, e.g. AUS, NSW, 1GSYD."`
	RegionType   string  `json:"region_type"`
	State        string  `json:"state,omitempty"`
	Measure      string  `json:"measure" jsonschema:"e.g. mean_price, median_price, price_index, debt_to_income."`
	DwellingType string  `json:"dwelling_type,omitempty"`
	Value        float64 `json:"value"`
	Unit         string  `json:"unit" jsonschema:"AUD, index or ratio."`
	Period       string  `json:"period" jsonschema:"Period end, YYYY-MM-DD."`
	QoQPct       float64 `json:"qoq_pct" jsonschema:"Change on the previous quarter, percent."`
	YoYPct       float64 `json:"yoy_pct" jsonschema:"Change on a year earlier, percent."`
	Preliminary  bool    `json:"preliminary,omitempty" jsonschema:"Subject to revision."`
}

type GetHousingOverviewOutput struct {
	AsOf    string                  `json:"as_of,omitempty" jsonschema:"Latest period covered, YYYY-MM-DD."`
	Count   int                     `json:"count"`
	Metrics []HousingOverviewMetric `json:"metrics" jsonschema:"Latest observation per region and measure."`
	Source  string                  `json:"source" jsonschema:"Attribution required by the licence."`
	Note    string                  `json:"note,omitempty"`
}

const getHousingOverviewDescription = "Latest Australian house-price headline metrics: mean and median dwelling " +
	"price (AUD), a price index, and household debt-to-income, for the nation, each state and territory, and the " +
	"greater capital cities, with quarter-on-quarter and year-on-year change. " +
	"Sources are ABS quarterly releases and RBA statistical tables, CC-BY 4.0. ABS data is published about two " +
	"months after the quarter ends, so the latest figure is normally one quarter behind — much slower than the " +
	"ASIC short data other tools return. A price_index sourced 'abs_derived' is a rebase of ABS mean prices, NOT " +
	"the ABS hedonic RPPI (frozen upstream at 2021-Q4). No suburb geography here: use get_suburb_profile for a " +
	"suburb, or get_house_price_series for the history behind any row."

func getHousingOverviewTool() Tool {
	tool := Tool{
		Name:        "get_housing_overview",
		Title:       "Australian house-price headline metrics",
		Description: getHousingOverviewDescription,
		RPC:         "shorts.v1alpha1.HousingService.GetHousingOverview",
		Domain:      "housing",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getHousingOverviewHandler(src))
	}
	return tool
}

func getHousingOverviewHandler(src DataSource) sdk.ToolHandlerFor[GetHousingOverviewInput, GetHousingOverviewOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetHousingOverviewInput) (*sdk.CallToolResult, GetHousingOverviewOutput, error) {
		regionType := strings.ToLower(strings.TrimSpace(in.RegionType))
		if regionType != "" && !contains(overviewRegionTypes, regionType) {
			if regionType == "suburb" {
				return nil, GetHousingOverviewOutput{}, fmt.Errorf(
					"this tool covers national, state and capital-city geographies only; " +
						"for one suburb call get_suburb_profile")
			}
			return nil, GetHousingOverviewOutput{}, fmt.Errorf(
				"%q is not a supported region_type: use one of %s", in.RegionType,
				strings.Join(overviewRegionTypes, ", "))
		}

		res, err := src.GetHousingOverview(ctx, connect.NewRequest(&shortsv1alpha1.GetHousingOverviewRequest{
			RegionType: regionType,
		}))
		if err != nil {
			return nil, GetHousingOverviewOutput{}, fmt.Errorf("could not read housing headline metrics: %w", err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetHousingOverviewOutput{}, fmt.Errorf("no housing data returned")
		}

		out := GetHousingOverviewOutput{
			AsOf:    isoDay(res.Msg.GetAsOf()),
			Metrics: []HousingOverviewMetric{},
			Source:  housingAttribution,
		}
		metrics := res.Msg.GetMetrics()
		if len(metrics) > maxHousingOverviewMetrics {
			out.Note = fmt.Sprintf("Showing the first %d of %d metrics; narrow with region_type.",
				maxHousingOverviewMetrics, len(metrics))
			metrics = metrics[:maxHousingOverviewMetrics]
		}
		for _, m := range metrics {
			if m == nil {
				continue
			}
			out.Metrics = append(out.Metrics, HousingOverviewMetric{
				Region:       m.GetRegionName(),
				RegionCode:   m.GetRegionCode(),
				RegionType:   m.GetRegionType(),
				State:        m.GetStateCode(),
				Measure:      m.GetMeasure(),
				DwellingType: m.GetDwellingType(),
				Value:        round2(m.GetValue()),
				Unit:         m.GetUnit(),
				Period:       isoDay(m.GetPeriod()),
				QoQPct:       round2(m.GetQoqPct()),
				YoYPct:       round2(m.GetYoyPct()),
				Preliminary:  m.GetIsPreliminary(),
			})
		}
		out.Count = len(out.Metrics)

		summary := fmt.Sprintf("No housing headline metrics are available%s.", forRegionType(regionType))
		if out.Count > 0 {
			summary = fmt.Sprintf("%d Australian house-price headline metrics%s, latest period %s. %s",
				out.Count, forRegionType(regionType), nonEmpty(out.AsOf, "unknown"), housingAttribution)
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

func forRegionType(regionType string) string {
	if regionType == "" {
		return ""
	}
	return " for region_type " + regionType
}

// ---------------------------------------------------------------------------
// get_house_price_series
// ---------------------------------------------------------------------------

type GetHousePriceSeriesInput struct {
	RegionCode   string `json:"region_code" jsonschema:"Region code from get_housing_overview, e.g. AUS, NSW, 1GSYD. Required."`
	Measure      string `json:"measure" jsonschema:"Measure to chart, e.g. mean_price, median_price, price_index, debt_to_income. Required."`
	DwellingType string `json:"dwelling_type,omitempty" jsonschema:"all, established_house or attached. Defaults to all."`
}

type HousePriceSeriesPoint struct {
	Period      string  `json:"period" jsonschema:"Period end, YYYY-MM-DD."`
	Value       float64 `json:"value"`
	Preliminary bool    `json:"preliminary,omitempty" jsonschema:"Subject to revision."`
}

type GetHousePriceSeriesOutput struct {
	RegionCode    string                  `json:"region_code"`
	Region        string                  `json:"region,omitempty"`
	Measure       string                  `json:"measure"`
	DwellingType  string                  `json:"dwelling_type"`
	Unit          string                  `json:"unit,omitempty" jsonschema:"AUD, index or ratio."`
	Source        string                  `json:"source,omitempty" jsonschema:"e.g. abs, rba, abs_derived, vg_nsw."`
	SourceLicence string                  `json:"source_licence,omitempty" jsonschema:"Attribution is a condition of reuse."`
	Count         int                     `json:"count"`
	Points        []HousePriceSeriesPoint `json:"points" jsonschema:"Oldest first."`
	Note          string                  `json:"note,omitempty"`
}

const getHousePriceSeriesDescription = "One Australian house-price time series for a region and measure — the " +
	"history behind a get_housing_overview row, oldest first, with its source and licence. Most series are " +
	"QUARTERLY (ABS, published about two months after the quarter ends); RBA measures such as debt-to-income are " +
	"monthly. Downsampled to at most 160 evenly-spaced points, always keeping the first and the latest. " +
	"Call get_housing_overview first for valid region_code and measure values: guessing returns an empty series, " +
	"not a correction. Official CC-BY data only — a licence-restricted series is refused rather than returned."

func getHousePriceSeriesTool() Tool {
	tool := Tool{
		Name:        "get_house_price_series",
		Title:       "House-price time series",
		Description: getHousePriceSeriesDescription,
		RPC:         "shorts.v1alpha1.HousingService.GetHousePriceSeries",
		Domain:      "housing",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getHousePriceSeriesHandler(src))
	}
	return tool
}

func getHousePriceSeriesHandler(src DataSource) sdk.ToolHandlerFor[GetHousePriceSeriesInput, GetHousePriceSeriesOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetHousePriceSeriesInput) (*sdk.CallToolResult, GetHousePriceSeriesOutput, error) {
		regionCode := strings.ToUpper(strings.TrimSpace(in.RegionCode))
		measure := strings.ToLower(strings.TrimSpace(in.Measure))
		dwelling := strings.ToLower(strings.TrimSpace(in.DwellingType))
		if dwelling == "" {
			dwelling = "all"
		}
		if regionCode == "" {
			return nil, GetHousePriceSeriesOutput{}, fmt.Errorf(
				"region_code is required: call get_housing_overview for the available region codes")
		}
		if measure == "" {
			return nil, GetHousePriceSeriesOutput{}, fmt.Errorf(
				"measure is required, e.g. median_price: call get_housing_overview for the measures a region publishes")
		}

		res, err := src.GetHousePriceSeries(ctx, connect.NewRequest(&shortsv1alpha1.GetHousePriceSeriesRequest{
			RegionCode: regionCode, Measure: measure, DwellingType: dwelling,
		}))
		if err != nil {
			return nil, GetHousePriceSeriesOutput{}, fmt.Errorf(
				"could not read the %s series for %s: %w", measure, regionCode, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetHousePriceSeriesOutput{}, fmt.Errorf(
				"no series returned for %s / %s", regionCode, measure)
		}
		msg := res.Msg

		// The store already excludes proprietary-tos-restricted rows in SQL.
		// This is the second reading of the same rule, on the surface that
		// would actually do the republishing: refuse rather than hand a
		// restricted series to a model that will quote it.
		if strings.EqualFold(msg.GetSourceLicence(), restrictedLicence) {
			return nil, GetHousePriceSeriesOutput{}, fmt.Errorf(
				"the %s series for %s carries a restricted source licence (%s) and cannot be republished; "+
					"official Valuer-General and ABS medians are available instead",
				measure, regionCode, restrictedLicence)
		}

		out := GetHousePriceSeriesOutput{
			RegionCode:    nonEmpty(msg.GetRegionCode(), regionCode),
			Region:        msg.GetRegionName(),
			Measure:       nonEmpty(msg.GetMeasure(), measure),
			DwellingType:  nonEmpty(msg.GetDwellingType(), dwelling),
			Unit:          msg.GetUnit(),
			Source:        msg.GetSource(),
			SourceLicence: msg.GetSourceLicence(),
			Points:        []HousePriceSeriesPoint{},
		}
		points := msg.GetPoints()
		if len(points) > maxHousingSeriesPoints {
			out.Note = fmt.Sprintf("Downsampled from %d observations to %d evenly-spaced points; "+
				"the first and latest are always kept.", len(points), maxHousingSeriesPoints)
			points = downsample(points, maxHousingSeriesPoints)
		}
		for _, p := range points {
			if p == nil {
				continue
			}
			out.Points = append(out.Points, HousePriceSeriesPoint{
				Period:      isoDay(p.GetPeriod()),
				Value:       round2(p.GetValue()),
				Preliminary: p.GetIsPreliminary(),
			})
		}
		out.Count = len(out.Points)

		var summary string
		if out.Count == 0 {
			summary = fmt.Sprintf("No %s series exists for region %s (dwelling type %s). "+
				"Call get_housing_overview to see which regions and measures are published.",
				measure, regionCode, dwelling)
		} else {
			last := out.Points[out.Count-1]
			summary = fmt.Sprintf("%s %s for %s: %d observations to %s, latest %.2f %s. Source: %s (%s).",
				nonEmpty(out.Region, out.RegionCode), out.Measure, out.DwellingType,
				out.Count, last.Period, last.Value, nonEmpty(out.Unit, "units"),
				nonEmpty(out.Source, "unknown"), nonEmpty(out.SourceLicence, "licence unstated"))
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: summary}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// get_suburb_profile
// ---------------------------------------------------------------------------

type GetSuburbProfileInput struct {
	SalCode string `json:"sal_code" jsonschema:"ABS Suburb and Locality (SAL) code, e.g. SAL21234. Required."`
}

// GetSuburbProfileOutput is flat by construction. The RPC's response nests nine
// messages and roughly 130 fields (amenity counts, terrain, council financials,
// similar-suburb lists, editorial banner copy); a nested projection would cost
// several kilobytes of tools/list preamble that every client pays before asking
// anything. What is kept is the set a question about a suburb actually needs.
type GetSuburbProfileOutput struct {
	SalCode  string `json:"sal_code"`
	Suburb   string `json:"suburb"`
	State    string `json:"state"`
	Postcode string `json:"postcode,omitempty"`

	MedianPrice       float64 `json:"median_price,omitempty" jsonschema:"Valuer-General median house price, AUD. Absent where no VG feed exists."`
	MedianPricePeriod string  `json:"median_price_period,omitempty" jsonschema:"YYYY-MM-DD; can be over a year old."`
	MedianPriceYoYPct float64 `json:"median_price_yoy_pct,omitempty" jsonschema:"Percent."`

	Population                  int32   `json:"population,omitempty"`
	MedianAge                   float64 `json:"median_age,omitempty" jsonschema:"Years."`
	MedianWeeklyHouseholdIncome float64 `json:"median_weekly_household_income,omitempty" jsonschema:"AUD."`
	MedianWeeklyRent            float64 `json:"median_weekly_rent,omitempty" jsonschema:"AUD."`
	MedianMonthlyMortgage       float64 `json:"median_monthly_mortgage,omitempty" jsonschema:"AUD."`
	PctRented                   float64 `json:"pct_rented,omitempty" jsonschema:"Percent of dwellings."`
	PctBornOverseas             float64 `json:"pct_born_overseas,omitempty" jsonschema:"Percent."`
	TopLanguage                 string  `json:"top_language,omitempty" jsonschema:"Most spoken language at home other than English."`
	PctTopLanguage              float64 `json:"pct_top_language,omitempty" jsonschema:"Percent."`
	CensusYear                  int32   `json:"census_year,omitempty"`

	SeifaIrsadDecileAus   int32 `json:"seifa_irsad_decile_aus,omitempty" jsonschema:"ABS SEIFA advantage/disadvantage decile within Australia, 1 (most disadvantaged) to 10."`
	SeifaIrsadDecileState int32 `json:"seifa_irsad_decile_state,omitempty" jsonschema:"The same decile within the state."`

	FederalDivision string `json:"federal_division,omitempty"`
	FederalMember   string `json:"federal_member,omitempty"`
	FederalParty    string `json:"federal_party,omitempty"`
	StateDistrict   string `json:"state_district,omitempty"`
	StateMember     string `json:"state_member,omitempty" jsonschema:"Empty for TAS and ACT, which are multi-member."`
	StateParty      string `json:"state_party,omitempty"`

	Council             string  `json:"council,omitempty" jsonschema:"Local government area."`
	StateMedianPrice    float64 `json:"state_median_price,omitempty" jsonschema:"AUD, for comparison."`
	NationalMedianPrice float64 `json:"national_median_price,omitempty" jsonschema:"AUD, for comparison."`

	CrimeBreakInsRank     float64 `json:"crime_break_ins_rank,omitempty" jsonschema:"Percentile WITHIN THE SUBURB'S OWN STATE, 0-100, higher = more reported crime."`
	CrimeViolentRank      float64 `json:"crime_violent_rank,omitempty" jsonschema:"Same basis, 0-100."`
	CrimeMotorVehicleRank float64 `json:"crime_motor_vehicle_rank,omitempty" jsonschema:"Same basis, 0-100."`
	CrimeJurisdiction     string  `json:"crime_jurisdiction,omitempty" jsonschema:"Jurisdiction the percentiles rank within."`

	ListingsForSaleCount int32   `json:"listings_for_sale_count,omitempty" jsonschema:"Listings captured, not a market total."`
	ListingsMedianAsking float64 `json:"listings_median_asking,omitempty" jsonschema:"Median ASKING price, AUD. Currently always withheld — the k-anonymity floor cannot be keyed correctly against the available counts."`
	ListingsSoldCount    int32   `json:"listings_sold_count,omitempty"`
	ListingsMedianSold   float64 `json:"listings_median_sold,omitempty" jsonschema:"AUD. Suppressed below three. Not a Valuer-General median."`
	ListingsNote         string  `json:"listings_note,omitempty"`

	Note string `json:"note,omitempty"`
}

const getSuburbProfileDescription = "Profile of one Australian suburb by ABS SAL code: Valuer-General median house " +
	"price, ABS Census 2021 demographics, SEIFA decile, federal and state representation, council, state and " +
	"national median comparisons, and crime percentiles. " +
	"Vintages differ and matter. Demographics are Census 2021. Median prices are quarterly state Valuer-General " +
	"releases and can be over a year old; only NSW, VIC and SA publish them, so QLD, WA, TAS, NT and ACT suburbs " +
	"have none. Crime percentiles are two-year pooled financial years, NSW only, ranked WITHIN the suburb's own " +
	"state and never across states. " +
	"Also returns counts and medians derived from current for-sale portal listings: asking prices, not sales, not " +
	"comparable with a Valuer-General median, and suppressed where fewer than three listings stand behind them. " +
	"No addresses, listing links or individual properties are returned by any tool here. " +
	"Use get_housing_overview for state and national aggregates."

func getSuburbProfileTool() Tool {
	tool := Tool{
		Name:        "get_suburb_profile",
		Title:       "Australian suburb profile",
		Description: getSuburbProfileDescription,
		RPC:         "shorts.v1alpha1.HousingService.GetSuburbProfile",
		Domain:      "housing",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getSuburbProfileHandler(src))
	}
	return tool
}

func getSuburbProfileHandler(src DataSource) sdk.ToolHandlerFor[GetSuburbProfileInput, GetSuburbProfileOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetSuburbProfileInput) (*sdk.CallToolResult, GetSuburbProfileOutput, error) {
		salCode := strings.TrimSpace(in.SalCode)
		if salCode == "" {
			return nil, GetSuburbProfileOutput{}, fmt.Errorf(
				"sal_code is required: it is the ABS Suburb and Locality code, e.g. SAL21234")
		}

		res, err := src.GetSuburbProfile(ctx, connect.NewRequest(&shortsv1alpha1.GetSuburbProfileRequest{
			SalCode: salCode,
		}))
		if err != nil {
			if connect.CodeOf(err) == connect.CodeNotFound {
				return nil, GetSuburbProfileOutput{}, fmt.Errorf(
					"no suburb exists with SAL code %s", salCode)
			}
			return nil, GetSuburbProfileOutput{}, fmt.Errorf(
				"could not read the profile for %s: %w", salCode, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetSuburbProfileOutput{}, fmt.Errorf("no profile returned for %s", salCode)
		}
		msg := res.Msg
		summary := msg.GetSummary()
		if summary == nil {
			return nil, GetSuburbProfileOutput{}, fmt.Errorf("no suburb exists with SAL code %s", salCode)
		}
		demo := msg.GetDemographics()
		base := msg.GetBaselines()

		out := GetSuburbProfileOutput{
			SalCode:  summary.GetSalCode(),
			Suburb:   summary.GetSalName(),
			State:    summary.GetStateCode(),
			Postcode: summary.GetPostcode(),

			MedianPrice:       round2(summary.GetLatestMedianPrice()),
			MedianPricePeriod: isoDay(summary.GetLatestPeriod()),
			MedianPriceYoYPct: round2(summary.GetYoyPct()),

			Population:                  summary.GetPopulation(),
			MedianAge:                   round2(summary.GetMedianAge()),
			MedianWeeklyHouseholdIncome: round2(summary.GetMedianWeeklyHhdIncome()),
			MedianWeeklyRent:            round2(demo.GetMedianWeeklyRent()),
			MedianMonthlyMortgage:       round2(demo.GetMedianMonthlyMortgage()),
			PctRented:                   round2(demo.GetPctRented()),
			PctBornOverseas:             round2(summary.GetPctBornOverseas()),
			TopLanguage:                 summary.GetTopLanguage(),
			PctTopLanguage:              round2(summary.GetPctTopLanguage()),
			CensusYear:                  demo.GetCensusYear(),

			SeifaIrsadDecileAus:   summary.GetSeifa().GetIrsad().GetDecileAus(),
			SeifaIrsadDecileState: summary.GetSeifa().GetIrsad().GetDecileState(),

			FederalDivision: summary.GetFederalDivision(),
			FederalMember:   summary.GetFederalMember(),
			FederalParty:    summary.GetFederalParty(),
			StateDistrict:   summary.GetStateDistrict(),
			StateMember:     summary.GetStateMember(),
			StateParty:      summary.GetStateParty(),

			Council:             msg.GetCouncil().GetLgaName(),
			StateMedianPrice:    round2(base.GetStateMedianPrice()),
			NationalMedianPrice: round2(base.GetNationalMedianPrice()),

			CrimeJurisdiction: msg.GetCrime().GetSourceJurisdiction(),
		}

		// Crime percentiles are read from the gated crime block rather than the
		// summary's mirrored scalars, so a rank can never be published without
		// the jurisdiction it is ranked within. Small-population and
		// statistically-unreliable suburbs are already excluded server-side; an
		// absent block means no reliable data, which is why the fields are
		// omitempty rather than zero-filled.
		for _, stat := range msg.GetCrime().GetStats() {
			switch stat.GetCrimeType() {
			case "break_ins":
				out.CrimeBreakInsRank = round2(stat.GetPctRank())
			case "violent":
				out.CrimeViolentRank = round2(stat.GetPctRank())
			case "motor_vehicle":
				out.CrimeMotorVehicleRank = round2(stat.GetPctRank())
			}
		}

		// Crawl-derived block. An absent message is how the handler delivers the
		// HOUSING_DROP_LISTINGS_ENABLED kill switch (it strips listing_stats on
		// read), and it is also what an out-of-catalog suburb looks like. Either
		// way the honest answer is "not available", never a zero a model would
		// read as "no listings for sale here".
		//
		// The switch is re-read here rather than trusted: the handler applies it
		// post-cache today, but a refactor that moved the strip inside the cached
		// build would keep serving stripped-elsewhere data here for a whole TTL
		// after a takedown. Two independent readings, one of which is on the
		// surface doing the republishing.
		if stats := msg.GetListingStats(); stats == nil || !dropListingsEnabled() {
			out.ListingsNote = "No portal listing aggregates are available for this suburb."
		} else {
			out.ListingsForSaleCount = stats.GetForSaleCount()
			out.ListingsSoldCount = stats.GetSoldCount()
			// median_asking is WITHHELD, not floored. The k-anon floor needs the
			// count the median was computed over, and the only count on this
			// message is for_sale_count — every ACTIVE listing. mv_suburb_listing_stats
			// computes median_asking over PRICED listings only
			// (PERCENTILE_CONT ... FILTER (WHERE price IS NOT NULL)), and
			// "contact agent" listings are common. So a suburb with three active
			// listings of which one carries a price clears a floor keyed to
			// for_sale_count while the "median" IS that one listing's exact,
			// attributable asking price — the precise disclosure the floor exists
			// to stop.
			//
			// SuburbListingStats has no for_sale_priced field to floor against
			// (StatePriceDropSummary does, at housing.proto:728). Until that field
			// is surfaced here, or mv_suburb_listing_stats nulls the median below
			// the floor itself, the honest answer is to publish nothing:
			// ambiguity resolves to withholding.
			out.ListingsMedianAsking = 0
			out.ListingsMedianSold = aboveFloor(stats.GetSoldCount(), round2(stats.GetMedianSold()))
			out.ListingsNote = crawlAggregateCaveat
			if out.ListingsMedianAsking == 0 || out.ListingsMedianSold == 0 {
				out.ListingsNote += fmt.Sprintf(
					" A median is withheld where fewer than %d listings stand behind it.", kAnonFloor)
			}
		}

		if out.MedianPrice == 0 {
			out.Note = "No Valuer-General median price is published for this suburb. " +
				"Only NSW, VIC and SA have a Valuer-General feed."
		} else {
			out.Note = fmt.Sprintf("Median price is a state Valuer-General figure for the period ending %s. %s",
				nonEmpty(out.MedianPricePeriod, "unknown"), housingAttribution)
		}

		text := fmt.Sprintf("%s, %s%s. Population %d (Census %d).",
			nonEmpty(out.Suburb, salCode), nonEmpty(out.State, "unknown state"),
			postcodeSuffix(out.Postcode), out.Population, out.CensusYear)
		if out.MedianPrice > 0 {
			text += fmt.Sprintf(" Valuer-General median house price $%.0f as at %s.",
				out.MedianPrice, out.MedianPricePeriod)
		} else {
			text += " No Valuer-General median house price is published for this suburb."
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
	}
}

func postcodeSuffix(postcode string) string {
	if postcode == "" {
		return ""
	}
	return " " + postcode
}

// ---------------------------------------------------------------------------
// list_suburb_price_drops
// ---------------------------------------------------------------------------

// suburbDropSorts excludes the RPC's own "max" and "sold" orderings. Sorting by
// a value this surface refuses to publish would rank suburbs by an invisible
// extremum, which is both useless to the caller and a hint at the very number
// the projection withholds.
var suburbDropSorts = []string{"count", "avg", "asking"}

type ListSuburbPriceDropsInput struct {
	State string `json:"state,omitempty" jsonschema:"State or territory code to restrict to, e.g. NSW. Omit for national."`
	Sort  string `json:"sort,omitempty" jsonschema:"Ranking: count (most suburbs with cuts, default), avg (deepest average cut) or asking (highest asking prices)."`
	Limit int    `json:"limit,omitempty" jsonschema:"How many suburbs to return, 1-50. Defaults to 20. Higher values are clamped, not rejected."`
}

type SuburbPriceDropRow struct {
	Suburb              string  `json:"suburb"`
	SalCode             string  `json:"sal_code,omitempty" jsonschema:"Pass to get_suburb_profile."`
	Postcode            string  `json:"postcode,omitempty"`
	DroppedListingCount int32   `json:"dropped_listing_count" jsonschema:"Listings that cut their asking price."`
	TotalActiveListings int32   `json:"total_active_listings,omitempty" jsonschema:"Listings captured in the suburb."`
	DroppedSharePct     float64 `json:"dropped_share_pct" jsonschema:"Percent of captured listings."`
	AvgDropPct          float64 `json:"avg_drop_pct" jsonschema:"Mean reduction, percent."`
	MedianDropPct       float64 `json:"median_drop_pct" jsonschema:"Median reduction, percent."`
	ForSaleCount        int32   `json:"for_sale_count,omitempty" jsonschema:"Listings behind the asking median."`
	MedianAsking        float64 `json:"median_asking,omitempty" jsonschema:"Median asking price, AUD. Currently always withheld — the k-anonymity floor cannot be keyed correctly against the available counts."`
}

type ListSuburbPriceDropsOutput struct {
	State             string               `json:"state,omitempty" jsonschema:"Filter applied, empty for national."`
	Sort              string               `json:"sort"`
	Count             int                  `json:"count"`
	SuppressedSuburbs int                  `json:"suppressed_suburbs,omitempty" jsonschema:"Suburbs withheld for having too few listings behind their aggregates."`
	Suburbs           []SuburbPriceDropRow `json:"suburbs"`
	Note              string               `json:"note" jsonschema:"What these numbers are, and what was withheld."`
}

const listSuburbPriceDropsDescription = "Australian suburbs ranked by recent asking-price reductions on residential " +
	"for-sale listings. Per-suburb AGGREGATES only: how many listings cut their price, what share of the suburb's " +
	"captured listings that is, and the mean and median reduction as percentages. " +
	"These are ASKING prices on live listings — not settled sales, and not comparable with Valuer-General or ABS " +
	"medians. Coverage is a rotating crawl catalogue of a few hundred suburbs, so an absent suburb means uncrawled, " +
	"not unchanged, and freshness ranges from days to a few weeks. " +
	"The underlying listings are licence-restricted and never published: no addresses, links, agents, agencies or " +
	"individual prices, no largest-single-reduction figure, and any suburb with fewer than three price cuts is " +
	"withheld entirely. Default 20 suburbs, maximum 50. " +
	"Use get_suburb_profile for one suburb, or get_housing_overview for official price levels."

func listSuburbPriceDropsTool() Tool {
	tool := Tool{
		Name:        "list_suburb_price_drops",
		Title:       "Suburbs with the most asking-price cuts",
		Description: listSuburbPriceDropsDescription,
		RPC:         "shorts.v1alpha1.HousingService.ListSuburbPriceDrops",
		Domain:      "housing",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), listSuburbPriceDropsHandler(src))
	}
	return tool
}

func listSuburbPriceDropsHandler(src DataSource) sdk.ToolHandlerFor[ListSuburbPriceDropsInput, ListSuburbPriceDropsOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in ListSuburbPriceDropsInput) (*sdk.CallToolResult, ListSuburbPriceDropsOutput, error) {
		state, err := normaliseState(in.State)
		if err != nil {
			return nil, ListSuburbPriceDropsOutput{}, err
		}
		sort := strings.ToLower(strings.TrimSpace(in.Sort))
		if sort == "" {
			sort = "count"
		}
		if !contains(suburbDropSorts, sort) {
			return nil, ListSuburbPriceDropsOutput{}, fmt.Errorf(
				"%q is not a supported sort: use one of %s", in.Sort, strings.Join(suburbDropSorts, ", "))
		}
		limit := clampLimit(in.Limit, defaultSuburbDropsLimit, maxSuburbDropsLimit)

		// The kill switch is checked BEFORE the RPC, so a takedown stops the
		// data being read at all rather than being filtered on the way out.
		if !dropListingsEnabled() {
			out := ListSuburbPriceDropsOutput{
				State: state, Sort: sort, Suburbs: []SuburbPriceDropRow{},
				Note: "Listing-derived price-drop data is currently unavailable.",
			}
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{
				Text: "Suburb price-drop data is currently unavailable.",
			}}}, out, nil
		}

		res, err := src.ListSuburbPriceDrops(ctx, connect.NewRequest(&shortsv1alpha1.ListSuburbPriceDropsRequest{
			StateCode: state, Sort: sort, Limit: limit,
		}))
		if err != nil {
			return nil, ListSuburbPriceDropsOutput{}, fmt.Errorf("could not list suburb price drops: %w", err)
		}
		if res == nil || res.Msg == nil {
			return nil, ListSuburbPriceDropsOutput{}, fmt.Errorf("no price-drop data returned")
		}

		out := ListSuburbPriceDropsOutput{State: state, Sort: sort, Suburbs: []SuburbPriceDropRow{}}
		for _, r := range res.Msg.GetSuburbs() {
			if r == nil {
				continue
			}
			// The k-anonymity floor. Below it the suburb's "aggregates" are one
			// or two listings' exact prices, which is republication of
			// proprietary-tos-restricted rows by another name.
			if r.GetDroppedListingCount() < kAnonFloor {
				out.SuppressedSuburbs++
				continue
			}
			out.Suburbs = append(out.Suburbs, SuburbPriceDropRow{
				Suburb:              r.GetSalName(),
				SalCode:             r.GetSalCode(),
				Postcode:            r.GetPostcode(),
				DroppedListingCount: r.GetDroppedListingCount(),
				TotalActiveListings: r.GetTotalActiveListings(),
				DroppedSharePct:     pctOfFraction(r.GetDroppedShare()),
				AvgDropPct:          pctOfFraction(r.GetAvgDropPct()),
				MedianDropPct:       pctOfFraction(r.GetMedianDropPct()),
				ForSaleCount:        r.GetForSaleCount(),
				// Floored independently: a suburb can have plenty of cuts and
				// only one listing still priced.
				// Withheld — see the note in getSuburbProfileHandler. SuburbPriceDrop
				// carries for_sale_count (all active) but the median is over priced
				// listings only, so this floor cannot be keyed correctly.
				MedianAsking: 0,
			})
		}
		out.Count = len(out.Suburbs)
		out.Note = crawlAggregateCaveat + fmt.Sprintf(
			" Suburbs with fewer than %d price cuts are withheld, as are individual listings, addresses and "+
				"largest-single-reduction figures.", kAnonFloor)

		scope := "nationally"
		if state != "" {
			scope = "in " + state
		}
		var text string
		if out.Count == 0 {
			text = fmt.Sprintf("No suburbs %s currently meet the reporting threshold for asking-price cuts.", scope)
			if out.SuppressedSuburbs > 0 {
				text += fmt.Sprintf(" %d were withheld for having fewer than %d cuts.",
					out.SuppressedSuburbs, kAnonFloor)
			}
		} else {
			lead := out.Suburbs[0]
			text = fmt.Sprintf("%d suburbs %s with recent asking-price cuts, ranked by %s. "+
				"Top: %s with %d listings cut, median reduction %.1f%%. %s",
				out.Count, scope, sort, nonEmpty(lead.Suburb, "unnamed"),
				lead.DroppedListingCount, lead.MedianDropPct, crawlAggregateCaveat)
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
	}
}
