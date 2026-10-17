package strategies

// ruleWeights is the score recipe for every strategy, in one map (the
// verdict.go pattern). Each strategy's weights sum to 1, and every rule the
// strategy declares has exactly one weight (TestWeightsCoverEveryRule).
//
// A passing rule contributes weight x (0.6 + 0.4 x strength) x 100 points,
// where strength (0..1) grades how decisively it passed; a failing or unknown
// rule contributes nothing. So a stock passing every rule scores 60-100, and
// the score only orders rows WITHIN a status: the status ladder decides first.
var ruleWeights = map[string]map[string]float64{
	IDZangerBreakout: {
		RuleGrowth:    0.25,
		RuleBase:      0.20,
		RuleBreakout:  0.25,
		RuleRegime:    0.10,
		RuleRS:        0.10,
		RuleLiquidity: 0.10,
	},
	IDCANSLIM: {
		RuleEPSGrowth:     0.25,
		RuleRevenueGrowth: 0.10,
		RuleNearHigh:      0.20,
		RuleRSLeader:      0.25,
		RuleRegime:        0.10,
		RuleLiquidity:     0.10,
	},
	IDMinerviniTrendTemplate: {
		RuleTrendStack:   0.20,
		RuleSMA200Rising: 0.15,
		RuleAboveLow:     0.10,
		RuleOffHigh:      0.15,
		RuleRSLeader:     0.20,
		RuleAboveSMA50:   0.10,
		RuleLiquidity:    0.10,
	},
	IDCrowdedShortBreakout: {
		RuleShortInterest: 0.25,
		RuleDaysToCover:   0.15,
		RuleBreakout:      0.25,
		RuleRegime:        0.10,
		RuleLiquidity:     0.10,
		RuleRS:            0.15,
	},
	IDQualityCompounders: {
		RuleROE:                 0.20,
		RuleNetMargin:           0.15,
		RuleCashConversion:      0.15,
		RuleLeverage:            0.15,
		RuleLiquidity:           0.10,
		RuleAboveSMA200:         0.15,
		RuleRevenueNotShrinking: 0.10,
	},
}

const (
	passFloor    = 0.6 // share of a rule's weight earned just by passing
	passStrength = 0.4 // share earned by passing decisively
)
