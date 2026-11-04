package engine

// ruleThreshold is the single number a rule tests, in its unit, and how it is
// compared. Only rules with one such number have an entry: a rule that tests a
// shape (the regime, a breakout's pivot, the trend stack) reads has_threshold
// false. The values are the named constants of rules.go, so the prose, the
// evaluation and this table cannot drift apart (TestRegistryAnnotatesDefinitionFacts).
type ruleThreshold struct {
	value      float64
	unit       string
	comparator string
}

// ruleThresholds is keyed by rule id. Units are the rule-spec words (pct, pp,
// aud, days, x); the display symbols belong to the web.
//
// rs_leader has no entry: its cut-off is the universe's 75th percentile of
// rs_6m_pct in points (GetStrategyPicksResponse.rs_quantile_threshold), which is
// not the unit of the rule's value. A stock is in the top quartile exactly when
// its rs_6m_percentile is 75 or more.
//
// TestRegistryAnnotatesDefinitionFacts checks every entry, comparator included,
// against the rule the registry publishes.
var ruleThresholds = map[string]ruleThreshold{
	RuleGrowth:              {growthMinPct, "pct", ">="},
	RuleBase:                {baseMaxDepthPct, "pct", "<="},
	RuleRS:                  {0, "pp", ">"},
	RuleLiquidity:           {LiquidityFloorAUD, "aud", ">="},
	RuleEPSGrowth:           {growthMinPct, "pct", ">="},
	RuleRevenueGrowth:       {revenueGrowthMinPct, "pct", ">="},
	RuleNearHigh:            {nearHighMaxOffPct, "pct", ">="},
	RuleSMA200Rising:        {0, "pct", ">"},
	RuleAboveLow:            {(aboveLowMultiple - 1) * 100, "pct", ">="},
	RuleOffHigh:             {offHighMaxOffPct, "pct", ">="},
	RuleAboveSMA50:          {0, "pct", ">"},
	RuleShortInterest:       {shortInterestMinPct, "pct", ">="},
	RuleDaysToCover:         {daysToCoverMin, "days", ">="},
	RuleROE:                 {roeMinPct, "pct", ">="},
	RuleNetMargin:           {netMarginMinPct, "pct", ">="},
	RuleCashConversion:      {cashConversionMin, "x", ">="},
	RuleLeverage:            {leverageMaxMultiple, "x", "<="},
	RuleAboveSMA200:         {0, "pct", ">"},
	RuleRevenueNotShrinking: {revenueNotShrinkingMin, "pct", ">="},
}
