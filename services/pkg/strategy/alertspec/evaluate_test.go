package alertspec

import (
	"reflect"
	"testing"
)

// triggeredEntry alerts when the status becomes triggered, with the given cooldown.
func triggeredEntry(cooldown int) Spec {
	s := entryOf(OpAll, DefaultEntry().Conditions...)
	s.Cooldown = cooldown
	return s
}

// day is one stock's observation on one session, for a sequence.
type day struct {
	status string // "" means no data
}

// run feeds a single entry subject through the alert day by day, carrying the
// state and the baseline as the daily job does, and returns the sessions on
// which an event fired.
func run(t *testing.T, a Alert, days []day) (fired []Session, skipped []Session) {
	t.Helper()
	state := DefaultState()
	var prev *Observation
	for i, d := range days {
		session := Session(i + 1)
		cur := &Observation{Status: d.status}
		// A companion stock with data every session keeps one missing day
		// from being an alert-level outage, so the stock under test records
		// its own skip.
		companion := Subject{Key: "code:CMP", Side: SideEntry, Current: Observation{Status: StatusOther}, State: DefaultState()}
		res, err := Evaluate(a, session, []Subject{
			{Key: "code:BHP", Side: SideEntry, Current: *cur, Previous: prev, State: state},
			companion,
		})
		if err != nil {
			t.Fatalf("session %d: %v", session, err)
		}
		if res.SetBaseline {
			a.Baselined = true
		}
		if res.Waiting {
			t.Fatalf("session %d: the companion keeps the alert out of outage: %s", session, res.WaitingReason)
		}
		r := res.Subjects[0]
		if r.Emit {
			fired = append(fired, session)
		}
		if r.Skipped {
			skipped = append(skipped, session)
		}
		state = r.State
		if d.status != "" {
			prev = cur
		} else {
			prev = nil
		}
	}
	return fired, skipped
}

func TestTheSectionFollowsKleeneAcrossUnknowns(t *testing.T) {
	rule := Condition{Kind: KindRule, RuleID: "breakout", Op: OpPasses}
	short := Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpIsAtLeast, Value: f(5)}
	cases := []struct {
		name     string
		op       string
		rule     Truth
		shortVal *float64
		want     Truth
	}{
		{"all: both true", OpAll, True, f(6), True},
		{"all: one unknown, one true", OpAll, True, nil, Unknown},
		{"all: one false beats unknown", OpAll, False, nil, False},
		{"all: both unknown", OpAll, Unknown, nil, Unknown},
		{"any: one true beats unknown", OpAny, True, nil, True},
		{"any: one unknown, one false", OpAny, False, nil, Unknown},
		{"any: both false", OpAny, False, f(1), False},
		{"any: false and true", OpAny, False, f(6), True},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			o := &Observation{Rules: map[string]Truth{"breakout": c.rule}, Metrics: map[string]float64{}}
			if c.shortVal != nil {
				o.Metrics[MetricShortPct] = *c.shortVal
			}
			sec := Section{Enabled: true, Op: c.op, Conditions: []Condition{rule, short}}
			conds := []Truth{
				evalCondition(sec.Conditions[0], o, nil, nil, false),
				evalCondition(sec.Conditions[1], o, nil, nil, false),
			}
			if got := combine(c.op, conds); got != c.want {
				t.Fatalf("section %v of %v: got %v, want %v", c.op, conds, got, c.want)
			}
		})
	}
}

func TestAnEmptySectionNeverFires(t *testing.T) {
	if combine(OpAll, nil) != False || combine(OpAny, nil) != False {
		t.Fatal("an empty group must not fire")
	}
}

func TestNotifiesOncePerEventAndRearmsAfterReset(t *testing.T) {
	a := Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalBaseline}
	// Setup, triggered (fires), triggered (held), setup (reset), triggered (fires again).
	fired, _ := run(t, a, []day{{StatusSetup}, {StatusTriggered}, {StatusTriggered}, {StatusSetup}, {StatusTriggered}})
	if want := []Session{2, 5}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("fired on %v, want %v", fired, want)
	}
}

