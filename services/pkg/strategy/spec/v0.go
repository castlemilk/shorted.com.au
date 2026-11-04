package spec

// v0 describes exactly what the engine evaluates today. Its hash and its known
// issues are published before anything changes, so every later version can be
// compared with it. The thresholds, weights and far distances here are the
// engine's constants (engine/rules.go, weights.go, proximity.go); the engine
// test suite pins each one.

// ruleDef is what a rule id means, independent of the strategy using it.
type ruleDef struct {
	unit    string
	compare string
	params  map[string]float64
	// far is the proximity distance of a trigger rule (proximity.go). It is
	// written into a RuleSpec only when the rule is a trigger in that strategy.
	far float64
	// sources is the data the rule reads: prices, index:XJO, asic, fundamentals.
	// A rule reads every one it lists, whether or not a strategy has a regime rule.
	sources []string
}

// ruleDefs holds one entry per rule id the v0 strategies use.
var ruleDefs = map[string]ruleDef{
	"growth":                {"pct", ">=", map[string]float64{"min_pct": 25}, 0, []string{"fundamentals"}},
	"eps_growth":            {"pct", ">=", map[string]float64{"min_pct": 25}, 0, []string{"fundamentals"}},
	"revenue_growth":        {"pct", ">=", map[string]float64{"min_pct": 20}, 0, []string{"fundamentals"}},
	"base":                  {"days", "within", map[string]float64{"min_sessions": 20, "max_depth_pct": 25, "window_sessions": 40}, 0, []string{"prices"}},
	"breakout":              {"x", "bool", map[string]float64{"window_sessions": 5, "prior_sessions": 40, "volume_multiple": 1.5, "volume_sessions": 50}, 10, []string{"prices"}},
	"regime":                {"bool", "bool", map[string]float64{"sma_fast": 50, "sma_slow": 200}, 0, []string{"index:XJO"}},
	"rs":                    {"pp", ">", map[string]float64{"lookback_months": 3, "min_points": 0}, 0, []string{"prices", "index:XJO"}},
	"liquidity":             {"aud", ">=", map[string]float64{"min_aud": 250000, "sessions": 20}, 0, []string{"prices"}},
	"near_high":             {"pct", ">=", map[string]float64{"max_off_pct": -5}, 15, []string{"prices"}},
	"rs_leader":             {"percentile", ">=", map[string]float64{"quantile": 0.75}, 20, []string{"prices", "index:XJO"}},
	"trend_stack":           {"bool", "bool", map[string]float64{"sma_mid": 150, "sma_slow": 200}, 0, []string{"prices"}},
	"sma200_rising":         {"bool", ">", map[string]float64{"sma_slow": 200, "lag_sessions": 21}, 0, []string{"prices"}},
	"above_low":             {"x", ">=", map[string]float64{"multiple": 1.3}, 0, []string{"prices"}},
	"off_high":              {"pct", ">=", map[string]float64{"max_off_pct": -25}, 25, []string{"prices"}},
	"above_sma50":           {"pct", ">", map[string]float64{"sma": 50}, 0, []string{"prices"}},
	"short_interest":        {"pct", ">=", map[string]float64{"min_pct": 5}, 0, []string{"asic"}},
	"days_to_cover":         {"days", ">=", map[string]float64{"min": 5}, 0, []string{"asic"}},
	"roe":                   {"pct", ">=", map[string]float64{"min_pct": 15}, 0, []string{"fundamentals"}},
	"net_margin":            {"pct", ">=", map[string]float64{"min_pct": 10}, 0, []string{"fundamentals"}},
	"cash_conversion":       {"x", ">=", map[string]float64{"min": 0.8}, 0, []string{"fundamentals"}},
	"leverage":              {"x", "<=", map[string]float64{"max_multiple": 2.5}, 0, []string{"fundamentals"}},
	"above_sma200":          {"pct", ">", map[string]float64{"sma": 200}, 10, []string{"prices"}},
	"revenue_not_shrinking": {"pct", ">=", map[string]float64{"min_pct": 0}, 0, []string{"fundamentals"}},
}

// v0Rule is one rule of one strategy in v0: its role and weight there.
type v0Rule struct {
	id      string
	core    bool
	trigger bool
	weight  float64
}

// v0Rules lists each strategy's rules in registry order, with the roles and
// weights the engine uses (registry.go, weights.go).
var v0Rules = map[string][]v0Rule{
	StrategyZangerBreakout: {
		{"growth", true, false, 0.25},
		{"base", true, false, 0.20},
		{"breakout", true, true, 0.25},
		{"regime", true, false, 0.10},
		{"rs", false, false, 0.10},
		{"liquidity", true, false, 0.10},
	},
	StrategyCANSLIM: {
		{"eps_growth", true, false, 0.25},
		{"revenue_growth", false, false, 0.10},
		{"near_high", true, true, 0.20},
		{"rs_leader", true, true, 0.25},
		{"regime", true, false, 0.10},
		{"liquidity", true, false, 0.10},
	},
	StrategyMinerviniTrend: {
		{"trend_stack", true, false, 0.20},
		{"sma200_rising", true, false, 0.15},
		{"above_low", true, false, 0.10},
		{"off_high", true, true, 0.15},
		{"rs_leader", true, true, 0.20},
		{"above_sma50", false, false, 0.10},
		{"liquidity", true, false, 0.10},
	},
	StrategyCrowdedShortBreakout: {
		{"short_interest", true, false, 0.25},
		{"days_to_cover", false, false, 0.15},
		{"breakout", true, true, 0.25},
		{"regime", false, false, 0.10},
		{"liquidity", true, false, 0.10},
		{"rs", false, false, 0.15},
	},
	StrategyQualityCompounders: {
		{"roe", true, false, 0.20},
		{"net_margin", true, false, 0.15},
		{"cash_conversion", true, false, 0.15},
		{"leverage", true, false, 0.15},
		{"liquidity", true, false, 0.10},
		{"above_sma200", true, true, 0.15},
		{"revenue_not_shrinking", false, false, 0.10},
	},
}

