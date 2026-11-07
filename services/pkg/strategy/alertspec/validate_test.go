package alertspec

import (
	"encoding/json"
	"strings"
	"testing"
)

func f(v float64) *float64 { return &v }

// entryOf wraps conditions in an enabled entry section, with an exit that is off.
func entryOf(op string, conds ...Condition) Spec {
	return Spec{
		Entry:    Section{Enabled: true, Op: op, Conditions: conds},
		Repeat:   RepeatOncePerEvent,
		Cooldown: DefaultCooldownSessions,
	}
}

// exitOf wraps conditions in an enabled exit section, with an entry that is off.
func exitOf(op string, conds ...Condition) Spec {
	return Spec{
		Exit:     Section{Enabled: true, Op: op, Conditions: conds},
		Repeat:   RepeatOncePerEvent,
		Cooldown: DefaultCooldownSessions,
	}
}

func TestValidateAcceptsTheCataloguedForms(t *testing.T) {
	rules := map[string]bool{"breakout": true, "liquidity": true}
	valid := []Spec{
		entryOf(OpAll, DefaultEntry().Conditions...),
		entryOf(OpAll,
			Condition{Kind: KindStatus, Status: StatusSetup, Op: OpIs},
			Condition{Kind: KindRule, RuleID: "breakout", Op: OpPasses},
			Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpIsAtLeast, Value: f(5)},
			Condition{Kind: KindMetric, Metric: MetricDollarVolume20d, Op: OpIsAtLeast, Value: f(250000)},
		),
		entryOf(OpAny,
			Condition{Kind: KindMetric, Metric: MetricVolumeRatio50d, Op: OpCrossesAbove, Value: f(1.5)},
			Condition{Kind: KindRule, RuleID: "liquidity", Op: OpBecomesPass},
			Condition{Kind: KindMetric, Metric: MetricCloseVsSMA, N: 200, Op: OpCrossesBelow, Value: f(0)},
		),
		{
			Entry: DefaultEntry(),
			Exit: Section{Enabled: true, Op: OpAny, Conditions: []Condition{
				{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
				{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
				{Kind: KindStatus, Status: StatusTriggered, Op: OpLeaves},
				{Kind: KindRule, RuleID: "breakout", Op: OpFails},
			}},
			Repeat: RepeatOncePerEvent, Cooldown: MaxCooldownSessions,
		},
	}
	for i, s := range valid {
		if err := s.Validate(rules); err != nil {
			t.Errorf("valid spec %d: %v", i, err)
		}
	}
}

func TestValidateRejectsEveryBreach(t *testing.T) {
	rules := map[string]bool{"breakout": true}
	ok := Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpIsAtLeast, Value: f(5)}
	cases := []struct {
		name string
		spec Spec
		want string
	}{
		{"no side enabled", Spec{Repeat: RepeatOncePerEvent}, "enable at least one"},
		{"wrong repeat", Spec{Entry: Section{Enabled: true, Op: OpAll, Conditions: []Condition{ok}}, Repeat: "every_day"}, "repeat must be"},
		{"cooldown above the cap", withCooldown(entryOf(OpAll, ok), MaxCooldownSessions+1), "cooldown_sessions"},
		{"cooldown negative", withCooldown(entryOf(OpAll, ok), -1), "cooldown_sessions"},
		{"seven conditions", entryOf(OpAll, repeat(ok, 7)...), "at most 6 conditions"},
		{"enabled with no conditions", entryOf(OpAll), "needs 1 to 6"},
		{"bad group op", entryOf("some", ok), "op must be"},
		{"unknown kind", entryOf(OpAll, Condition{Kind: "vibes", Op: OpIs}), "unknown kind"},
		{"status not a rung", entryOf(OpAll, Condition{Kind: KindStatus, Status: "watch", Op: OpIs}), "status must be"},
		{"status on exit other than leaves triggered", exitOf(OpAll, Condition{Kind: KindStatus, Status: StatusSetup, Op: OpLeaves}), "exit side"},
		{"status with a value", entryOf(OpAll, Condition{Kind: KindStatus, Status: StatusTriggered, Op: OpIs, Value: f(1)}), "takes only"},
		{"rule not in version", entryOf(OpAll, Condition{Kind: KindRule, RuleID: "ghost", Op: OpPasses}), "not a rule of the pinned version"},
		{"rule id malformed", entryOf(OpAll, Condition{Kind: KindRule, RuleID: "Break Out", Op: OpPasses}), "is not a rule id"},
		{"rule op on exit", exitOf(OpAll, Condition{Kind: KindRule, RuleID: "breakout", Op: OpPasses}), "not allowed on the exit"},
		{"unknown metric", entryOf(OpAll, Condition{Kind: KindMetric, Metric: "moon", Op: OpIsAtLeast, Value: f(1)}), "unknown metric"},
		{"metric with the wrong kind", entryOf(OpAll, Condition{Kind: KindPosition, Metric: MetricShortPct, Op: OpIsAtLeast, Value: f(1)}), "is kind"},
		{"transition op on a state metric", entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricVolumeRatio50d, Op: OpCrossesBelow, Value: f(1)}), "not allowed"},
		{"sma without n", entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricCloseVsSMA, N: 20, Op: OpIsAtMost, Value: f(0)}), "needs n of 50 or 200"},
		{"n on a plain metric", entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricShortPct, N: 50, Op: OpIsAtLeast, Value: f(1)}), "takes no n"},
		{"metric without value", entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpIsAtLeast}), "needs a value"},
		{"NaN value", entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpIsAtLeast, Value: f(nan())}), "finite"},
		{"short interest above 100", entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpIsAtLeast, Value: f(120)}), "out of range"},
		{"close of zero", entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricClose, Op: OpIsAtLeast, Value: f(0)}), "out of range"},
		{"position metric on entry", entryOf(OpAll, Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(5)}), "not available on the entry"},
		{"sessions held fractional", exitOf(OpAll, Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(2.5)}), "out of range"},
		{"sessions held past the limit", exitOf(OpAll, Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(MaxHoldSessions + 1)}), "out of range"},
		{"close vs entry pivot on entry", entryOf(OpAll, Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)}), "not available on the entry"},
		{"disabled side still malformed", Spec{
			Entry:  Section{Enabled: true, Op: OpAll, Conditions: []Condition{ok}},
			Exit:   Section{Enabled: false, Conditions: []Condition{{Kind: KindMetric, Metric: "moon", Op: OpIs, Value: f(1)}}},
			Repeat: RepeatOncePerEvent,
		}, "exit.conditions[0]"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.spec.Validate(rules)
			if err == nil {
				t.Fatalf("expected an error containing %q", c.want)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("error %q does not contain %q", err, c.want)
			}
		})
	}
}

