package mcp

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Australian economy tools.
//
// Three tools over the generic economic-series layer (economic_series /
// economic_observations, ~470 series) plus the company state-exposure
// aggregates. Two things shape every projection here.
//
// ATTRIBUTION IS A LICENCE CONDITION. Nearly every series is Australian Bureau
// of Statistics or Reserve Bank of Australia data republished under CC-BY 4.0,
// and CC-BY permits reuse only WITH the credit. A page carries that credit in
// its footer; a tool result has no footer, and is pasted into a third-party
// model that will quote it back to a user with no idea where it came from. So
// the credit ships inside the result — as a response-level `source`, as the
// per-series `source`/`licence` the row itself carries, and in the plain-text
// fallback, because a client may render only one of the three.
//
// VINTAGE IS NOT THE SAME AS THE REST OF THIS SERVER. The rest of these tools
// serve ASIC short positions on a T+4 business-day delay. ABS and RBA release
// on their own calendars — monthly to annual, weeks to months after the period
// they describe, and figures are revised after first publication. Reading a
// quarterly CPI print as though it were four-day-old market data is the most
// likely misreading of this domain, so the cadence is stated in every
// description and the observed `latest_period` travels with every series.
const (
	// economyAttribution is the CC-BY credit. It names both agencies because a
	// single catalogue listing routinely mixes their series, and a caller
	// filtering by topic cannot be relied on to notice which they got.
	economyAttribution = "Australian Bureau of Statistics and Reserve Bank of Australia data, CC-BY 4.0."

	defaultEconomySeriesListLimit = 25
	// maxEconomySeriesListLimit sits far inside the store's own 500 ceiling.
	// The catalogue is a shortlist to pick a key from, not an export: measured
	// against the longest realistic keys a catalogue row costs ~320 bytes, so
	// 100 rows would be a 31KB result — twice the whole per-call budget.
	maxEconomySeriesListLimit = 40

	// maxEconomySeriesPerCall is far below the handler's 50. Three series at 80
	// observations is already ~10KB of result; fifty would be an export nobody
	// reads and would blow the per-call budget many times over.
	maxEconomySeriesPerCall = 3

	// maxEconomyPointsPerSeries caps one series' observation run. The store
	// returns up to 600 (fifty years of monthly data), which is more history
	// than a question about the economy needs at full resolution.
	maxEconomyPointsPerSeries = 80

	// stateExposureCaveat travels with every state aggregate. The single most
	// likely misreading is taking these for an ABS measure of state economic
	// output, which they emphatically are not.
	stateExposureCaveat = "Exposure weights are our own operations-weighted estimate of where listed " +
		"companies operate, not an official statistic — this is not an ABS or RBA measure of state output."
)

// ---------------------------------------------------------------------------
// list_economic_series
// ---------------------------------------------------------------------------

type ListEconomicSeriesInput struct {
	Topic      string `json:"topic,omitempty" jsonschema:"e.g. cpi, labour, rates, trade, gdp, retail, approvals, population, petroleum, govfin, markets."`
	Metric     string `json:"metric,omitempty"`
	RegionType string `json:"region_type,omitempty" jsonschema:"national, state, industry or refinery."`
	RegionCode string `json:"region_code,omitempty" jsonschema:"aus, nsw, vic, qld, sa, wa, tas, nt or act."`
	Limit      int    `json:"limit,omitempty" jsonschema:"1-40, default 25. Higher values are clamped, not rejected."`
}

// EconomicSeriesInfoRow is the catalogue entry, reused as the `info` block of
// get_economic_series so the two tools describe a series identically.
type EconomicSeriesInfoRow struct {
	SeriesKey    string `json:"series_key" jsonschema:"Pass this to get_economic_series."`
	Topic        string `json:"topic"`
	Metric       string `json:"metric"`
	Region       string `json:"region"`
	RegionCode   string `json:"region_code"`
	Unit         string `json:"unit" jsonschema:"e.g. aud, percent, index, thousands."`
	Frequency    string `json:"frequency" jsonschema:"monthly, quarterly or annual."`
	Adjustment   string `json:"adjustment,omitempty" jsonschema:"original, seasadj or trend. Variants are not comparable."`
	LatestPeriod string `json:"latest_period,omitempty" jsonschema:"Most recent observation, YYYY-MM-DD."`
	Source       string `json:"source" jsonschema:"e.g. abs-cpi, rba-key-indicators, derived-shorted-markets."`
	Licence      string `json:"licence"`
}

type ListEconomicSeriesOutput struct {
	Count  int                     `json:"count"`
	Series []EconomicSeriesInfoRow `json:"series"`
	Source string                  `json:"source" jsonschema:"Attribution required by the licence."`
	Note   string                  `json:"note,omitempty"`
}

