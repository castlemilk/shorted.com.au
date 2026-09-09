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
type fredSeries struct {
	ID         string // FRED series_id — pinned, never derived from a label
	Topic      string
	Metric     string
	Product    string
	Unit       string
	RegionCode string // lowercase ISO-ish; the key's region segment
	RegionName string
	Notes      string

	// InternalOnly withholds the series from every PUBLIC read surface
	// (List/GetEconomicSeries, ListSeriesCorrelations, the site) while still
	// ingesting and correlating it. See migration 000121.
	//
	// Set for VIXCLS only. FRED's own metadata for it reads "Copyright, 2016,
	// Chicago Board Options Exchange, Inc. Reprinted with permission." —
	// permission granted to FRED, not onward. The three Federal Reserve series
	// beside it (H.15, H.10) carry no such notice and stay public.
	InternalOnly bool
}

// Pinned from the 2026-09-08 probe. Series IDs are stable FRED identifiers, not
// labels: FRED retitles series (DTWEXBGS was "Trade Weighted U.S. Dollar Index"
// before the 2020 rebase) and a label-derived key would fork the history.
var fredSeriesDefs = []fredSeries{
	// INTERNAL ONLY — CBOE copyright, see fredSeries.InternalOnly.
	{"VIXCLS", "volatility", "index_close", "vix", "index", "usa", "United States",
		"CBOE Volatility Index (VIX), daily close, month-end observation. INTERNAL ONLY.", true},
	{"DGS2", "rates", "treasury_yield", "2y", "percent", "usa", "United States",
		"US Treasury constant-maturity 2-year yield, month-end observation.", false},
	{"DGS10", "rates", "treasury_yield", "10y", "percent", "usa", "United States",
		"US Treasury constant-maturity 10-year yield, month-end observation.", false},
	{"DTWEXBGS", "fx", "usd_index", "broad", "index", "usa", "United States",
		"Nominal broad US dollar index (Jan 2006 = 100), month-end observation.", false},

	// Crude. The ASX is resources-weighted and nothing in the catalog carried a
	// crude price — RBA's I2 gives commodity INDICES (bulk, base metals, rural),
	// which is a different instrument from a barrel of oil.
	//
	// Both are EIA series on FRED and neither carries a copyright notice (probed
	// 2026-09-09, same check that flagged VIX). Region codes name where the
	// benchmark is priced rather than pretending both are American: WTI is
	// Cushing, Oklahoma; Brent is the North Sea.
	{"DCOILWTICO", "commodities", "crude_oil", "wti", "usd_per_barrel", "usa", "United States",
		"WTI crude, Cushing OK, month-end observation. EIA via FRED.", false},
	{"DCOILBRENTEU", "commodities", "crude_oil", "brent", "usd_per_barrel", "eur", "Europe",
		"Brent crude, Europe, month-end observation. EIA via FRED.", false},

	// FX pairs the RBA does not publish. DEXUSAL is DELIBERATELY ABSENT: rba.go
	// already imports FXRUSD as rates.aud_usd.aus, and a second AUD/USD from a
	// second publisher would be two series claiming one fact, diverging on
	// fixing time and rounding.
	//
	// CNY earns its place ahead of the others here: China takes the bulk of
	// Australian iron ore, so CNY/USD plausibly explains more of the materials
	// sector's short interest than AUD/USD does. All three are H.10 (Federal
	// Reserve), public domain, no copyright notice.
	{"DEXCHUS", "fx", "spot_rate", "cny_usd", "cny_per_usd", "chn", "China",
		"Chinese yuan per US dollar, month-end observation. H.15/H.10 via FRED.", false},
	{"DEXJPUS", "fx", "spot_rate", "jpy_usd", "jpy_per_usd", "jpn", "Japan",
		"Japanese yen per US dollar, month-end observation. H.10 via FRED.", false},
	{"DEXUSEU", "fx", "spot_rate", "usd_eur", "usd_per_eur", "eur", "Euro area",
		"US dollars per euro, month-end observation. H.10 via FRED.", false},
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

	series := SeriesDef{
		Topic:      def.Topic,
		Metric:     def.Metric,
		Product:    def.Product,
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
		Adjustment: "original",
		Dimensions: map[string]string{
			"fred_series_id": def.ID,
			"aggregation":    "monthly_last_traded_day",
			"source_cadence": "daily",
		},
		InternalOnly: def.InternalOnly,
		SourceKey: "fred-us-macro",
		Licence:   "public-domain-us-gov",
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
