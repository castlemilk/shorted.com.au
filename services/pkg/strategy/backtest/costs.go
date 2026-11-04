package backtest

import (
	"math"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// spreadBps is the spread and impact, in basis points per side, for a decision
// with the given 20-session dollar volume. A flat slippage replaces the tiers.
// Otherwise the tier with the highest floor the decision reaches pays, and a
// decision below every floor pays the lowest tier. The recipe lists tiers from
// the highest floor down and the lowest starts at zero, so the lowest tier always
// exists for a recipe that validates; the lookup does not depend on list order.
func spreadBps(c spec.Costs, dv20 float64) float64 {
	if c.FlatSlippageBps != nil {
		return *c.FlatSlippageBps
	}
	best, lowest := -1, -1
	for i, t := range c.SpreadTiers {
		if lowest < 0 || t.MinDV20AUD < c.SpreadTiers[lowest].MinDV20AUD {
			lowest = i
		}
		if dv20 >= t.MinDV20AUD && (best < 0 || t.MinDV20AUD > c.SpreadTiers[best].MinDV20AUD) {
			best = i
		}
	}
	switch {
	case best >= 0:
		return c.SpreadTiers[best].Bps
	case lowest >= 0:
		return c.SpreadTiers[lowest].Bps
	}
	return 0
}

// feeFor is what one fill of the given notional pays, in A$: brokerage of the
// greater of BrokerageBps of notional and BrokerageMinAUD, plus the spread and
// impact, the sum scaled by the recipe's multiplier.
func feeFor(c spec.Costs, notional, dv20 float64) float64 {
	if notional <= 0 {
		return 0
	}
	brokerage := math.Max(c.BrokerageBps/10000*notional, c.BrokerageMinAUD)
	spread := spreadBps(c, dv20) / 10000 * notional
	return c.Multiplier * (brokerage + spread)
}
