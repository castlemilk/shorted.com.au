package backtest

import "math"

// SpreadTier is one band of the spread-and-impact schedule: a decision whose
// 20-session dollar volume reaches MinDV20AUD pays Bps per side.
type SpreadTier struct {
	MinDV20AUD float64
	Bps        float64
}

// Costs is the execution cost model. Each fill pays a brokerage of
// max(BrokerageBps of notional, BrokerageMinAUD) plus a spread and impact of
// the first tier (tiers are read from the highest MinDV20AUD down) that the
// decision's DV20 reaches. A decision below every tier pays the last tier. When
// FlatSlippageBps is set it replaces the tiers. The brokerage and the spread
// together are scaled by Multiplier; zero means 1.
type Costs struct {
	BrokerageBps    float64
	BrokerageMinAUD float64
	SpreadTiers     []SpreadTier
	FlatSlippageBps *float64
	Multiplier      float64
}

// HouseCosts is the default model of the strategy recipes: 10 bps brokerage
// with a A$10 minimum, and spread and impact by liquidity.
func HouseCosts() Costs {
	return Costs{
		BrokerageBps:    10,
		BrokerageMinAUD: 10,
		SpreadTiers: []SpreadTier{
			{MinDV20AUD: 20_000_000, Bps: 5},
			{MinDV20AUD: 5_000_000, Bps: 10},
			{MinDV20AUD: 1_000_000, Bps: 25},
			{MinDV20AUD: 250_000, Bps: 50},
			{MinDV20AUD: 0, Bps: 75},
		},
		Multiplier: 1,
	}
}

// FlatCosts is the flat alternative shown as a labelled sensitivity: 10 bps
// brokerage and 5 bps slippage on every fill, whatever the liquidity.
func FlatCosts() Costs {
	slip := 5.0
	return Costs{BrokerageBps: 10, BrokerageMinAUD: 10, FlatSlippageBps: &slip, Multiplier: 1}
}

func (c Costs) multiplier() float64 {
	if c.Multiplier == 0 {
		return 1
	}
	return c.Multiplier
}

// SpreadBps is the spread and impact, in basis points per side, for a decision
// with the given 20-session dollar volume.
func (c Costs) SpreadBps(dv20 float64) float64 {
	if c.FlatSlippageBps != nil {
		return *c.FlatSlippageBps
	}
	for _, t := range c.SpreadTiers {
		if dv20 >= t.MinDV20AUD {
			return t.Bps
		}
	}
	if n := len(c.SpreadTiers); n > 0 {
		return c.SpreadTiers[n-1].Bps
	}
	return 0
}

// Fee is what one fill of the given notional pays, in A$.
func (c Costs) Fee(notional, dv20 float64) float64 {
	if notional <= 0 {
		return 0
	}
	brokerage := math.Max(c.BrokerageBps/10000*notional, c.BrokerageMinAUD)
	spread := c.SpreadBps(dv20) / 10000 * notional
	return c.multiplier() * (brokerage + spread)
}