const listEconomicSeriesDescription = "Catalogue of the Australian economic series held here — the discovery " +
	"step for get_economic_series, which needs an exact series_key that cannot be guessed. Filter by topic, metric " +
	"or region. No VALUES are returned: pass the keys to get_economic_series. " +
	"ABS releases and RBA statistical tables (CC-BY 4.0), plus a few series derived from our own market data. " +
	"Released monthly to annually, weeks to months after the period they describe, and revised afterwards — not " +
	"the T+4 vintage the ASIC short-position tools return. Default 25 series, maximum 40."

func listEconomicSeriesTool() Tool {
	tool := Tool{
		Name:        "list_economic_series",
		Title:       "Australian economic series catalogue",
		Description: listEconomicSeriesDescription,
		RPC:         "shorts.v1alpha1.EconomyService.ListEconomicSeries",
		Domain:      "economy",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), listEconomicSeriesHandler(src))
	}
	return tool
}

func listEconomicSeriesHandler(src DataSource) sdk.ToolHandlerFor[ListEconomicSeriesInput, ListEconomicSeriesOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in ListEconomicSeriesInput) (*sdk.CallToolResult, ListEconomicSeriesOutput, error) {
		// Series keys, topics, metrics and region codes are stored lowercase.
		// Normalising here turns "NSW" into a match rather than into an empty
		// catalogue the caller would read as "no such series".
		req := &shortsv1alpha1.ListEconomicSeriesRequest{
			Topic:      lower(in.Topic),
			Metric:     lower(in.Metric),
			RegionType: lower(in.RegionType),
			RegionCode: lower(in.RegionCode),
			Limit:      clampLimit(in.Limit, defaultEconomySeriesListLimit, maxEconomySeriesListLimit),
		}

		res, err := src.ListEconomicSeries(ctx, connect.NewRequest(req))
		if err != nil {
			return nil, ListEconomicSeriesOutput{}, fmt.Errorf("could not list economic series: %w", err)
		}
		if res == nil || res.Msg == nil {
			return nil, ListEconomicSeriesOutput{}, fmt.Errorf("no economic series catalogue returned")
		}

		out := ListEconomicSeriesOutput{Series: []EconomicSeriesInfoRow{}, Source: economyAttribution}
		for _, info := range res.Msg.GetSeries() {
			if info == nil {
				continue
			}
			out.Series = append(out.Series, economicSeriesInfoRow(info))
		}
		out.Count = len(out.Series)

		var text string
		if out.Count == 0 {
			text = "No economic series match those filters. Call list_economic_series with no filters, " +
				"or a topic alone, to see what is published."
		} else {
			text = fmt.Sprintf("%d Australian economic series%s. Pass a series_key to get_economic_series "+
				"for its observations. %s", out.Count, forEconomyFilters(req), economyAttribution)
			if int32(out.Count) == req.GetLimit() {
				out.Note = fmt.Sprintf("Truncated at the %d-series limit; narrow with topic, metric or region_code.",
					req.GetLimit())
			}
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
	}
}

func economicSeriesInfoRow(info *shortsv1alpha1.EconomicSeriesInfo) EconomicSeriesInfoRow {
	return EconomicSeriesInfoRow{
		SeriesKey:    info.GetSeriesKey(),
		Topic:        info.GetTopic(),
		Metric:       info.GetMetric(),
		Region:       info.GetRegionName(),
		RegionCode:   info.GetRegionCode(),
		Unit:         info.GetUnit(),
		Frequency:    info.GetFrequency(),
		Adjustment:   info.GetAdjustment(),
		LatestPeriod: isoDay(info.GetLatestPeriod()),
		Source:       info.GetSourceKey(),
		Licence:      info.GetSourceLicence(),
	}
}

