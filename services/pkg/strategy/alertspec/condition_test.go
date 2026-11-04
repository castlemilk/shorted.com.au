package alertspec

import "testing"

// obsStatus is an observation carrying only a status.
func obsStatus(s string) *Observation { return &Observation{Status: s} }

// obsRule is an observation carrying one rule outcome.
func obsRule(id string, t Truth) *Observation {
	return &Observation{Rules: map[string]Truth{id: t}}
}

// obsMetric is an observation carrying one metric value.
func obsMetric(key string, v float64) *Observation {
	return &Observation{Metrics: map[string]float64{key: v}}
}

// obsClose is an observation carrying a close.
func obsClose(v float64) *Observation {
	return obsMetric(MetricClose, v)
}

func TestStatusConditions(t *testing.T) {
	triggered := func(op string) Condition {
		return Condition{Kind: KindStatus, Status: StatusTriggered, Op: op}
	}
	cases := []condCase{
		{"is: current triggered", triggered(OpIs), obsStatus(StatusSetup), obsStatus(StatusTriggered), false, True},
		{"is: current setup", triggered(OpIs), obsStatus(StatusTriggered), obsStatus(StatusSetup), false, False},
		{"is: no current status", triggered(OpIs), obsStatus(StatusTriggered), obsStatus(""), false, Unknown},
		{"becomes: moved in", triggered(OpBecomes), obsStatus(StatusSetup), obsStatus(StatusTriggered), false, True},
		{"becomes: already there", triggered(OpBecomes), obsStatus(StatusTriggered), obsStatus(StatusTriggered), false, False},
		{"becomes: no previous session", triggered(OpBecomes), nil, obsStatus(StatusTriggered), false, Unknown},
		{"becomes: previous status unknown", triggered(OpBecomes), obsStatus(""), obsStatus(StatusTriggered), false, Unknown},
		{"becomes: not triggered now", triggered(OpBecomes), obsStatus(StatusSetup), obsStatus(StatusOther), false, False},
		{"becomes, first evaluation: state form", triggered(OpBecomes), nil, obsStatus(StatusTriggered), true, True},
		{"becomes, first evaluation: not triggered", triggered(OpBecomes), nil, obsStatus(StatusSetup), true, False},
		{"leaves: moved out", triggered(OpLeaves), obsStatus(StatusTriggered), obsStatus(StatusSetup), false, True},
		{"leaves: still there", triggered(OpLeaves), obsStatus(StatusTriggered), obsStatus(StatusTriggered), false, False},
		{"leaves: was never there", triggered(OpLeaves), obsStatus(StatusSetup), obsStatus(StatusSetup), false, False},
		{"leaves: no previous session", triggered(OpLeaves), nil, obsStatus(StatusSetup), false, Unknown},
		{"leaves, first evaluation: is not triggered", triggered(OpLeaves), nil, obsStatus(StatusSetup), true, True},
		{"leaves, first evaluation: still triggered", triggered(OpLeaves), nil, obsStatus(StatusTriggered), true, False},
	}
	runConditions(t, cases)
}

func TestRuleConditions(t *testing.T) {
	passOp := func(op string) Condition { return Condition{Kind: KindRule, RuleID: "breakout", Op: op} }
	cases := []condCase{
		{"passes", passOp(OpPasses), nil, obsRule("breakout", True), false, True},
		{"passes: fails", passOp(OpPasses), nil, obsRule("breakout", False), false, False},
		{"passes: rule missing", passOp(OpPasses), nil, obsRule("other", True), false, Unknown},
		{"fails: fails", passOp(OpFails), nil, obsRule("breakout", False), false, True},
		{"fails: unknown stays unknown", passOp(OpFails), nil, obsRule("breakout", Unknown), false, Unknown},
		{"becomes_pass: turns on", passOp(OpBecomesPass), obsRule("breakout", False), obsRule("breakout", True), false, True},
		{"becomes_pass: stays on", passOp(OpBecomesPass), obsRule("breakout", True), obsRule("breakout", True), false, False},
		{"becomes_pass: stays off", passOp(OpBecomesPass), obsRule("breakout", False), obsRule("breakout", False), false, False},
		{"becomes_pass: no previous", passOp(OpBecomesPass), nil, obsRule("breakout", True), false, Unknown},
		{"becomes_pass: current fails whatever the previous", passOp(OpBecomesPass), nil, obsRule("breakout", False), false, False},
		{"becomes_pass, first evaluation: passes", passOp(OpBecomesPass), nil, obsRule("breakout", True), true, True},
	}
	runConditions(t, cases)
}

