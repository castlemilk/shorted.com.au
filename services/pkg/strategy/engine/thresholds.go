package engine

// ruleThreshold is the single number a rule tests, in its unit, and how it is
// compared. Only rules with one such number have an entry: a rule that tests a
// shape (the regime, a breakout's pivot, the trend stack) reads has_threshold
// false. The values are the named constants of rules.go, so the prose, the
// evaluation and this table cannot drift apart (TestRuleThresholdsMatchRules).
type ruleThreshold struct {
	value      float64
	unit       string
	comparator string
}

// ruleThresholds is keyed by rule id. rs_leader is the 75th percentile of the
// evaluated universe, so its value is the percentile, not a return.
var ruleThresholds = map[string]ruleThreshold{
	RuleGrowth:              {growthMinPct, "%", ">="},
	RuleBase:                {baseMaxDepthPct, "%", "<="},
	RuleRS:                  {0, "points", ">"},
	RuleLiquidity:           {LiquidityFloorAUD, "A$", ">="},
	RuleEPSGrowth:           {growthMinPct, "%", ">="},
	RuleRevenueGrowth:       {revenueGrowthMinPct, "%", ">="},
	RuleNearHigh:            {nearHighMaxOffPct, "%", ">="},
	RuleRSLeader:            {rsLeaderQuantile * 100, "percentile", ">="},
	RuleSMA200Rising:        {0, "%", ">"},
	RuleAboveLow:            {(aboveLowMultiple - 1) * 100, "%", ">="},
	RuleOffHigh:             {offHighMaxOffPct, "%", ">="},
	RuleAboveSMA50:          {0, "%", ">"},
	RuleShortInterest:       {shortInterestMinPct, "%", ">="},
	RuleDaysToCover:         {daysToCoverMin, "days", ">="},
	RuleROE:                 {roeMinPct, "%", ">="},
	RuleNetMargin:           {netMarginMinPct, "%", ">="},
	RuleCashConversion:      {cashConversionMin, "x", ">="},
	RuleLeverage:            {leverageMaxMultiple, "x", "<="},
	RuleAboveSMA200:         {0, "%", ">"},
	RuleRevenueNotShrinking: {revenueNotShrinkingMin, "%", ">="},
}
