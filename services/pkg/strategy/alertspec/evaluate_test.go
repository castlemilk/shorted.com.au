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
			t.Fatalf("session %d: the companion keeps the alert out of outage: %+v", session, res.Sides)
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
	// 2 it has no data, which records the first unknown session and nothing
	// else. On session 3 it has data but no previous session, so "becomes" is
	// unknown. Neither unknown may re-arm, and neither may fire. A known
	// companion keeps the entry side out of outage, so the stock's own unknown
	// is what is being read.
	a := Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalBaseline, Baselined: true}
	st := State{Last: true, Disarmed: true}
	companion := Subject{Key: "code:CMP", Side: SideEntry, Current: Observation{Status: StatusOther}, State: DefaultState()}
	two := Session(2)
	first := State{Last: true, Disarmed: true, UnavailableSince: &two}
	missing, err := Evaluate(a, 2, []Subject{{Key: "code:BHP", Side: SideEntry, State: st}, companion})
	if err != nil {
		t.Fatal(err)
	}
	if got := missing.Subjects[0]; got.Value != Unknown || got.Emit || !got.Skipped || !reflect.DeepEqual(got.State, first) {
		t.Fatalf("the first unknown session: %+v", got)
	}
	back, err := Evaluate(a, 3, []Subject{
		{Key: "code:BHP", Side: SideEntry, State: first, Current: Observation{Status: StatusTriggered}},
		companion,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := back.Subjects[0]; got.Value != Unknown || got.Emit || got.Skipped || !reflect.DeepEqual(got.State, first) {
		t.Fatalf("a held trigger with no previous session fired, re-armed or re-skipped: %+v", got)
	}
}

func TestAlertLevelOutageWaitsAndWritesNothing(t *testing.T) {
	a := Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalBaseline, Baselined: true}
	stateA := State{Last: false, Disarmed: true}
	subjects := []Subject{
		{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusTriggered}, Previous: &Observation{Status: StatusSetup}, State: stateA},
		{Key: "code:BBB", Side: SideEntry, Current: Observation{}, State: DefaultState()},
		{Key: "code:CCC", Side: SideEntry, Current: Observation{}, State: DefaultState()},
	}
	res, err := Evaluate(a, 9, subjects)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Waiting {
		t.Fatalf("two of three without data must wait: %+v", res)
	}
	if want := []SideOutage{{Side: SideEntry, Unknown: 2, Total: 3, Waiting: true}}; !reflect.DeepEqual(res.Sides, want) {
		t.Fatalf("sides %+v, want %+v", res.Sides, want)
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
	if res.Subjects[1].SkipReason == "" || res.Subjects[2].SkipReason == "" {
		t.Fatal("a waiting alert keeps each subject's reason for the missing input")
	}
}

func TestFirstEvaluationWaitingWritesNothingAndSetsNoBaseline(t *testing.T) {
	// Not yet baselined: the one waiting side holds the whole alert, so the
	// known stock is not evaluated and the next session is still a first one.
	a := Alert{Spec: triggeredEntry(0), FirstEval: FirstEvalNotifyExisting}
	stateA := DefaultState()
	subjects := []Subject{
		{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: stateA},
		{Key: "code:BBB", Side: SideEntry, Current: Observation{}, State: DefaultState()},
		{Key: "code:CCC", Side: SideEntry, Current: Observation{}, State: DefaultState()},
	}
	res, err := Evaluate(a, 1, subjects)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Waiting || res.SetBaseline {
		t.Fatalf("a first evaluation with most stocks without data waits and sets no baseline: %+v", res)
	}
	if r := res.Subjects[0]; r.Emit || r.ExistingMatch || r.State != stateA {
		t.Fatalf("a waiting first evaluation evaluated the stock: %+v", r)
	}
	// The data comes back: the same call is now the first evaluation.
	subjects[1].Current = Observation{Status: StatusSetup}
	subjects[2].Current = Observation{Status: StatusSetup}
	res, err = Evaluate(a, 2, subjects)
	if err != nil {
		t.Fatal(err)
	}
	if res.Waiting || !res.SetBaseline {
		t.Fatalf("with data for every stock the first evaluation sets the baseline: %+v", res)
	}
	if r := res.Subjects[0]; !r.Emit || !r.ExistingMatch {
		t.Fatalf("notify-existing reports the stock triggered on the first full evaluation: %+v", r)
	}
}

// mixedSpec is a tracked-entry alert: the entry side fires when the status is
// triggered, and the exit side fires when the close is at or under the pivot.
func mixedSpec() Spec {
	spec := entryOf(OpAll, Condition{Kind: KindStatus, Status: StatusTriggered, Op: OpIs})
	spec.Exit = Section{Enabled: true, Op: OpAny, Conditions: []Condition{
		{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpIsAtMost, Value: f(0)},
	}}
	spec.Cooldown = 0
	return spec
}

