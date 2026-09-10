package economy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// FRED — US macro series, the first non-Australian source in this catalog.
//
// Why it is here: VIX, the US 2s/10s and the broad dollar index are the global
// risk factors that actually move ASX short interest, and nothing else in the
// catalog covers them. Every other source is ABS/RBA/DCCEEW, so this is a
// deliberate widening of scope rather than an accident — the region code says
// `usa` in the series key itself so no consumer can mistake it for domestic data.
//
// PROBED 2026-09-08 against api.stlouisfed.org, every code and cadence pinned
// from that probe (iron rule 1). Last non-empty values at probe time, which are
// the magnitude cross-checks for a live smoke:
//
//	VIXCLS    D  Index                2026-09-03 =   14.32   (from 1990-01-02)
//	DGS2      D  %                    2026-09-03 =    4.34   (from 1976-06-01)
//	DGS10     D  %                    2026-09-03 =    4.77   (from 1962-01-02)
//	DTWEXBGS  D  Index Jan 2006=100   2026-08-28 = 118.7479  (from 2006-01-02)
//
// Probed 2026-09-09, second batch (coverage confirmed, copyright line checked
// on each — none carries one):
//
//	DCOILWTICO    D  $/barrel   ..2026-09-01  (from 1986-01-02)
//	DCOILBRENTEU  D  $/barrel   ..2026-09-01  (from 1987-05-20)
//	DEXCHUS       D  CNY per $  ..2026-09-04  (from 1981-01-02)
//	DEXJPUS       D  JPY per $  ..2026-09-04  (from 1971-01-04)
//	DEXUSEU       D  $ per EUR  ..2026-09-04  (from 1999-01-04)
//
// Gold is ABSENT on purpose. FRED does not carry a current LBMA gold price —
// LBMA restricts redistribution and the series was dropped, the same shape as
// VIXCLS/CBOE. The World Bank "Pink Sheet" (CC-BY, monthly, gold + iron ore +
// coal + LNG) is the right source for it and needs its own importer; do not
// go looking for gold here.
//
// PUBLISHED MONTHLY, NOT DAILY, and that is load-bearing. correlations.go
// restricts overlays to monthly/quarterly in two places (the SQL at :74 and
// eligibleCorrelationOverlay at :260). A daily series would be accepted by the
// catalog, appear in the industry-intelligence overlay picker, and then
// correlate against nothing — a control that looks live and does nothing.
// No production series is daily today; the only `daily` in the tree is a test
// fixture in rba_test.go.
//
// MONTHLY-LAST, to match the anchor it will be plotted against. markets.go
// buckets each stock's short position with DISTINCT ON (stock, month) ORDER BY
// date DESC — the month's final report — before averaging across the industry.
// Taking the month's final FRED observation puts both sides of the correlation
// on the same time axis. A monthly mean would be defensible on its own and
// wrong next to that anchor.
const fredAPIBase = "https://api.stlouisfed.org/fred/series/observations"

// fredSeries is one upstream series and the catalog entry it becomes.
//
// Fields are set by NAME, never positionally. The table below is long enough
// that a positional literal is unreadable, and inserting a field in the middle
// of one silently re-homes every value after it.
type fredSeries struct {
	ID         string // FRED series_id — pinned, never derived from a label
	Topic      string
	Metric     string
	Product    string
	Unit       string
	RegionCode string // lowercase ISO-ish; the key's region segment
	RegionName string
	Notes      string

	// Adjustment is the UPSTREAM seasonal adjustment, copied from FRED's own
	// `seasonal_adjustment_short`. It is part of the key (`…usa.seasadj`), so
	// getting it wrong publishes a seasonally-adjusted number under a name that
	// says it is not one. Empty means "original".
	Adjustment string

	// Cadence is the PUBLICATION frequency upstream: daily, weekly or monthly.
	// Everything here is stored monthly; this records what was reduced to get
	// there, so `aggregation` in Dimensions can tell the truth about whether a
	// value was picked from a month of observations or published as-is.
	Cadence string

	// Licence is the terms the SOURCE publishes under, per series rather than
	// per importer: FRED aggregates the Federal Reserve, BLS and EIA (all US
	// government, public domain) alongside licensed third-party indices.
	Licence string

	// InternalOnly withholds the series from every PUBLIC read surface
	// (List/GetEconomicSeries, ListSeriesCorrelations, the site) while still
	// ingesting and correlating it. See migration 000121.
	//
	// Set for exactly the series whose FRED metadata carries a third-party
	// copyright notice — permission granted to FRED, not onward. Two so far:
	// VIXCLS (CBOE) and BAMLH0A0HYM2 (ICE Data Indices). Everything else here
	// is US government output with no such notice, checked series by series.
	InternalOnly bool
}

