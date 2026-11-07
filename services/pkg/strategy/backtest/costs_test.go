package backtest

import (
	"math"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// houseCosts is the cost model of the csb-r1 recipe, read from the recipe so the
// fixtures and the published values share one copy.
func houseCosts() spec.Costs {
	return spec.R1Recipes()[0].Costs
}

// flatCosts is the labelled flat sensitivity: the house brokerage with 5 bps of
// slippage on every fill, whatever the liquidity. No recipe holds it.
func flatCosts() spec.Costs {
	c := houseCosts()
	slip := 5.0
	c.SpreadTiers = nil
	c.FlatSlippageBps = &slip
	return c
}

func TestHouseCostsByLiquidityTier(t *testing.T) {
	c := houseCosts()
	cases := []struct {
		name     string
		notional float64
		dv20     float64
		want     float64
	}{
		// Brokerage is 10 bps of A$10,000 = A$10; spread at each tier.
		{"deep liquidity, 5 bps", 10000, 25_000_000, 10 + 5},
		{"A$5m tier, 10 bps", 10000, 5_000_000, 10 + 10},
		{"A$1m tier, 25 bps", 10000, 1_000_000, 10 + 25},
		{"A$250k tier, 50 bps", 10000, 250_000, 10 + 50},
		{"below every tier, 75 bps", 10000, 100_000, 10 + 75},
		// The A$10 minimum binds on a small fill: 10 bps of A$1,000 is A$1.
		{"minimum brokerage", 1000, 1e9, 10 + 0.5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			near(t, "fee", feeFor(c, tc.notional, tc.dv20), tc.want, 1e-9)
		})
	}
}

func TestFlatCostsIgnoreLiquidity(t *testing.T) {
	c := flatCosts()
	// 10 bps brokerage on A$10,000 is A$10, and 5 bps of slippage is A$5.
	near(t, "flat fee deep", feeFor(c, 10000, 1e9), 15, 1e-9)
	near(t, "flat fee thin", feeFor(c, 10000, 1000), 15, 1e-9)
}

// TestSpreadTierOrderDoesNotChangeTheFee: the tier is the highest floor the
// decision reaches, so a list read in either order charges the same spread.
func TestSpreadTierOrderDoesNotChangeTheFee(t *testing.T) {
	falling := houseCosts()
	rising := houseCosts()
	rising.SpreadTiers = nil
	for i := len(falling.SpreadTiers) - 1; i >= 0; i-- {
		rising.SpreadTiers = append(rising.SpreadTiers, falling.SpreadTiers[i])
	}
	for _, dv20 := range []float64{1e9, 5_000_000, 1_000_000, 250_000, 100_000} {
		near(t, "fee by tier", feeFor(rising, 10000, dv20), feeFor(falling, 10000, dv20), 0)
	}
}

func TestCostMultiplierScalesTheFee(t *testing.T) {
	c := houseCosts()
	base := feeFor(c, 10000, 1e9)
	c.Multiplier = 2
	near(t, "doubled fee", feeFor(c, 10000, 1e9), 2*base, 1e-9)
}

func TestNewStateRejectsANonPositiveMultiplier(t *testing.T) {
	for _, m := range []float64{0, -1, math.NaN()} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatalf("multiplier %v accepted", m)
				}
			}()
			cfg := testConfig()
			cfg.Costs.Multiplier = m
			NewState(cfg)
		}()
	}
}

func TestNoFeeOnNoNotional(t *testing.T) {
	if got := feeFor(houseCosts(), 0, 1e9); got != 0 {
		t.Fatalf("fee on zero notional = %v", got)
	}
}

func TestQuantumFollowsTheFourDecimalDate(t *testing.T) {
	from := dayAt(10)
	near(t, "cents before", Quantum(dayAt(9), from), 0.005, 0)
	near(t, "four decimals from", Quantum(dayAt(10), from), 0.00005, 0)
}

func TestClassifyBarArtefactIsPriceReturn(t *testing.T) {
	prev := mkBar(10, 10)
	cur := features.Bar{Open: 10, High: 10, Low: 10, Close: 10, AdjClose: 13, Volume: 1e6}
	b := ClassifyBar(prev, cur, true, dayAt(3), base)
	if b.TotalReturn {
		t.Fatal("a 30% step was classified total-return")
	}
	if b.Unadjusted {
		t.Fatal("a 30% step was classified unadjusted")
	}
}

func TestClassifyBarFirstBarHasNoBasis(t *testing.T) {
	b := ClassifyBar(features.Bar{}, mkBar(10, 10), false, dayAt(3), base)
	if b.HasPrev || b.TotalReturn || b.Unadjusted {
		t.Fatalf("a first loaded bar produced a basis: %+v", b)
	}
}

func TestClassifyBarRejectsNonPositivePrices(t *testing.T) {
	prev := mkBar(10, 10)
	cur := mkBar(10, 10)
	cur.AdjClose = 0
	b := ClassifyBar(prev, cur, true, dayAt(3), base)
	if !b.HasPrev || b.TotalReturn || b.Unadjusted {
		t.Fatalf("an unpriced adjusted close produced a total-return step: %+v", b)
	}
	near(t, "daily rate", DailyRate(0.04), math.Pow(1.04, 1.0/252)-1, 1e-15)
}
