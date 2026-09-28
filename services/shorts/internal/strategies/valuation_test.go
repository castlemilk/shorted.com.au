package strategies

import (
	"math"
	"testing"
	"time"
)

func TestValuate(t *testing.T) {
	asOf := *d("2026-09-25")
	audInputs := func() *ValuationInputs {
		return &ValuationInputs{
			Shares: f(1e9), SharesPeriodEnd: d("2026-06-30"), MedianK: f(1.0),
			EPSDiluted: f(0.5), EPSBasic: f(0.52), EPSPeriodEnd: d("2026-06-30"), EPSCurrency: "AUD",
		}
	}
	audEquity := &Quality{TotalEquity: f(4e9), BalanceCurrency: "AUD", Currency: "AUD"}

	near := func(t *testing.T, name string, got *float64, want float64) {
		t.Helper()
		if got == nil || math.Abs(*got-want) > 1e-6*math.Max(1, math.Abs(want)) {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}

	t.Run("an AUD reporter is fully valued", func(t *testing.T) {
		v := Valuate(10, asOf, audInputs(), audEquity)
		near(t, "market cap", v.MarketCap, 1e10)
		near(t, "P/E", v.PERatio, 20)
		near(t, "P/B", v.PriceToBook, 2.5)
		if v.PEEPSBasis != PEBasisDiluted || v.Note != "" || v.PriceAsOf == nil || !v.PriceAsOf.Equal(asOf) ||
			v.SharesAsOf == nil || v.PEEPSPeriodEnd == nil {
			t.Errorf("%+v", v)
		}
	})
	t.Run("basic EPS when diluted is absent", func(t *testing.T) {
		in := audInputs()
		in.EPSDiluted = nil
		v := Valuate(10, asOf, in, nil)
		near(t, "P/E", v.PERatio, 10/0.52)
		if v.PEEPSBasis != PEBasisBasic || v.PriceToBook != nil {
			t.Errorf("%+v", v)
		}
	})
	t.Run("a USD reporter has a market cap but no P/E or P/B", func(t *testing.T) {
		in := audInputs()
		in.EPSCurrency = "USD"
		v := Valuate(45, asOf, in, &Quality{TotalEquity: f(4e10), BalanceCurrency: "USD"})
		near(t, "market cap", v.MarketCap, 4.5e10)
		if v.PERatio != nil || v.PriceToBook != nil || v.Note != ValuationNoteNonAUD {
			t.Errorf("%+v", v)
		}
	})
	t.Run("a CDI listing is not valued", func(t *testing.T) {
		in := audInputs()
		in.MedianK = f(10.1) // RMD: ten CDIs per share
		v := Valuate(40, asOf, in, audEquity)
		if v.HasAny() || v.Note != ValuationNoteListedUnit || v.PriceAsOf == nil {
			t.Errorf("%+v", v)
		}
	})
	t.Run("median k at the bounds is one share", func(t *testing.T) {
		for _, k := range []float64{0.8, 1.25} {
			in := audInputs()
			in.MedianK = f(k)
			if v := Valuate(10, asOf, in, nil); v.MarketCap == nil {
				t.Errorf("k=%v must value", k)
			}
		}
		for _, k := range []float64{0.79, 1.26, math.NaN()} {
			in := audInputs()
			in.MedianK = f(k)
			if v := Valuate(10, asOf, in, nil); v.HasAny() {
				t.Errorf("k=%v must not value", k)
			}
		}
	})
	t.Run("without a median, consistent periods vouch for the unit", func(t *testing.T) {
		in := audInputs()
		in.MedianK, in.KPeriods, in.KConsistent = nil, 1, true
		if v := Valuate(10, asOf, in, nil); v.MarketCap == nil || v.PERatio == nil {
			t.Errorf("one consistent period: %+v", v)
		}
		in.KConsistent = false
		if v := Valuate(10, asOf, in, nil); v.HasAny() || v.Note != ValuationNoteListedUnit {
			t.Errorf("an inconsistent period: %+v", v)
		}
		in.KPeriods, in.KConsistent = 0, false
		if v := Valuate(10, asOf, in, nil); v.HasAny() || v.Note != ValuationNoteNoShares {
			t.Errorf("no evidence at all (an FX-converted code: its monetary fields are rejected): %+v", v)
		}
	})
	t.Run("a share count older than 12 months is not used", func(t *testing.T) {
		in := audInputs()
		in.SharesPeriodEnd = d("2025-09-24")
		v := Valuate(10, asOf, in, audEquity)
		if v.MarketCap != nil || v.PriceToBook != nil || v.Note != ValuationNoteNoShares {
			t.Errorf("%+v", v)
		}
		near(t, "P/E still stands", v.PERatio, 20)
		in.SharesPeriodEnd = d("2025-09-25") // exactly 12 months
		if v := Valuate(10, asOf, in, nil); v.MarketCap == nil {
			t.Error("a share count exactly 12 months old is used")
		}
	})
	t.Run("an EPS older than 12 months is not used", func(t *testing.T) {
		in := audInputs()
		in.EPSPeriodEnd = d("2025-06-30")
		if v := Valuate(10, asOf, in, nil); v.PERatio != nil || v.MarketCap == nil {
			t.Errorf("%+v", v)
		}
	})
	t.Run("a loss has no P/E and needs no note", func(t *testing.T) {
		in := audInputs()
		in.EPSDiluted = f(-0.1)
		v := Valuate(10, asOf, in, nil)
		if v.PERatio != nil || v.Note != "" || v.MarketCap == nil {
			t.Errorf("%+v", v)
		}
		in.EPSDiluted = f(0)
		if v := Valuate(10, asOf, in, nil); v.PERatio != nil {
			t.Error("zero EPS has no P/E")
		}
	})
	t.Run("negative equity has no P/B", func(t *testing.T) {
		v := Valuate(10, asOf, audInputs(), &Quality{TotalEquity: f(-1e6), BalanceCurrency: "AUD"})
		if v.PriceToBook != nil || v.MarketCap == nil {
			t.Errorf("%+v", v)
		}
	})
	t.Run("no price", func(t *testing.T) {
		for _, c := range []struct {
			close float64
			asOf  time.Time
		}{{0, asOf}, {-1, asOf}, {math.NaN(), asOf}, {math.Inf(1), asOf}, {10, time.Time{}}} {
			v := Valuate(c.close, c.asOf, audInputs(), audEquity)
			if v.HasAny() || v.Note != ValuationNoteNoPrice || v.PriceAsOf != nil {
				t.Errorf("close %v at %v: %+v", c.close, c.asOf, v)
			}
		}
	})
	t.Run("nothing read values nothing and explains nothing", func(t *testing.T) {
		if v := Valuate(10, asOf, nil, audEquity); v.HasAny() || v.Note != "" || v.PriceAsOf != nil {
			t.Errorf("%+v", v)
		}
	})
}