// fs1 holds the feature parameters of v0, which are the SQL literals of
// migration 000130 (price features, regime) and 000080 (days to cover).
// TestFS1ParamsMatchMigrationLiterals reads them back from the migrations.
var fs1 = map[string]float64{
	"history_calendar_days":     400,
	"min_sessions":              60,
	"agg_sessions":              260,
	"breakout_prior_sessions":   40,
	"breakout_volume_sessions":  50,
	"breakout_volume_min_n":     20,
	"breakout_volume_multiple":  1.5,
	"breakout_window":           5,
	"base_window":               40,
	"touch_ratio":               0.98,
	"high_low_sessions":         252,
	"dv_sessions":               20,
	"dv_min_n":                  10,
	"avgvol_from":               2,
	"avgvol_to":                 51,
	"avgvol_min_n":              20,
	"ret_anchor_tolerance_days": 10,
	"rs_index_tolerance_days":   7,
	"dtc_window_days":           35,
	"dtc_min_rows":              5,
}

// v0Requires lists the data sources in a fixed order, each with its earliest
// date. Fundamentals are computable from the first filing the row is built from.
var v0Requires = []struct {
	source string
	from   string
}{
	{"prices", "2015-10-01"},
	{"index:XJO", "2006-09-01"},
	{"asic", "2010-06-16"},
	{"fundamentals", "computable_from"},
}

// v0 builds the v0 registered version of a strategy.
func v0(strategyID string) Registered {
	rules := v0Rules[strategyID]
	specRules := make([]RuleSpec, 0, len(rules))
	used := map[string]bool{}
	for _, r := range rules {
		def := ruleDefs[r.id]
		for _, s := range def.sources {
			used[s] = true
		}
		rs := RuleSpec{
			ID:      r.id,
			Core:    r.core,
			Trigger: r.trigger,
			Weight:  r.weight,
			Params:  copyParams(def.params),
			Unit:    def.unit,
			Compare: def.compare,
		}
		if r.trigger {
			rs.Far = def.far
		}
		specRules = append(specRules, rs)
	}
	var requires []DataReq
	for _, q := range v0Requires {
		if used[q.source] {
			requires = append(requires, DataReq{Source: q.source, From: q.from})
		}
	}
	return Registered{
		Label: "v0",
		Live:  true,
		Spec: Spec{
			Schema:      SchemaVersion,
			EngineMajor: EngineMajor,
			StrategyID:  strategyID,
			Kind:        KindCanonical,
			FeatureSet:  "fs1",
			Features:    FeatureSpec{Params: copyParams(fs1)},
			Universe: UniverseSpec{
				Instruments:  "all",
				Freshness:    "none",
				MinSessions:  60,
				LookbackDays: 400,
				RSPopulation: "candidates",
			},
			Data: DataPolicy{
				ShortSource:  "latest_nonzero_row",
				Calendar:     "asxcalendar",
				DTC:          "v0_35d_nonzero_bigint",
				Absent:       "fail",
				Fundamentals: "live_snapshot",
			},
			Regime:   RegimeSpec{Index: "XJO", SMAFast: 50, SMASlow: 200},
			Rules:    specRules,
			Ladder:   LadderSpec{UnknownStatus: false, PickRequiresStockPass: true},
			Score:    ScoreSpec{PassFloor: 0.6, PassStrength: 0.4, TriggerCredit: 0.3},
			Requires: requires,
		},
		Changes: []string{
			"Initial version: the rules the engine evaluated before rules versioning, recorded so their hash and known issues can be published.",
		},
		KnownIssues: v0KnownIssues(),
	}
}

// v0KnownIssues are the defects of v0, as the changelog words them.
func v0KnownIssues() []string {
	return []string{
		"Exchange-traded products and other non-ordinary securities are evaluated as stocks, so an ETF or a listed investment company can trigger.",
		"A code with no price bar on the session keeps its last features, so a suspended or delisted code can keep a breakout that never ages out.",
		"Short interest is the stock's latest non-zero row in the ASIC data, with no age limit, so a stock that stopped reporting keeps its old short position.",
		"Days to cover averages only the non-zero volume bars over 35 calendar days, so zero-volume sessions do not count and days to cover reads low for thinly traded stocks.",
		"An unknown trigger rule reads as setup, so a stock whose breakout or new high cannot be measured can rank as a setup.",
		"Under the SQL views, days to cover lags one session, because mv_screener_data is refreshed before the day's prices land. The snapshot computes the same formula after they land.",
	}
}

func copyParams(in map[string]float64) map[string]float64 {
	out := make(map[string]float64, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