func TestValidateSkipsRuleExistenceWhenNoSetIsGiven(t *testing.T) {
	s := entryOf(OpAll, Condition{Kind: KindRule, RuleID: "anything", Op: OpPasses})
	if err := s.Validate(nil); err != nil {
		t.Fatalf("structure-only validation rejected a well-formed rule: %v", err)
	}
	if err := s.Validate(map[string]bool{}); err == nil {
		t.Fatal("an empty rule set must reject every rule")
	}
}

func TestDecodingAppliesTheDocumentedDefaults(t *testing.T) {
	var s Spec
	if err := json.Unmarshal([]byte(`{"entry":{"enabled":true,"op":"all","conditions":[]}}`), &s); err != nil {
		t.Fatal(err)
	}
	if s.Cooldown != DefaultCooldownSessions || s.Repeat != RepeatOncePerEvent {
		t.Fatalf("defaults: cooldown %d repeat %q", s.Cooldown, s.Repeat)
	}
	var zero Spec
	if err := json.Unmarshal([]byte(`{"cooldown_sessions":0}`), &zero); err != nil {
		t.Fatal(err)
	}
	if zero.Cooldown != 0 {
		t.Fatalf("an explicit zero cooldown was overwritten with %d", zero.Cooldown)
	}
}

func withCooldown(s Spec, n int) Spec {
	s.Cooldown = n
	return s
}

func repeat(c Condition, n int) []Condition {
	out := make([]Condition, n)
	for i := range out {
		out[i] = c
	}
	return out
}

func nan() float64 {
	zero := 0.0
	return zero / zero
}