func TestOneSidesOutageDoesNotHoldTheOtherSide(t *testing.T) {
	a := Alert{Spec: mixedSpec(), FirstEval: FirstEvalBaseline, Baselined: true}
	belowPivot := &Position{EntryPrice: 9, Pivot: f(10), SessionsHeld: 3}

	t.Run("entry side waits, exit still fires", func(t *testing.T) {
		res, err := Evaluate(a, 9, []Subject{
			{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: DefaultState()},
			{Key: "code:BBB", Side: SideEntry, State: DefaultState()},
			{Key: "code:CCC", Side: SideEntry, State: DefaultState()},
			{Key: "entry:7", Side: SideExit, Position: belowPivot, Current: Observation{Metrics: map[string]float64{MetricClose: 9.9}}, State: DefaultState()},
		})
		if err != nil {
			t.Fatal(err)
		}
		if !res.Waiting || res.Sides[0].Waiting != true || res.Sides[1].Waiting {
			t.Fatalf("only the entry side waits: %+v", res.Sides)
		}
		if res.Subjects[0].Emit || res.Subjects[0].State != DefaultState() {
			t.Fatalf("the waiting entry side fires nothing: %+v", res.Subjects[0])
		}
		if ex := res.Subjects[3]; !ex.Emit {
			t.Fatalf("the exit side must keep watching its position: %+v", ex)
		}
	})

	t.Run("exit side waits, entry still fires", func(t *testing.T) {
		// Three tracked positions with a captured pivot and no close: a real
		// data outage on the exit side.
		noClose := &Position{EntryPrice: 9, Pivot: f(10), SessionsHeld: 3}
		res, err := Evaluate(a, 9, []Subject{
			{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: DefaultState()},
			{Key: "entry:1", Side: SideExit, Position: noClose, Current: Observation{}, State: DefaultState()},
			{Key: "entry:2", Side: SideExit, Position: noClose, Current: Observation{}, State: DefaultState()},
			{Key: "entry:3", Side: SideExit, Position: belowPivot, Current: Observation{}, State: DefaultState()},
		})
		if err != nil {
			t.Fatal(err)
		}
		if !res.Waiting || res.Sides[0].Waiting || !res.Sides[1].Waiting {
			t.Fatalf("only the exit side waits: %+v", res.Sides)
		}
		if ent := res.Subjects[0]; !ent.Emit {
			t.Fatalf("the entry side must keep firing: %+v", ent)
		}
		if ex := res.Subjects[1]; ex.Emit || ex.State != DefaultState() {
			t.Fatalf("the waiting exit side fires nothing and keeps its state: %+v", ex)
		}
	})

	t.Run("exit side waits on its own, a known position still fires", func(t *testing.T) {
		// Two of three positions have a captured pivot but no close. The third
		// has data: it is evaluated, but the side waiting holds it back.
		res, err := Evaluate(a, 9, []Subject{
			{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: DefaultState()},
			{Key: "entry:1", Side: SideExit, Position: belowPivot, Current: Observation{}, State: DefaultState()},
			{Key: "entry:2", Side: SideExit, Position: belowPivot, Current: Observation{}, State: DefaultState()},
			{Key: "entry:3", Side: SideExit, Position: belowPivot, Current: Observation{Metrics: map[string]float64{MetricClose: 9.9}}, State: DefaultState()},
		})
		if err != nil {
			t.Fatal(err)
		}
		if !res.Sides[1].Waiting {
			t.Fatalf("two of three positions without data wait: %+v", res.Sides[1])
		}
		if ex := res.Subjects[3]; ex.Emit {
			t.Fatalf("the waiting exit side fires nothing, even for a known position: %+v", ex)
		}
	})
}