func TestCooldownSpacesRepeatsAndDropsATriggerInsideIt(t *testing.T) {
	// Baselined from the first session on: the first session is the state-form
	// evaluation, and every later session has a previous value to compare.
	a := Alert{Spec: triggeredEntry(3), FirstEval: FirstEvalBaseline}
	// Fires on 2 (cooldown ends on 5). A re-trigger on 5 is past the cooldown.
	fired, _ := run(t, a, []day{{StatusSetup}, {StatusTriggered}, {StatusSetup}, {StatusSetup}, {StatusTriggered}})
	if want := []Session{2, 5}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("fired on %v, want %v", fired, want)
	}

	// A trigger on 4, inside the cooldown, is dropped: it is not deferred to
	// 5, and the stock stays triggered on 5, so nothing fires there either.
	a = Alert{Spec: triggeredEntry(3), FirstEval: FirstEvalBaseline}
	fired, _ = run(t, a, []day{{StatusSetup}, {StatusTriggered}, {StatusSetup}, {StatusTriggered}, {StatusTriggered}, {StatusSetup}, {StatusTriggered}})
	if want := []Session{2, 7}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("a dropped trigger: fired on %v, want %v", fired, want)
	}
}

func TestZeroCooldownFiresOnEveryReset(t *testing.T) {
	a := Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalBaseline}
	fired, _ := run(t, a, []day{{StatusTriggered}, {StatusSetup}, {StatusTriggered}, {StatusSetup}, {StatusTriggered}})
	if want := []Session{3, 5}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("fired on %v, want %v", fired, want)
	}
}

func TestBaselineRecordsTheExistingStateWithoutEvents(t *testing.T) {
	a := Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalBaseline}
	// Already triggered on the first evaluation: recorded, not notified. Stays
	// quiet while it holds, fires after a reset and a new trigger.
	fired, _ := run(t, a, []day{{StatusTriggered}, {StatusTriggered}, {StatusSetup}, {StatusTriggered}})
	if want := []Session{4}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("baseline fired on %v, want %v", fired, want)
	}
}

func TestNotifyExistingFiresOnceWithTheExistingFlag(t *testing.T) {
	a := Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalNotifyExisting}
	state := DefaultState()
	res, err := Evaluate(a, 1, []Subject{{Key: "code:BHP", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: state}})
	if err != nil {
		t.Fatal(err)
	}
	r := res.Subjects[0]
	if !r.Emit || !r.ExistingMatch {
		t.Fatalf("first evaluation: emit %v existing %v, want both", r.Emit, r.ExistingMatch)
	}
	if !res.SetBaseline {
		t.Fatal("the first evaluation must set the baseline")
	}
}

func TestFirstEvaluationReadsTransitionsInTheirStateForm(t *testing.T) {
	// A crossing that is only a state on the first evaluation: notify-existing
	// reports the stock that sits above the line, not only one that crossed.
	spec := entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpCrossesAbove, Value: f(5)})
	a := Alert{Spec: spec, FirstEval: FirstEvalNotifyExisting}
	res, err := Evaluate(a, 1, []Subject{{
		Key: "code:BHP", Side: SideEntry,
		Current: Observation{Metrics: map[string]float64{MetricShortPct: 7}},
		// No previous session: a transition could not be read at all.
	}})
	if err != nil {
		t.Fatal(err)
	}
	if r := res.Subjects[0]; !r.Emit || !r.ExistingMatch || r.Value != True {
		t.Fatalf("state form: %+v", r)
	}
}

func TestUnknownLeavesTheStateAloneAndRecordsTheFirstSkip(t *testing.T) {
	a := Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalBaseline}
	// Setup on 1 is the baseline. Fires on 2. On 3 the feed is missing, but
	// "becomes triggered" is already False from the triggered session before
	// it (Kleene: a False part decides the section), so 3 is a re-arm, not a
	// skip. On 4 the previous value is missing too, so the first skip is 4.
	// Triggered on 5 and 6 is unknown, then False (no move); a reset on 7 and a
	// trigger on 8 fire once more.
	fired, skipped := run(t, a, []day{{StatusSetup}, {StatusTriggered}, {""}, {""}, {StatusTriggered}, {StatusTriggered}, {StatusSetup}, {StatusTriggered}})
	if want := []Session{2, 8}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("fired on %v, want %v", fired, want)
	}
	if want := []Session{4}; !reflect.DeepEqual(skipped, want) {
		t.Fatalf("skipped on %v, want only the first unknown session %v", skipped, want)
	}
}

