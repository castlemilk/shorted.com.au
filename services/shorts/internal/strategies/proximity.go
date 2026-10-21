package strategies

// Trigger proximity: how close a stock that has not triggered is to doing so.
//
// A strategy's trigger rules (Strategy.TriggerRules) are the core rules a
// setup may still fail: the breakout, the new-high and leadership rules, the
// 200-day cross. Before this, a failing rule contributed nothing to the score,
// so two setups that passed every other rule equally were ordered by how
// decisively they passed the rules that were NOT in question, and a stock
// 0.5% under its pivot could rank below one 14% under it. Zanger's watchlist
// is the names about to break out, so a failing trigger rule now earns a
// share of its weight that falls linearly from the trigger line to a far
// distance, and nothing beyond it:
//
//	credit = weight x triggerCredit x proximity x 100
//
// triggerCredit is below passFloor, so a failing trigger always scores less
// than the same rule passing at the floor, and a triggered stock's score is
// untouched (its trigger passes). The status ladder is unchanged: proximity
// orders rows WITHIN a status, exactly as strength does for a pass.
//
// The far distances are in each rule's own unit, chosen so that "near" means
// a move of a few ordinary sessions, not a rally.
const (
	// triggerCredit is the share of a trigger rule's weight earned at the line.
	triggerCredit = 0.3

	// breakoutFarPct: percent under the pivot at which the credit runs out.
	breakoutFarPct = 10.0
	// nearHighFarPct: percentage points under CAN SLIM's 5%-off line.
	nearHighFarPct = 15.0
	// offHighFarPct: percentage points under Minervini's 25%-off line.
	offHighFarPct = 25.0
	// rsLeaderFarPoints: relative-strength points under the quartile cut-off.
	rsLeaderFarPoints = 20.0
	// aboveSMA200FarPct: percent under the 200-day average.
	aboveSMA200FarPct = 10.0
)

// proximity maps a gap to the trigger line (in the rule's unit; at or past the
// line is <= 0) onto 0..1: 1 at the line, 0 at `far` or further.
func proximity(gap, far float64) float64 {
	if far <= 0 {
		return 0
	}
	return clamp01(1 - gap/far)
}

// triggerRuleSet is a strategy's trigger rules as a set.
func triggerRuleSet(s Strategy) map[string]bool {
	set := make(map[string]bool, len(s.TriggerRules))
	for _, id := range s.TriggerRules {
		set[id] = true
	}
	return set
}