func TestPivotlessPositionsAreNotAnOutage(t *testing.T) {
	// Two of three exits have no pivot, by the user's choice. The one with a
	// pivot has data, so the exit side is not an outage and is evaluated.
	a := Alert{Spec: mixedSpec(), FirstEval: FirstEvalBaseline, Baselined: true}
	noPivot := &Position{EntryPrice: 9, SessionsHeld: 3}
	res, err := Evaluate(a, 9, []Subject{
		{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusSetup}, State: DefaultState()},
		{Key: "code:BBB", Side: SideEntry, Current: Observation{Status: StatusSetup}, State: DefaultState()},
		{Key: "entry:1", Side: SideExit, Position: noPivot, Current: Observation{Metrics: map[string]float64{MetricClose: 9.9}}, State: DefaultState()},
		{Key: "entry:2", Side: SideExit, Position: noPivot, Current: Observation{Metrics: map[string]float64{MetricClose: 9.9}}, State: DefaultState()},
		{Key: "entry:3", Side: SideExit, Position: &Position{EntryPrice: 9, Pivot: f(10), SessionsHeld: 3}, Current: Observation{Metrics: map[string]float64{MetricClose: 9.9}}, State: DefaultState()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Sides[0].Waiting || res.Sides[0].Total != 2 {
		t.Fatalf("the entry side has data for every stock: %+v", res.Sides[0])
	}
	if want := (SideOutage{Side: SideExit, Unknown: 0, Total: 1, NoPivot: 2}); res.Sides[1] != want {
		t.Fatalf("exit side %+v, want %+v", res.Sides[1], want)
	}
	// Subjects are AAA, BBB, entry:1 (no pivot), entry:2 (no pivot), entry:3.
	if ex := res.Subjects[2]; ex.Emit || !ex.Skipped || ex.Value != Unknown {
		t.Fatalf("a pivot-less position records its own skip and does not fire: %+v", ex)
	}
	if ex := res.Subjects[4]; !ex.Emit || ex.Skipped {
		t.Fatalf("the position with a pivot and a close fires and is not skipped: %+v", ex)
	}
}

func TestFirstEvaluationIsGatedByTheEntrySide(t *testing.T) {
	// Notify-existing, not yet baselined. The entry side has data for every
	// stock, but one tracked position has a pivot and no close. The exit side
	// waits on its own, and the entry side still sets the baseline and fires.
	a := Alert{Spec: mixedSpec(), FirstEval: FirstEvalNotifyExisting}
	res, err := Evaluate(a, 1, []Subject{
		{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: DefaultState()},
		{Key: "code:BBB", Side: SideEntry, Current: Observation{Status: StatusSetup}, State: DefaultState()},
		{Key: "entry:1", Side: SideExit, Position: &Position{EntryPrice: 9, Pivot: f(10)}, Current: Observation{}, State: DefaultState()},
		{Key: "entry:2", Side: SideExit, Position: &Position{EntryPrice: 9}, Current: Observation{Metrics: map[string]float64{MetricClose: 9.9}}, State: DefaultState()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Sides[0].Waiting || !res.Sides[1].Waiting {
		t.Fatalf("only the exit side waits: %+v", res.Sides)
	}
	if !res.SetBaseline {
		t.Fatal("a known entry side sets the baseline beside a waiting exit side")
	}
	if ent := res.Subjects[0]; !ent.Emit || !ent.ExistingMatch {
		t.Fatalf("the entry side is evaluated on the first evaluation: %+v", ent)
	}
	if ex := res.Subjects[2]; ex.Emit || ex.State != DefaultState() {
		t.Fatalf("the waiting exit side is not evaluated on the first evaluation: %+v", ex)
	}
}

func TestKnownExitFiresBesideAWaitingEntrySide(t *testing.T) {
	// The mirror case: the entry side is mostly without data, the exit side is
	// fully known. The gate is the entry side, so only it is held: the entry
	// side writes nothing and sets no baseline, while the known exit is
	// evaluated as usual and its event fires.
	a := Alert{Spec: mixedSpec(), FirstEval: FirstEvalBaseline}
	belowPivot := &Position{EntryPrice: 9, Pivot: f(10)}
	res, err := Evaluate(a, 1, []Subject{
		{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: DefaultState()},
		{Key: "code:BBB", Side: SideEntry, Current: Observation{}, State: DefaultState()},
		{Key: "code:CCC", Side: SideEntry, Current: Observation{}, State: DefaultState()},
		{Key: "entry:1", Side: SideExit, Position: belowPivot, Current: Observation{Metrics: map[string]float64{MetricClose: 9.9}}, State: DefaultState()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Sides[0].Waiting || res.Sides[1].Waiting {
		t.Fatalf("only the entry side waits: %+v", res.Sides)
	}
	if res.SetBaseline {
		t.Fatal("a waiting entry side sets no baseline, even with a known exit side")
	}
	for _, r := range res.Subjects {
		if r.Side == SideEntry && (r.Emit || r.Skipped || r.State != DefaultState()) {
			t.Fatalf("%s: the held entry side writes nothing: %+v", r.Key, r)
		}
	}
	ex := res.Subjects[3]
	if !ex.Emit || ex.ExistingMatch || ex.State.Last != true || ex.State.Disarmed != true {
		t.Fatalf("the known exit fires and is armed off its own transition: %+v", ex)
	}
}

func TestExitOnlyAlertBaselinesFromItsExitSide(t *testing.T) {
	// With no entry side, the exit side is the gate: a fully pivot-less exit
	// set has no data outage, so the baseline is set on the first session.
	spec := exitOf(OpAny, Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)})
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline}
	res, err := Evaluate(a, 1, []Subject{
		{Key: "entry:1", Side: SideExit, Position: &Position{EntryPrice: 9}, Current: Observation{}, State: DefaultState()},
		{Key: "entry:2", Side: SideExit, Position: &Position{EntryPrice: 9}, Current: Observation{}, State: DefaultState()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Waiting || !res.SetBaseline {
		t.Fatalf("pivot-less positions are not an outage: %+v", res)
	}
	if !res.Subjects[0].Skipped {
		t.Fatalf("a pivot-less position records its own skip: %+v", res.Subjects[0])
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
	if res.Waiting || res.Sides[0].Waiting {
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