const (
	licencePublicDomainUSGov = "public-domain-us-gov"
	licenceProprietaryCBOE   = "proprietary-cboe"
	licenceProprietaryICE    = "proprietary-ice-data-indices"
	// OECD publishes its public data for redistribution WITH ATTRIBUTION —
	// a citation requirement, not a restriction, which is why the two China
	// series below are public where the CBOE and ICE ones are not. The
	// attribution rides in the frontend registry's `source` line.
	licenceOECDAttribution = "oecd-terms-attribution"
)

// Pinned from the 2026-09-08 probe. Series IDs are stable FRED identifiers, not
// labels: FRED retitles series (DTWEXBGS was "Trade Weighted U.S. Dollar Index"
// before the 2020 rebase) and a label-derived key would fork the history.
//
// The 2026-09-10 batch (everything below the crude block) was probed the same
// way: metadata fetched for each candidate, `notes` searched for a copyright,
// permission or proprietary clause, and frequency/units/coverage read off the
// response rather than assumed. Two candidates were REJECTED by that check and
// are recorded here so nobody re-adds them believing they were merely missed:
//
//	PALLFNFINDEXM  IMF all-commodities index — "Copyright © 2016, International
//	               Monetary Fund. Reprinted with permission." Redundant anyway;
//	               the World Bank Pink Sheet covers the same ground under CC-BY.
//	GEPUCURRENT    Global Economic Policy Uncertainty — no copyright line in the
//	               FRED notes, but policyuncertainty.com grants the data for
//	               non-commercial use, which this is not. Absence of a FRED
//	               notice is not a licence.
//	RECPROUSM156N  Smoothed US recession probabilities (Chauvet-Piger). No FRED
//	               copyright line and no stated licence either — an academic
//	               series hosted on FRED. Every other row here is on a licence
//	               we can name, and the /economy page makes a licence claim in
//	               its footer, so an unnameable one stays out.
var fredSeriesDefs = []fredSeries{
	// ── Volatility ────────────────────────────────────────────────────────
	// INTERNAL ONLY — CBOE copyright, see fredSeries.InternalOnly.
	{ID: "VIXCLS", Topic: "volatility", Metric: "index_close", Product: "vix",
		Unit: "index", RegionCode: "usa", RegionName: "United States", Cadence: "daily",
		Licence: licenceProprietaryCBOE, InternalOnly: true,
		Notes: "CBOE Volatility Index (VIX), daily close, month-end observation. INTERNAL ONLY."},

	// ── US rates ──────────────────────────────────────────────────────────
	// The Treasury curve, plus the two derived series that carry most of the
	// signal: 10y−2y (the recession bellwether) and the 10-year breakeven (the
	// market's inflation expectation). Both are computed by FRED from the H.15
	// constant maturities already here, so they are the same publisher.
	{ID: "FEDFUNDS", Topic: "rates", Metric: "policy_rate", Product: "fed_funds",
		Unit: "percent", RegionCode: "usa", RegionName: "United States", Cadence: "monthly",
		Licence: licencePublicDomainUSGov,
		Notes:   "Federal funds effective rate, monthly average. The US counterpart to the RBA cash rate target."},
	{ID: "DGS3MO", Topic: "rates", Metric: "treasury_yield", Product: "3m",
		Unit: "percent", RegionCode: "usa", RegionName: "United States", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "US Treasury constant-maturity 3-month yield, month-end observation."},
	{ID: "DGS2", Topic: "rates", Metric: "treasury_yield", Product: "2y",
		Unit: "percent", RegionCode: "usa", RegionName: "United States", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "US Treasury constant-maturity 2-year yield, month-end observation."},
	{ID: "DGS10", Topic: "rates", Metric: "treasury_yield", Product: "10y",
		Unit: "percent", RegionCode: "usa", RegionName: "United States", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "US Treasury constant-maturity 10-year yield, month-end observation."},
	{ID: "DGS30", Topic: "rates", Metric: "treasury_yield", Product: "30y",
		Unit: "percent", RegionCode: "usa", RegionName: "United States", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "US Treasury constant-maturity 30-year yield, month-end observation."},
	{ID: "T10Y2Y", Topic: "rates", Metric: "yield_curve_spread", Product: "10y_2y",
		Unit: "percent", RegionCode: "usa", RegionName: "United States", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "US 10-year minus 2-year Treasury yield, month-end observation. Negative is an inverted curve."},
	{ID: "T10YIE", Topic: "rates", Metric: "breakeven_inflation", Product: "10y",
		Unit: "percent", RegionCode: "usa", RegionName: "United States", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "10-year breakeven inflation rate (nominal minus TIPS), month-end observation."},

	// ── US credit ─────────────────────────────────────────────────────────
	// INTERNAL ONLY — ICE Data Indices copyright. Also note FRED truncated this
	// series to a rolling 3 years in April 2026, so its history starts 2023-09
	// and will keep moving forward; a chart of it is short by construction.
	{ID: "BAMLH0A0HYM2", Topic: "credit", Metric: "high_yield_oas", Product: "us_hy",
		Unit: "percent", RegionCode: "usa", RegionName: "United States", Cadence: "daily",
		Licence: licenceProprietaryICE, InternalOnly: true,
		Notes: "ICE BofA US High Yield index option-adjusted spread, month-end observation. INTERNAL ONLY."},

	// ── US macro ──────────────────────────────────────────────────────────
	// Published monthly upstream, so nothing is reduced — `aggregation` says
	// as_published rather than claiming a month-end pick that never happened.
	{ID: "CPIAUCSL", Topic: "cpi", Metric: "index", Product: "all_items",
		Unit: "index", RegionCode: "usa", RegionName: "United States", Cadence: "monthly",
		Adjustment: "seasadj", Licence: licencePublicDomainUSGov,
		Notes: "US CPI for all urban consumers, all items (1982-84 = 100), seasonally adjusted. BLS."},
	{ID: "UNRATE", Topic: "labour", Metric: "unemployment_rate", Product: "total",
		Unit: "percent", RegionCode: "usa", RegionName: "United States", Cadence: "monthly",
		Adjustment: "seasadj", Licence: licencePublicDomainUSGov,
		Notes: "US unemployment rate, seasonally adjusted. BLS."},
	{ID: "INDPRO", Topic: "industry", Metric: "production_index", Product: "total",
		Unit: "index", RegionCode: "usa", RegionName: "United States", Cadence: "monthly",
		Adjustment: "seasadj", Licence: licencePublicDomainUSGov,
		Notes: "US industrial production, total index (2017 = 100), seasonally adjusted. Federal Reserve G.17."},
	{ID: "M2SL", Topic: "money", Metric: "m2_stock", Product: "total",
		Unit: "usd_billions", RegionCode: "usa", RegionName: "United States", Cadence: "monthly",
		Adjustment: "seasadj", Licence: licencePublicDomainUSGov,
		Notes: "US M2 money stock, billions of dollars, seasonally adjusted. Federal Reserve H.6."},
	{ID: "WALCL", Topic: "money", Metric: "central_bank_assets", Product: "total",
		Unit: "usd_millions", RegionCode: "usa", RegionName: "United States", Cadence: "weekly",
		Licence: licencePublicDomainUSGov,
		Notes:   "Federal Reserve total assets, millions of dollars, month-end observation. H.4.1."},

	// ── FX ────────────────────────────────────────────────────────────────
	{ID: "DTWEXBGS", Topic: "fx", Metric: "usd_index", Product: "broad",
		Unit: "index", RegionCode: "usa", RegionName: "United States", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "Nominal broad US dollar index (Jan 2006 = 100), month-end observation."},

	// Crude. The ASX is resources-weighted and nothing in the catalog carried a
	// crude price — RBA's I2 gives commodity INDICES (bulk, base metals, rural),
	// which is a different instrument from a barrel of oil.
	//
	// Both are EIA series on FRED and neither carries a copyright notice (probed
	// 2026-09-09, same check that flagged VIX). Region codes name where the
	// benchmark is priced rather than pretending both are American: WTI is
	// Cushing, Oklahoma; Brent is the North Sea.
	{ID: "DCOILWTICO", Topic: "commodities", Metric: "crude_oil", Product: "wti",
		Unit: "usd_per_barrel", RegionCode: "usa", RegionName: "United States", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "WTI crude, Cushing OK, month-end observation. EIA via FRED."},
	{ID: "DCOILBRENTEU", Topic: "commodities", Metric: "crude_oil", Product: "brent",
		Unit: "usd_per_barrel", RegionCode: "eur", RegionName: "Europe", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "Brent crude, Europe, month-end observation. EIA via FRED."},

	// FX pairs the RBA does not publish. DEXUSAL is DELIBERATELY ABSENT: rba.go
	// already imports FXRUSD as rates.aud_usd.aus, and a second AUD/USD from a
	// second publisher would be two series claiming one fact, diverging on
	// fixing time and rounding.
	//
	// CNY earns its place ahead of the others here: China takes the bulk of
	// Australian iron ore, so CNY/USD plausibly explains more of the materials
	// sector's short interest than AUD/USD does. All are H.10 (Federal
	// Reserve), public domain, no copyright notice.
	//
	// PRODUCT NAMES THE DIRECTION, because H.10 does not quote every pair the
	// same way round: `cny_usd` is yuan PER dollar, `usd_eur` is dollars PER
	// euro. Reading a rate upside-down is the one error here that produces a
	// perfectly plausible-looking chart.
	{ID: "DEXCHUS", Topic: "fx", Metric: "spot_rate", Product: "cny_usd",
		Unit: "cny_per_usd", RegionCode: "chn", RegionName: "China", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "Chinese yuan per US dollar, month-end observation. H.10 via FRED."},
	{ID: "DEXJPUS", Topic: "fx", Metric: "spot_rate", Product: "jpy_usd",
		Unit: "jpy_per_usd", RegionCode: "jpn", RegionName: "Japan", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "Japanese yen per US dollar, month-end observation. H.10 via FRED."},
	{ID: "DEXKOUS", Topic: "fx", Metric: "spot_rate", Product: "krw_usd",
		Unit: "krw_per_usd", RegionCode: "kor", RegionName: "South Korea", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "South Korean won per US dollar, month-end observation. H.10 via FRED."},
	{ID: "DEXINUS", Topic: "fx", Metric: "spot_rate", Product: "inr_usd",
		Unit: "inr_per_usd", RegionCode: "ind", RegionName: "India", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "Indian rupees per US dollar, month-end observation. H.10 via FRED."},
	{ID: "DEXSIUS", Topic: "fx", Metric: "spot_rate", Product: "sgd_usd",
		Unit: "sgd_per_usd", RegionCode: "sgp", RegionName: "Singapore", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "Singapore dollars per US dollar, month-end observation. H.10 via FRED."},
	{ID: "DEXCAUS", Topic: "fx", Metric: "spot_rate", Product: "cad_usd",
		Unit: "cad_per_usd", RegionCode: "can", RegionName: "Canada", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "Canadian dollars per US dollar, month-end observation. H.10 via FRED. The other resources-heavy G10 currency."},
	{ID: "DEXUSEU", Topic: "fx", Metric: "spot_rate", Product: "usd_eur",
		Unit: "usd_per_eur", RegionCode: "eur", RegionName: "Euro area", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "US dollars per euro, month-end observation. H.10 via FRED."},
	{ID: "DEXUSUK", Topic: "fx", Metric: "spot_rate", Product: "usd_gbp",
		Unit: "usd_per_gbp", RegionCode: "gbr", RegionName: "United Kingdom", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "US dollars per pound sterling, month-end observation. H.10 via FRED."},
	{ID: "DEXUSNZ", Topic: "fx", Metric: "spot_rate", Product: "usd_nzd",
		Unit: "usd_per_nzd", RegionCode: "nzl", RegionName: "New Zealand", Cadence: "daily",
		Licence: licencePublicDomainUSGov,
		Notes:   "US dollars per New Zealand dollar, month-end observation. H.10 via FRED."},

	// ── China ─────────────────────────────────────────────────────────────
	// The largest gap in this catalog for an ASX platform, and the hardest to
	// fill: China's own statistical agencies are not on FRED, so what is here
	// is OECD's compilation. OECD permits redistribution WITH ATTRIBUTION —
	// a citation requirement rather than a restriction, unlike the CBOE and
	// ICE notices above — so these two are public.
	//
	// CHNCPIALLMINMEI (China CPI) was probed with these and REJECTED: its last
	// observation is 2025-04 and the series has not updated since. A chart
	// ending sixteen months back, with nothing on the page saying so, is the
	// exact failure this catalog keeps finding elsewhere.
	{ID: "XTEXVA01CNM667S", Topic: "trade", Metric: "export_value", Product: "total",
		Unit: "usd", RegionCode: "chn", RegionName: "China", Cadence: "monthly",
		Adjustment: "seasadj", Licence: licenceOECDAttribution,
		Notes: "China merchandise exports to the world, USD, seasonally adjusted. OECD via FRED. " +
			"The demand-side counterpart to the iron ore and coal prices above."},
	{ID: "CCRETT01CNM661N", Topic: "fx", Metric: "real_effective_rate", Product: "cpi_based",
		Unit: "index", RegionCode: "chn", RegionName: "China", Cadence: "monthly",
		Licence: licenceOECDAttribution,
		Notes:   "China real effective exchange rate, CPI-based (2015 = 100). OECD via FRED."},
}

