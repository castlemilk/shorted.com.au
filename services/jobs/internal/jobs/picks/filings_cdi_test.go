package picks

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Review finding C9: gate 8 checks a filing EPS against net income / vendor
// shares with no CDI factor. For a CDI listing whose vendor EPS is per CDI
// (RMD: Yahoo EPS 0.955 per CDI against a per-share count of 146.4m, so
// k = NI / (EPS x shares) is about 10) the check admits exactly the per-share
// EPS the vendor series does not use. When the code's median_k is outside
// [0.8, 1.25], or (no median_k) any vendor period's own k is, filing EPS is
// withheld for the code; revenue and net income stand.

// rmdVendor is RMD-shaped: USD, per-CDI EPS, per-share counts (the figures of
// testdata/yahoo_full_RMD.json; k is about 10.0).
func rmdVendor(medianK *float64) []vendorRow {
	rows := []vendorRow{
		vAnnual("2024-06-30", "USD", f64(4685.3e6), f64(1020.6e6), f64(0.694), f64(146.9e6)),
		vAnnual("2025-06-30", "USD", f64(5146.3e6), f64(1400.7e6), f64(0.955), f64(146.4e6)),
	}
	for i := range rows {
		rows[i].MedianK = medianK
	}
	return rows
}

// rmdFilings: a 4D stating a per-share EPS (US$5.12 = NI 750m / 146.4m
// shares, so gate 8's ratio is 1.0) and a 4E for a year the vendor has not
// published yet (US$10.47 against NI 1,523m).
func rmdFilings(t *testing.T, code string) []filingExtraction {
	return []filingExtraction{
		{Code: code, URL: "u-4d", Title: "Appendix 4D", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, map[string]any{
			"revenue":    entry("source_text", "Revenue US$2,700 million", "value_millions", "2700", "period", "H1 FY2026", "alignment", "match_exact"),
			"net_profit": entry("source_text", "Net profit after tax US$750 million", "value_millions", "750", "period", "H1 FY2026", "alignment", "match_exact"),
			"eps":        entry("source_text", "Basic earnings per share of US$5.12", "value", "5.12", "period", "H1 FY2026", "alignment", "match_exact"),
		})},
		{Code: code, URL: "u-4e", Title: "Appendix 4E", ReportDate: date("2026-08-20"), Metrics: metricsJSON(t, map[string]any{
			"net_profit": entry("source_text", "Net profit after tax US$1,523 million", "value_millions", "1523", "period", "FY2026", "alignment", "match_exact"),
			"eps":        entry("source_text", "Basic earnings per share of US$10.47", "value", "10.47", "period", "FY2026", "alignment", "match_exact"),
		})},
	}
}

func TestGate8WithholdsFilingEPSForACDIListing(t *testing.T) {
	for _, c := range []struct {
		name    string
		medianK *float64
	}{
		{"no median_k: the vendor rows' own k is about 10", nil},
		{"median_k about 10", f64(10.02)},
	} {
		t.Run(c.name, func(t *testing.T) {
			var st filingStats
			out := buildFilingRows(rmdFilings(t, "RMD"), filingInputs{vendor: map[string][]vendorRow{"RMD": rmdVendor(c.medianK)}}, &st)
			require.Len(t, out["RMD"], 2, "H1 FY26 and FY26")
			h, a := out["RMD"][0], out["RMD"][1]
			assert.Equal(t, periodHalf, h.PeriodType)
			assert.InDelta(t, 2700e6, val(t, h.Revenue), 1, "revenue stands")
			assert.InDelta(t, 750e6, val(t, h.NetIncome), 1, "net income stands")
			assert.Nil(t, h.EPSBasic, "a per-share EPS never enters a per-CDI series")
			assert.Equal(t, periodAnnual, a.PeriodType)
			assert.InDelta(t, 1523e6, val(t, a.NetIncome), 1)
			assert.Nil(t, a.EPSBasic, "the 4E's per-share EPS is withheld too")
			assert.Equal(t, 2, st.Gates[gateEPSListedUnit])
			assert.Zero(t, st.Gates[gateEPSRange], "withheld on the listed unit, not the ratio")
		})
	}
}

