package backtest

import (
	"math"
	"testing"
)

func TestHouseCostsByLiquidityTier(t *testing.T) {
	c := HouseCosts()
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
			near(t, "fee", c.Fee(tc.notional, tc.dv20), tc.want, 1e-9)
		})
	}
}

func TestFlatCostsIgnoreLiquidity(t *testing.T) {
	c := FlatCosts()
	// 10 bps brokerage on A$10,000 is A$10, and 5 bps of slippage is A$5.
	near(t, "flat fee deep", c.Fee(10000, 1e9), 15, 1e-9)
	near(t, "flat fee thin", c.Fee(10000, 1000), 15, 1e-9)
}

func TestCostMultiplierScalesTheFee(t *testing.T) {
	c := HouseCosts()
	base := c.Fee(10000, 1e9)
	c.Multiplier = 2
	near(t, "doubled fee", c.Fee(10000, 1e9), 2*base, 1e-9)
	c.Multiplier = 0
	near(t, "zero means one", c.Fee(10000, 1e9), base, 1e-9)
}

func TestNoFeeOnNoNotional(t *testing.T) {
	if got := HouseCosts().Fee(0, 1e9); got != 0 {
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
	cur := Bar{Present: true, Open: 10, High: 10, Low: 10, Close: 10, Adj: 13, Volume: 1e6}
	b := ClassifyBar(prev, cur, true, dayAt(3), base)
	if b.TotalReturn {
		t.Fatal("a 30% step was classified total-return")
	}
	if b.Unadjusted {
		t.Fatal("a 30% step was classified unadjusted")
	}
}

func TestClassifyBarFirstBarHasNoBasis(t *testing.T) {
	b := ClassifyBar(Bar{}, mkBar(10, 10), false, dayAt(3), base)
	if b.HasPrev || b.TotalReturn || b.Unadjusted {
		t.Fatalf("a first loaded bar produced a basis: %+v", b)
	}
}

func TestClassifyBarRejectsNonPositivePrices(t *testing.T) {
	prev := mkBar(10, 10)
	cur := mkBar(10, 10)
	cur.Adj = 0
	b := ClassifyBar(prev, cur, true, dayAt(3), base)
	if !b.HasPrev || b.TotalReturn || b.Unadjusted {
		t.Fatalf("an unpriced adjusted close produced a total-return step: %+v", b)
	}
	near(t, "daily rate", DailyRate(0.04), math.Pow(1.04, 1.0/252)-1, 1e-15)
}