// forEconomyFilters renders the applied filters for the text fallback, so the
// count is never read as a count of everything published.
func forEconomyFilters(req *shortsv1alpha1.ListEconomicSeriesRequest) string {
	// A fixed order, so the same call reads the same way twice.
	filters := [][2]string{
		{"topic", req.GetTopic()},
		{"metric", req.GetMetric()},
		{"region_type", req.GetRegionType()},
		{"region_code", req.GetRegionCode()},
	}
	var parts []string
	for _, f := range filters {
		if f[1] != "" {
			parts = append(parts, f[0]+"="+f[1])
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return " matching " + strings.Join(parts, ", ")
}

func lower(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// ---------------------------------------------------------------------------
// get_economic_series
// ---------------------------------------------------------------------------

type GetEconomicSeriesInput struct {
	SeriesKeys []string `json:"series_keys" jsonschema:"1-3 exact keys from list_economic_series. Required."`
}

type EconomicPoint struct {
	Period string  `json:"period" jsonschema:"Period end, YYYY-MM-DD."`
	Value  float64 `json:"value"`
}

type EconomicSeriesResult struct {
	Info   EconomicSeriesInfoRow `json:"info"`
	Count  int                   `json:"count"`
	Points []EconomicPoint       `json:"points" jsonschema:"Oldest first."`
}

type GetEconomicSeriesOutput struct {
	Count   int                    `json:"count"`
	Series  []EconomicSeriesResult `json:"series"`
	Missing []string               `json:"missing,omitempty" jsonschema:"Requested keys that do not exist."`
	Source  string                 `json:"source" jsonschema:"Attribution required by the licence."`
	Note    string                 `json:"note,omitempty"`
}

const getEconomicSeriesDescription = "Observations for up to 3 named Australian economic series, oldest first, " +
	"in the publisher's own units — no rebasing, indexing or cross-series comparison is done, and series whose " +
	"`adjustment` differs are not comparable with each other. Keys come from list_economic_series; a key that does " +
	"not exist comes back in `missing` rather than being dropped. " +
	"ABS and RBA data, CC-BY 4.0, released monthly to annually and revised after first publication — much slower " +
	"and less final than the T+4 ASIC short data. At most 80 evenly-spaced observations per series, first and " +
	"latest always kept."

func getEconomicSeriesTool() Tool {
	tool := Tool{
		Name:        "get_economic_series",
		Title:       "Australian economic time series",
		Description: getEconomicSeriesDescription,
		RPC:         "shorts.v1alpha1.EconomyService.GetEconomicSeries",
		Domain:      "economy",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getEconomicSeriesHandler(src))
	}
	return tool
}

func getEconomicSeriesHandler(src DataSource) sdk.ToolHandlerFor[GetEconomicSeriesInput, GetEconomicSeriesOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetEconomicSeriesInput) (*sdk.CallToolResult, GetEconomicSeriesOutput, error) {
		keys := make([]string, 0, len(in.SeriesKeys))
		seen := map[string]bool{}
		for _, k := range in.SeriesKeys {
			k = lower(k)
			if k == "" || seen[k] {
				continue
			}
			seen[k] = true
			keys = append(keys, k)
		}
		if len(keys) == 0 {
			return nil, GetEconomicSeriesOutput{}, fmt.Errorf(
				"series_keys is required: call list_economic_series to find the exact keys, " +
					"e.g. cpi.cpi_index.aus — keys cannot be guessed from a series name")
		}

		var note string
		if len(keys) > maxEconomySeriesPerCall {
			note = fmt.Sprintf("Only the first %d of %d requested keys were fetched; call again for the rest.",
				maxEconomySeriesPerCall, len(keys))
			keys = keys[:maxEconomySeriesPerCall]
		}

		res, err := src.GetEconomicSeries(ctx, connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{
			SeriesKeys: keys,
		}))
		if err != nil {
			return nil, GetEconomicSeriesOutput{}, fmt.Errorf(
				"could not read economic series %s: %w", strings.Join(keys, ", "), err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetEconomicSeriesOutput{}, fmt.Errorf(
				"no observations returned for %s", strings.Join(keys, ", "))
		}

		out := GetEconomicSeriesOutput{Series: []EconomicSeriesResult{}, Source: economyAttribution, Note: note}
		returned := map[string]bool{}
		for _, s := range res.Msg.GetSeries() {
			if s == nil || s.GetInfo() == nil {
				continue
			}
			returned[s.GetInfo().GetSeriesKey()] = true

			result := EconomicSeriesResult{Info: economicSeriesInfoRow(s.GetInfo()), Points: []EconomicPoint{}}
			obs := s.GetObservations()
			if len(obs) > maxEconomyPointsPerSeries {
				out.Note = strings.TrimSpace(out.Note + fmt.Sprintf(
					" %s downsampled from %d observations to %d evenly-spaced points; the first and latest are kept.",
					s.GetInfo().GetSeriesKey(), len(obs), maxEconomyPointsPerSeries))
				obs = downsample(obs, maxEconomyPointsPerSeries)
			}
			for _, o := range obs {
				if o == nil {
					continue
				}
				result.Points = append(result.Points, EconomicPoint{
					Period: isoDay(o.GetPeriod()), Value: round2(o.GetValue()),
				})
			}
			result.Count = len(result.Points)
			out.Series = append(out.Series, result)
		}
		out.Count = len(out.Series)

		// A key the store did not recognise is reported rather than silently
		// dropped: an agent that mistypes one of three keys would otherwise get
		// two series back and no reason to doubt it asked for two.
		for _, k := range keys {
			if !returned[k] {
				out.Missing = append(out.Missing, k)
			}
		}

		var text string
		switch {
		case out.Count == 0:
			text = fmt.Sprintf("No economic series exist for %s. Call list_economic_series to find valid keys.",
				strings.Join(keys, ", "))
		default:
			lead := out.Series[0]
			text = fmt.Sprintf("%d economic series. %s (%s, %s): %d observations",
				out.Count, lead.Info.SeriesKey, nonEmpty(lead.Info.Unit, "units"),
				nonEmpty(lead.Info.Frequency, "frequency unknown"), lead.Count)
			if lead.Count > 0 {
				last := lead.Points[lead.Count-1]
				text += fmt.Sprintf(", latest %v at %s", last.Value, last.Period)
			}
			text += ". " + economyAttribution
			if len(out.Missing) > 0 {
				text += fmt.Sprintf(" No series exists for: %s.", strings.Join(out.Missing, ", "))
			}
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
	}
}

// ---------------------------------------------------------------------------
// get_state_company_aggregates
// ---------------------------------------------------------------------------

// GetStateCompanyAggregatesInput is empty: the RPC takes no arguments and the
// result is eight rows. A filter would be a round trip for nothing.
type GetStateCompanyAggregatesInput struct{}

type StateCompanyAggregateRow struct {
	State                        string  `json:"state"`
	CompanyCount                 int32   `json:"company_count" jsonschema:"Listed companies with material operations in the state."`
	ExposureWeightedMarketCap    float64 `json:"exposure_weighted_market_cap" jsonschema:"AUD."`
	ExposureWeightedShortPercent float64 `json:"exposure_weighted_short_percent" jsonschema:"Percent of shares on issue, weighted by exposure and market cap."`
}

type GetStateCompanyAggregatesOutput struct {
	Count  int                        `json:"count"`
	States []StateCompanyAggregateRow `json:"states"`
	Note   string                     `json:"note"`
}

const getStateCompanyAggregatesDescription = "ASX-listed company activity by Australian state and territory: " +
	"how many listed companies have material operations in each, their exposure-weighted market capitalisation in " +
	"AUD, and their exposure-weighted short interest as a percent of shares on issue. " +
	"The weights are OUR OWN operations-weighted estimate of where the ~300 largest listed companies operate — not " +
	"an official statistic, and not an ABS or RBA measure of state output, employment or gross state product; use " +
	"list_economic_series for those. Companies with only international exposure are excluded. Short interest is " +
	"the ASIC short position report, published T+4 business days. Takes no arguments."

func getStateCompanyAggregatesTool() Tool {
	tool := Tool{
		Name:        "get_state_company_aggregates",
		Title:       "Listed-company exposure by state",
		Description: getStateCompanyAggregatesDescription,
		RPC:         "shorts.v1alpha1.EconomyService.GetStateCompanyAggregates",
		Domain:      "economy",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getStateCompanyAggregatesHandler(src))
	}
	return tool
}

func getStateCompanyAggregatesHandler(src DataSource) sdk.ToolHandlerFor[GetStateCompanyAggregatesInput, GetStateCompanyAggregatesOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, _ GetStateCompanyAggregatesInput) (*sdk.CallToolResult, GetStateCompanyAggregatesOutput, error) {
		res, err := src.GetStateCompanyAggregates(ctx,
			connect.NewRequest(&shortsv1alpha1.GetStateCompanyAggregatesRequest{}))
		if err != nil {
			return nil, GetStateCompanyAggregatesOutput{}, fmt.Errorf(
				"could not read state company aggregates: %w", err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetStateCompanyAggregatesOutput{}, fmt.Errorf("no state company aggregates returned")
		}

		out := GetStateCompanyAggregatesOutput{
			States: []StateCompanyAggregateRow{},
			Note:   stateExposureCaveat + asicCaveat,
		}
		for _, a := range res.Msg.GetAggregates() {
			if a == nil {
				continue
			}
			out.States = append(out.States, StateCompanyAggregateRow{
				State:                        strings.ToUpper(a.GetState()),
				CompanyCount:                 a.GetCompanyCount(),
				ExposureWeightedMarketCap:    round2(a.GetExposureWeightedMarketCap()),
				ExposureWeightedShortPercent: round2(a.GetExposureWeightedShortPercent()),
			})
		}
		out.Count = len(out.States)

		text := "No state company exposure aggregates are available."
		if out.Count > 0 {
			text = fmt.Sprintf("Listed-company exposure aggregates for %d Australian states and territories. %s%s",
				out.Count, stateExposureCaveat, asicCaveat)
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
	}
}