// An ordinary listing (k = 1) keeps its filing EPS; a persisted median_k
// decides over the rows when present.
func TestGate8ListedUnitFollowsMedianK(t *testing.T) {
	ordinary := func(medianK *float64) []vendorRow {
		rows := []vendorRow{
			vAnnual("2024-06-30", "USD", f64(4685.3e6), f64(1020.6e6), f64(6.947), f64(146.9e6)),
			vAnnual("2025-06-30", "USD", f64(5146.3e6), f64(1400.7e6), f64(9.568), f64(146.4e6)),
		}
		for i := range rows {
			rows[i].MedianK = medianK
		}
		return rows
	}
	for _, c := range []struct {
		name    string
		medianK *float64
		kept    bool
	}{
		{"no median_k, k = 1", nil, true},
		{"median_k 1.0", f64(1.0), true},
		{"median_k at the band's edge", f64(1.25), true},
		{"median_k outside the band decides over the rows", f64(1.3), false},
	} {
		t.Run(c.name, func(t *testing.T) {
			var st filingStats
			out := buildFilingRows(rmdFilings(t, "ORD"), filingInputs{vendor: map[string][]vendorRow{"ORD": ordinary(c.medianK)}}, &st)
			require.Len(t, out["ORD"], 2)
			if c.kept {
				assert.InDelta(t, 5.12, val(t, out["ORD"][0].EPSBasic), 1e-12)
				assert.InDelta(t, 10.47, val(t, out["ORD"][1].EPSBasic), 1e-12)
				assert.Zero(t, st.Gates[gateEPSListedUnit])
			} else {
				assert.Nil(t, out["ORD"][0].EPSBasic)
				assert.Nil(t, out["ORD"][1].EPSBasic)
				assert.Equal(t, 2, st.Gates[gateEPSListedUnit])
			}
		})
	}
}

func TestVendorEPSPerShare(t *testing.T) {
	ok, _ := vendorEPSPerShare(rmdVendor(nil))
	assert.False(t, ok, "RMD: k about 10")

	// One out-of-band period is enough without a median (the vendor's EPS
	// basis is not settled).
	mixed := []vendorRow{
		vAnnual("2024-06-30", "AUD", f64(100e6), f64(10e6), f64(0.10), f64(100e6)),
		vAnnual("2025-06-30", "AUD", f64(100e6), f64(10e6), f64(0.02), f64(100e6)),
	}
	ok, note := vendorEPSPerShare(mixed)
	assert.False(t, ok)
	assert.Contains(t, note, "2025-06-30")

	// A TTM period counts, on the annual share count at its end.
	ttm := vTTM("2025-06-30", "AUD", f64(100e6), f64(0.01))
	ttm.NetIncome = f64(10e6)
	ok, _ = vendorEPSPerShare([]vendorRow{vAnnual("2025-06-30", "AUD", f64(100e6), nil, nil, f64(100e6)), ttm})
	assert.False(t, ok, "TTM k = 10e6 / (0.01 x 100e6) = 10")

	// A filing-filled EPS is not vendor evidence.
	filled := vAnnual("2025-06-30", "AUD", f64(100e6), f64(10e6), f64(0.01), f64(100e6))
	filled.FieldSources = map[string]string{"eps_basic": sourceFiling}
	ok, _ = vendorEPSPerShare([]vendorRow{filled})
	assert.True(t, ok)

	// No computable k: no evidence either way.
	ok, _ = vendorEPSPerShare([]vendorRow{vAnnual("2025-06-30", "AUD", f64(100e6), nil, f64(0.1), f64(100e6))})
	assert.True(t, ok)

	// A persisted median_k decides.
	ok, _ = vendorEPSPerShare(rmdVendor(f64(1.0)))
	assert.True(t, ok, "median_k in band wins over the rows")
	ok, _ = vendorEPSPerShare(rmdVendor(f64(0.79)))
	assert.False(t, ok)
}
