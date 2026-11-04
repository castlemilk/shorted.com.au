package alertspec

import (
	"reflect"
	"testing"
)

// ten is one stock over ten sessions: its status, and its short position
// (NaN-free; a negative value means the short position is missing that day).
type ten struct {
	status string
	short  float64
}

// runTen evaluates an entry alert of two conditions (status becomes triggered
// AND short position at least 5%) over a sequence, carrying state and baseline
// as the daily job does. It returns the sessions that fired and the sessions
// that were skipped.
func runTen(t *testing.T, a Alert, seq []ten) (fired, skipped []Session) {
	t.Helper()
	state := DefaultState()
	var prev *Observation
	for i, d := range seq {
		session := Session(i + 1)
		cur := Observation{Status: d.status, Metrics: map[string]float64{}}
		if d.short >= 0 {
			cur.Metrics[MetricShortPct] = d.short
		}
		// The companion is known every session (other, 0%), so the alert is
		// never in outage and only the stock under test records its skips.
		companionObs := Observation{Status: StatusOther, Metrics: map[string]float64{MetricShortPct: 0}}
		companion := Subject{Key: "code:CMP", Side: SideEntry, Current: companionObs, Previous: &companionObs, State: DefaultState()}
		res, err := Evaluate(a, session, []Subject{
			{Key: "code:BHP", Side: SideEntry, Current: cur, Previous: prev, State: state},
			companion,
		})
		if err != nil {
			t.Fatalf("session %d: %v", session, err)
		}
		if res.SetBaseline {
			a.Baselined = true
		}
		if res.Waiting {
			t.Fatalf("session %d: unexpected outage", session)
		}
		r := res.Subjects[0]
		if r.Emit {
			fired = append(fired, session)
		}
		if r.Skipped {
			skipped = append(skipped, session)
		}
		state = r.State
		if d.status != "" || d.short >= 0 {
			c := cur
			prev = &c
		} else {
			prev = nil
		}
	}
	return fired, skipped
}

func TestTenSessionsOfAnAllGroupWithTransitions(t *testing.T) {
	spec := entryOf(OpAll,
		Condition{Kind: KindStatus, Status: StatusTriggered, Op: OpBecomes},
		Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpIsAtLeast, Value: f(5)},
	)
	spec.Cooldown = 2
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline}
	seq := []ten{
		{StatusSetup, 4},      // 1: baseline, not qualified
		{StatusTriggered, 4},  // 2: triggered, short too low: AND is false
		{StatusTriggered, 6},  // 3: short now qualifies, but triggered yesterday: no move, no fire
		{StatusSetup, 6},      // 4: reset (not triggered)
		{StatusTriggered, 6},  // 5: becomes triggered, qualified: fires (cooldown ends 7)
		{StatusTriggered, 7},  // 6: held
		{StatusSetup, 7},      // 7: reset, cooldown still on until 7 -> cleared this session
		{StatusTriggered, 7},  // 8: becomes triggered again: fires
		{StatusTriggered, -1}, // 9: short missing: the AND reads False from the status alone, no skip
		{StatusTriggered, 9},  // 10: still triggered, short back: no move since 9 was triggered
	}
	fired, skipped := runTen(t, a, seq)
	if want := []Session{5, 8}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("fired on %v, want %v", fired, want)
	}
	if len(skipped) != 0 {
		t.Fatalf("no session had unknown data on both sides of the AND, skipped %v", skipped)
	}
}

func TestTenSessionsNotifyExistingThenTransitions(t *testing.T) {
	spec := entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpCrossesAbove, Value: f(5)})
	spec.Cooldown = 0
	a := Alert{Spec: spec, FirstEval: FirstEvalNotifyExisting}
	seq := []ten{
		{"", 6},  // 1: first evaluation, already above the line: notify-existing
		{"", 7},  // 2: still above, no move
		{"", 4},  // 3: fell below, re-armed
		{"", 6},  // 4: crossed above on 4: fires
		{"", 6},  // 5: held
		{"", 5},  // 6: at the line, still above: no move
		{"", 4},  // 7: below
		{"", 5},  // 8: crosses above exactly at the line: fires
		{"", -1}, // 9: short missing, but 8 sat at the line (not below it), so the crossing is False whatever 9 holds
		{"", 5},  // 10: 9 is missing, so the crossing is unknown: the first skip
	}
	fired, skipped := runTen(t, a, seq)
	if want := []Session{1, 4, 8}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("fired on %v, want %v", fired, want)
	}
	if want := []Session{10}; !reflect.DeepEqual(skipped, want) {
		t.Fatalf("skipped on %v, want %v", skipped, want)
	}
}