// fredObservation is one row of the FRED observations payload. `value` is a
// STRING because FRED encodes a missing observation as "." — a market holiday,
// not a zero. Decoding into a float64 would fail the whole fetch; decoding into
// a float64 with a default would write 0.0 for a day the market was shut, which
// is the "a missing input must be excluded, never defaulted" rule.
type fredObservation struct {
	Date  string `json:"date"`
	Value string `json:"value"`
}

type fredResponse struct {
	Observations []fredObservation `json:"observations"`
}

// ingestFRED fetches every pinned series and reduces each to monthly-last.
func ingestFRED(ctx context.Context, _ *absdata.Client) ([]Obs, error) {
	apiKey := strings.TrimSpace(os.Getenv("FRED_API_KEY"))
	if apiKey == "" {
		// Named, not silent. Without a key FRED answers 400 for every series —
		// DEMO_KEY is rejected outright, measured 2026-09-07 — so the failure is
		// total and there is nothing partial to salvage.
		return nil, fmt.Errorf("FRED_API_KEY is not set; FRED rejects DEMO_KEY, so no series can be fetched")
	}

	var all []Obs
	for _, def := range fredSeriesDefs {
		obs, err := fetchFREDSeries(ctx, apiKey, def)
		if err != nil {
			return nil, fmt.Errorf("fred %s: %w", def.ID, err)
		}
		all = append(all, obs...)
	}
	return all, nil
}