func TestUnknownDoesNotReArmAStockThatIsDisarmed(t *testing.T) {
	// Explicit states: the stock fired on session 1 and is disarmed. On session
	// 2 it has no data. On session 3 it has data but no previous session, so
	// "becomes" is unknown. Neither unknown may re-arm, and neither may fire.
	spec := triggeredEntry(0)
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline, Baselined: true}
	st := State{Last: true, Disarmed: true}
	missing, err := Evaluate(a, 2, []Subject{{Key: "code:BHP", Side: SideEntry, State: st}})
	if err != nil {
		t.Fatal(err)
	}
	if got := missing.Subjects[0]; got.Value != Unknown || got.State != st {
		t.Fatalf("an unknown session changed the state: %+v", got)
	}
	back, err := Evaluate(a, 3, []Subject{{
		Key: "code:BHP", Side: SideEntry, State: st,
		Current: Observation{Status: StatusTriggered},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if got := back.Subjects[0]; got.Value != Unknown || got.Emit || got.State != st {
		t.Fatalf("a held trigger with no previous session fired or re-armed: %+v", got)
	}
}

func TestAlertLevelOutageWaitsAndWritesNothing(t *testing.T) {
	a := Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalBaseline, Baselined: true}
	stateA := State{Last: false, Disarmed: true}
	subjects := []Subject{
		{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: stateA},
		{Key: "code:BBB", Side: SideEntry, Current: Observation{}, State: DefaultState()},
		{Key: "code:CCC", Side: SideEntry, Current: Observation{}, State: DefaultState()},
	}
	res, err := Evaluate(a, 9, subjects)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Waiting || res.WaitingReason != WaitingReason {
		t.Fatalf("two of three without data must wait: %+v", res)
	}
	if res.SetBaseline {
		t.Fatal("a waiting alert must not set its baseline")
	}
	for _, r := range res.Subjects {
		if r.Emit || r.Skipped {
			t.Fatalf("%s: a waiting alert writes no events (emit %v skipped %v)", r.Key, r.Emit, r.Skipped)
		}
	}
	if res.Subjects[0].State != stateA {
		t.Fatalf("a waiting alert must leave the state alone: %+v", res.Subjects[0].State)
	}
}

func TestExactlyHalfWithoutDataIsNotAnOutage(t *testing.T) {
	a := Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalBaseline, Baselined: true}
	subjects := []Subject{
		{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusSetup}, State: DefaultState()},
		{Key: "code:BBB", Side: SideEntry, Current: Observation{}, State: DefaultState()},
	}
	res, err := Evaluate(a, 9, subjects)
	if err != nil {
		t.Fatal(err)
	}
	if res.Waiting {
		t.Fatal("one of two without data is half, not more than half")
	}
	if !res.Subjects[1].Skipped {
		t.Fatal("the stock without data must record its skip")
	}
}

func TestExitSideFiresOnTheStatedPositionRule(t *testing.T) {
	spec := exitOf(OpAny,
		Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
		Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
	)
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline, Baselined: true}
	pos := &Position{EntryPrice: 9, Pivot: f(10), SessionsHeld: 20}
	subject := Subject{
		Key: "entry:7", Side: SideExit, Position: pos,
		Current:  Observation{Metrics: map[string]float64{MetricClose: 10.5}},
		Previous: &Observation{Metrics: map[string]float64{MetricClose: 10.6}},
		State:    DefaultState(),
	}
	res, err := Evaluate(a, 20, []Subject{subject})
	if err != nil {
		t.Fatal(err)
	}
	r := res.Subjects[0]
	// Sessions held reaches 20 on this session, the pivot is still held.
	if !r.Emit || r.Side != SideExit {
		t.Fatalf("exit on the twentieth session: %+v", r)
	}
	if !reflect.DeepEqual(r.Conditions, []Truth{False, True}) {
		t.Fatalf("condition truths %v", r.Conditions)
	}
}

func TestTheDisabledSideIsNotEvaluated(t *testing.T) {
	spec := triggeredEntry(0)
	spec.Exit = Section{Enabled: false}
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline, Baselined: true}
	res, err := Evaluate(a, 1, []Subject{{Key: "entry:1", Side: SideExit, Position: &Position{EntryPrice: 1}, State: DefaultState()}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Subjects) != 0 {
		t.Fatalf("a disabled side produced %d results", len(res.Subjects))
	}
}

func TestEvaluateRefusesAnInvalidSpecAndAnUnknownSide(t *testing.T) {
	if _, err := Evaluate(Alert{Spec: Spec{}, FirstEval: FirstEvalBaseline}, 1, nil); err == nil {
		t.Fatal("a spec with no side enabled must be refused")
	}
	if _, err := Evaluate(Alert{Spec: triggeredEntry(0), FirstEval: "maybe"}, 1, nil); err == nil {
		t.Fatal("an unknown first_eval must be refused")
	}
	if _, err := Evaluate(Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalBaseline}, 1, []Subject{{Side: "middle"}}); err == nil {
		t.Fatal("an unknown side must be refused")
	}
}

func TestTheDefaultStateIsTheZeroValue(t *testing.T) {
	if !DefaultState().IsDefault() {
		t.Fatal("the default state must report default")
	}
	if (State{Disarmed: true}).IsDefault() {
		t.Fatal("a disarmed state must be stored")
	}
	if (State{Last: true}).IsDefault() {
		t.Fatal("a true last value must be stored")
	}
}
