package spec

// v1 is the first frozen version: the rules v0 evaluated, with the universe,
// the short data and the status ladder changed as the changelog states. The
// thresholds, weights, trigger sets and core sets are v0's, so the changelog
// isolates the fixes from parameter changes.

// v1PriceFourDPFrom is the first bar dated after the day migration 000131 made
// prices four decimal places in prod. Bars before it keep the cent tolerance
// of the total-return test (4.8).
const v1PriceFourDPFrom = "2026-09-29"

// v1UpjumpFrom is the first bar the unadjusted up-jump guard reads: the day
// after the last live price re-sync (2026-09-28), so every bar it can see is
// one the re-sync did not adjust.
const v1UpjumpFrom = "2026-09-29"

// v1Changes is the v1 changelog, word for word on the changelog page and each
// Rules tab.
var v1Changes = []string{
	"Ordinary shares only. Exchange-traded products in ASX's Investment Products list and the debt, hybrid, deferred and secondary lines are excluded. Affects every strategy and the relative-strength quartile. The product list is current; it is applied to every date.",
	"A price bar on the session is required. Suspended or delisted codes no longer keep frozen features, including a breakout that never aged out.",
	"Corporate-action guard. A code is not evaluated for 260 sessions after a corroborated unadjusted share consolidation or split, or after an integer-ratio up-jump of 1.8x or more in bars since the last price re-sync.",
	"Crowded-Short universe: the ordinary names in the latest complete ASIC report published by the session.",
	"Short interest as published: the stock's row in the latest complete ASIC report published by the session, four sessions after the report. A reported zero is zero (fail). A stock absent from a complete report has no reportable position (fail, and outside Crowded-Short's universe). With no complete report within 8 sessions, the short rules are unknown. This replaces the latest non-zero figure, forever.",
	"Days to cover: reported positions divided by the mean volume of the last 20 bars, zero-volume bars included. Unknown when fewer than 10 of them traded, fewer than 20 bars exist, or a corroborated consolidation lies between the report and the session.",
	"New status Unknown: no core non-trigger rule fails and at least one core rule is unknown. An unknown trigger no longer reads as setup. The downtrend demotion is unchanged and stated: a failing regime rule makes every Zanger and CAN SLIM stock watch.",
	"Every unknown rule carries a reason.",
	"Evaluation text is not yet generated from the thresholds: the rule text still carries the v0 wording on prices (2 decimal places) and on liquidity, and the generated text follows in a later release. The rules, not the text, are v1.",
}

// v1 builds the v1 registered version of a strategy. It is live from the
// daily job's first snapshot after it is published; until then the job evaluates
// v0. Its recipe is the strategy's r1 recipe.
func v1(strategyID string) Registered {
	base := v0(strategyID)
	s := base.Spec
	s.Universe = UniverseSpec{
		Instruments:  "ordinary",
		Freshness:    "bar_on_session",
		MinSessions:  60,
		LookbackDays: 400,
		ASICReported: strategyID == StrategyCrowdedShortBreakout,
		CAGuard:      true,
		RSPopulation: "universe",
	}
	s.Data = DataPolicy{
		ShortSource:            "latest_complete_published",
		PublicationLagSessions: 4,
		MaxReportAgeSessions:   8,
		Calendar:               "xjo_and_asic_dates",
		DTC:                    "v1_20_bars_min10_traded",
		Absent:                 "fail",
		Fundamentals:           "live_snapshot",
		Price4dpFrom:           v1PriceFourDPFrom,
		CAUpjumpFrom:           v1UpjumpFrom,
	}
	s.Ladder = LadderSpec{UnknownStatus: true, PickRequiresStockPass: true}
	return Registered{
		Label:       "v1",
		Live:        true,
		Spec:        s,
		Changes:     append([]string(nil), v1Changes...),
		KnownIssues: nil,
		Recipe:      r1RecipeFor(strategyID),
	}
}

// r1RecipeFor is the r1 recipe of a strategy, or nil when it has none. v0 is
// never backtested, so it never carries one.
func r1RecipeFor(strategyID string) *Recipe {
	for _, r := range R1Recipes() {
		if r.StrategyID == strategyID {
			rc := r
			return &rc
		}
	}
	return nil
}