func TestMetricConditions(t *testing.T) {
	at := func(op string, v float64) Condition {
		return Condition{Kind: KindMetric, Metric: MetricShortPct, Op: op, Value: f(v)}
	}
	cases := []condCase{
		{"is_at_least: at the line", at(OpIsAtLeast, 5), nil, obsMetric(MetricShortPct, 5), false, True},
		{"is_at_least: under", at(OpIsAtLeast, 5), nil, obsMetric(MetricShortPct, 4.99), false, False},
		{"is_at_least: missing value", at(OpIsAtLeast, 5), nil, obsMetric(MetricDaysToCover, 3), false, Unknown},
		{"is_at_most: at the line", at(OpIsAtMost, 5), nil, obsMetric(MetricShortPct, 5), false, True},
		{"is_at_most: over", at(OpIsAtMost, 5), nil, obsMetric(MetricShortPct, 5.01), false, False},
		{"crosses_above: crossed on the session", at(OpCrossesAbove, 5), obsMetric(MetricShortPct, 4.9), obsMetric(MetricShortPct, 5), false, True},
		{"crosses_above: already above", at(OpCrossesAbove, 5), obsMetric(MetricShortPct, 5.5), obsMetric(MetricShortPct, 6), false, False},
		{"crosses_above: still under", at(OpCrossesAbove, 5), obsMetric(MetricShortPct, 4), obsMetric(MetricShortPct, 4.5), false, False},
		{"crosses_above: no previous, now above", at(OpCrossesAbove, 5), nil, obsMetric(MetricShortPct, 6), false, Unknown},
		{"crosses_above: no previous, now under", at(OpCrossesAbove, 5), nil, obsMetric(MetricShortPct, 4), false, False},
		{"crosses_above, first evaluation: above", at(OpCrossesAbove, 5), nil, obsMetric(MetricShortPct, 6), true, True},
		{"crosses_above, first evaluation: under", at(OpCrossesAbove, 5), nil, obsMetric(MetricShortPct, 4), true, False},
		{"crosses_below: crossed on the session", at(OpCrossesBelow, 5), obsMetric(MetricShortPct, 5.1), obsMetric(MetricShortPct, 5), false, True},
		{"crosses_below: exactly at the line before", at(OpCrossesBelow, 5), obsMetric(MetricShortPct, 5), obsMetric(MetricShortPct, 4), false, False},
		{"crosses_below: no previous", at(OpCrossesBelow, 5), nil, obsMetric(MetricShortPct, 4), false, Unknown},
		{"crosses_below, first evaluation: under", at(OpCrossesBelow, 5), nil, obsMetric(MetricShortPct, 4), true, True},
		{"crosses_below: current missing", at(OpCrossesBelow, 5), obsMetric(MetricShortPct, 6), obsMetric(MetricDaysToCover, 1), false, Unknown},
		{"crosses_below: current NaN", at(OpCrossesBelow, 5), obsMetric(MetricShortPct, 6), obsMetric(MetricShortPct, nan()), false, Unknown},
		{"sma: close under the 50-session average", Condition{Kind: KindMetric, Metric: MetricCloseVsSMA, N: 50, Op: OpIsAtMost, Value: f(0)},
			nil, obsMetric(SMAKey(50), -1.2), false, True},
		{"sma: 200 is a different key", Condition{Kind: KindMetric, Metric: MetricCloseVsSMA, N: 200, Op: OpIsAtMost, Value: f(0)},
			nil, obsMetric(SMAKey(50), -1.2), false, Unknown},
	}
	runConditions(t, cases)
}

func TestPositionConditions(t *testing.T) {
	pivot := f(10)
	pos := func(p *Position) *Position { return p }
	heldAt := func(n int) *Position { return &Position{EntryPrice: 9, Pivot: pivot, SessionsHeld: n} }
	cases := []positionCase{
		{"close crosses below the pivot on the session", Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
			pos(heldAt(5)), obsClose(10.2), obsClose(9.9), false, True},
		{"close holds above the pivot", Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
			pos(heldAt(5)), obsClose(10.2), obsClose(10.1), false, False},
		{"pivot-based exit with no captured pivot is unknown", Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
			&Position{EntryPrice: 9, SessionsHeld: 5}, obsClose(10.2), obsClose(9.9), false, Unknown},
		{"close crosses below the pivot, first evaluation: already below", Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
			pos(heldAt(5)), nil, obsClose(9.9), true, True},
		{"return since entry at or under -5%", Condition{Kind: KindPosition, Metric: MetricReturnSinceEntry, Op: OpIsAtMost, Value: f(-5)},
			&Position{EntryPrice: 10, SessionsHeld: 3}, nil, obsClose(9.4), false, True},
		{"return since entry: no close", Condition{Kind: KindPosition, Metric: MetricReturnSinceEntry, Op: OpIsAtMost, Value: f(-5)},
			&Position{EntryPrice: 10, SessionsHeld: 3}, nil, &Observation{}, false, Unknown},
		{"sessions held reaches 20 on the 20th session", Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
			heldAt(20), obsClose(10), obsClose(10), false, True},
		{"sessions held past 20 is not a new crossing", Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
			heldAt(21), obsClose(10), obsClose(10), false, False},
		{"sessions held under 20", Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
			heldAt(19), obsClose(10), obsClose(10), false, False},
		{"sessions held, first evaluation: already past", Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
			heldAt(25), nil, obsClose(10), true, True},
		{"sessions held: no previous session", Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
			heldAt(20), nil, obsClose(10), false, Unknown},
		{"position metric with no position", Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
			nil, obsClose(10), obsClose(10), false, Unknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := evalCondition(c.c, c.cur, c.prev, c.pos, c.stateForm)
			if got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

type positionCase struct {
	name      string
	c         Condition
	pos       *Position
	prev, cur *Observation
	stateForm bool
	want      Truth
}

type condCase struct {
	name      string
	c         Condition
	prev, cur *Observation
	stateForm bool
	want      Truth
}

func runConditions(t *testing.T, cases []condCase) {
	t.Helper()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := evalCondition(c.c, c.cur, c.prev, nil, c.stateForm)
			if got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}