func fetchFREDSeries(ctx context.Context, apiKey string, def fredSeries) ([]Obs, error) {
	url := fmt.Sprintf(
		"%s?series_id=%s&api_key=%s&file_type=json&observation_start=2006-01-01",
		fredAPIBase, def.ID, apiKey,
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "shorted-data/1.0 (+https://shorted.com.au)")

	resp, err := (&http.Client{Timeout: 45 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d", resp.StatusCode)
	}

	var payload fredResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return monthlyLast(payload.Observations, def)
}

// monthlyLast reduces daily observations to one value per month: the last
// TRADED day, not the last calendar day.
func monthlyLast(raw []fredObservation, def fredSeries) ([]Obs, error) {
	type dated struct {
		day   time.Time
		value float64
	}
	// Keep the latest dated observation per month.
	byMonth := map[time.Time]dated{}
	for _, o := range raw {
		// "." is FRED's missing marker — a holiday or a non-publication day.
		// Excluded, never defaulted: a 0.0 here would read as a 0% yield.
		if o.Value == "." || strings.TrimSpace(o.Value) == "" {
			continue
		}
		day, err := time.Parse("2006-01-02", o.Date)
		if err != nil {
			continue
		}
		v, err := strconv.ParseFloat(o.Value, 64)
		if err != nil {
			continue
		}
		month := time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, time.UTC)
		if cur, ok := byMonth[month]; !ok || day.After(cur.day) {
			byMonth[month] = dated{day: day, value: v}
		}
	}
	if len(byMonth) == 0 {
		return nil, fmt.Errorf("no usable observations (all missing or unparseable) — treating as format drift")
	}

	// A monthly-native series has one observation per month, so monthlyLast
	// picked nothing — saying "monthly_last_traded_day" for it would describe a
	// reduction that did not happen. The distinction matters when someone later
	// asks why a value differs from the month's average.
	aggregation := "monthly_last_traded_day"
	if def.Cadence == "monthly" {
		aggregation = "as_published"
	}
	adjustment := def.Adjustment
	if adjustment == "" {
		adjustment = "original"
	}

	series := SeriesDef{
		Topic:   def.Topic,
		Metric:  def.Metric,
		Product: def.Product,
		// RegionType stays "national" for every one of these, including the
		// non-US ones. eligibleCorrelationOverlay pairs an overlay with an AU
		// base on `RegionCode == base.RegionCode || RegionType == "national"`,
		// so a global risk factor must be national to be usable at all. The
		// RegionCode is what carries the honesty about WHERE.
		RegionType: "national",
		RegionCode: def.RegionCode,
		RegionName: def.RegionName,
		Unit:       def.Unit,
		Frequency:  "monthly",
		Adjustment: adjustment,
		Dimensions: map[string]string{
			"fred_series_id": def.ID,
			"aggregation":    aggregation,
			"source_cadence": def.Cadence,
		},
		InternalOnly: def.InternalOnly,
		SourceKey:    "fred-us-macro",
		Licence:      def.Licence,
	}

	months := make([]time.Time, 0, len(byMonth))
	for m := range byMonth {
		months = append(months, m)
	}
	sort.Slice(months, func(i, j int) bool { return months[i].Before(months[j]) })

	out := make([]Obs, 0, len(months))
	for _, m := range months {
		out = append(out, Obs{Series: series, Period: m, Value: byMonth[m].value})
	}
	return out, nil
}
