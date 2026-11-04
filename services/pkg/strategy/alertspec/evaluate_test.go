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
	if want := []SideOutage{{Side: SideEntry, Unknown: 2, Total: 3}}; !reflect.DeepEqual(res.Sides, want) {
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

func TestMostOfTheAlertWithoutDataWaitsAsAWhole(t *testing.T) {
	a := Alert{Spec: mixedSpec(), FirstEval: FirstEvalBaseline, Baselined: true}
	belowPivot := &Position{EntryPrice: 9, Pivot: f(10), SessionsHeld: 3}
	noClose := &Position{EntryPrice: 9, Pivot: f(10), SessionsHeld: 3}
	closed := Observation{Metrics: map[string]float64{MetricClose: 9.9}}

	t.Run("a stale stock is outvoted by the alert's known subjects", func(t *testing.T) {
		// Two of six subjects lack data, so the alert is not waiting: the known
		// position fires and the stale stock records its own skip.
		res, err := Evaluate(a, 9, []Subject{
			{Key: "code:AAA", Side: SideEntry, State: DefaultState()},
			{Key: "code:BBB", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: DefaultState()},
			{Key: "code:CCC", Side: SideEntry, Current: Observation{Status: StatusSetup}, State: DefaultState()},
			{Key: "entry:1", Side: SideExit, Position: belowPivot, Current: closed, State: DefaultState()},
			{Key: "entry:2", Side: SideExit, Position: belowPivot, Current: closed, State: DefaultState()},
			{Key: "entry:3", Side: SideExit, Position: belowPivot, Current: closed, State: DefaultState()},
		})
		if err != nil {
			t.Fatal(err)
		}
		if res.Waiting {
			t.Fatalf("two of six without data must not wait: %+v", res.Sides)
		}
		if ex := res.Subjects[3]; !ex.Emit {
			t.Fatalf("the known position must fire: %+v", ex)
		}
		if st := res.Subjects[0]; st.Emit || !st.Skipped || st.State.UnavailableSince == nil {
			t.Fatalf("the stale stock records its skip and fires nothing: %+v", st)
		}
	})

	t.Run("most of the alert without data waits as a whole", func(t *testing.T) {
		// Three of five subjects lack data: the alert waits, so the known
		// position does not fire and nothing moves.
		known := DefaultState()
		res, err := Evaluate(a, 9, []Subject{
			{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: DefaultState()},
			{Key: "code:BBB", Side: SideEntry, State: DefaultState()},
			{Key: "code:CCC", Side: SideEntry, State: DefaultState()},
			{Key: "entry:1", Side: SideExit, Position: noClose, State: DefaultState()},
			{Key: "entry:2", Side: SideExit, Position: belowPivot, Current: closed, State: known},
		})
		if err != nil {
			t.Fatal(err)
		}
		if !res.Waiting || res.SetBaseline {
			t.Fatalf("three of five without data waits and sets no baseline: %+v", res)
		}
		for _, r := range res.Subjects {
			if r.Emit || r.Skipped {
				t.Fatalf("%s: a waiting alert writes no events (emit %v skipped %v)", r.Key, r.Emit, r.Skipped)
			}
		}
		if ex := res.Subjects[4]; ex.State != known {
			t.Fatalf("the known position keeps its state while the alert waits: %+v", ex)
		}
		if res.Subjects[1].SkipReason == "" || res.Subjects[3].SkipReason == "" {
			t.Fatal("a waiting alert keeps each subject's reason for the missing input")
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
	if res.Waiting || res.Sides[0].Unknown != 0 || res.Sides[0].Total != 2 {
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

func TestFirstEvaluationCountsBothSidesTogether(t *testing.T) {
	// Notify-existing, not yet baselined. Three of four subjects have data (the
	// position with no close is the one that lacks it), so the alert evaluates,
	// sets the baseline and reports the stock that is already triggered. The
	// pivot-less position is not counted as an outage.
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
	if res.Waiting || !res.SetBaseline {
		t.Fatalf("three of four with data evaluates and sets the baseline: %+v", res)
	}
	if want := (SideOutage{Side: SideExit, Unknown: 1, Total: 1, NoPivot: 1}); res.Sides[1] != want {
		t.Fatalf("exit side %+v, want %+v", res.Sides[1], want)
	}
	if ent := res.Subjects[0]; !ent.Emit || !ent.ExistingMatch {
		t.Fatalf("the triggered stock is reported on the first evaluation: %+v", ent)
	}
	if ex := res.Subjects[2]; ex.Emit || !ex.Skipped {
		t.Fatalf("the position without a close records its skip and fires nothing: %+v", ex)
	}
	if ex := res.Subjects[3]; ex.Emit || !ex.Skipped {
		t.Fatalf("the pivot-less position records its skip and fires nothing: %+v", ex)
	}
}

func TestBaselineRecordsAKnownExitBesideUnknownStocks(t *testing.T) {
	// Baseline mode, not yet baselined. Two of four subjects lack data, so the
	// alert is not waiting. The exit is already under its pivot: that is the
	// state the baseline records, so it fires nothing, and it is armed off.
	a := Alert{Spec: mixedSpec(), FirstEval: FirstEvalBaseline}
	res, err := Evaluate(a, 1, []Subject{
		{Key: "code:AAA", Side: SideEntry, Current: Observation{Status: StatusTriggered}, State: DefaultState()},
		{Key: "code:BBB", Side: SideEntry, State: DefaultState()},
		{Key: "code:CCC", Side: SideEntry, State: DefaultState()},
		{Key: "entry:1", Side: SideExit, Position: &Position{EntryPrice: 9, Pivot: f(10)}, Current: Observation{Metrics: map[string]float64{MetricClose: 9.9}}, State: DefaultState()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Waiting {
		t.Fatalf("two of four without data must not wait: %+v", res.Sides)
	}
	if !res.SetBaseline {
		t.Fatal("the first evaluated session sets the baseline")
	}
	for _, r := range res.Subjects {
		if r.Emit {
			t.Fatalf("%s: the baseline records existing states without events: %+v", r.Key, r)
		}
	}
	if !res.Subjects[1].Skipped || !res.Subjects[2].Skipped {
		t.Fatal("the stocks without data record their skips")
	}
	if ex := res.Subjects[3]; !ex.State.Last || !ex.State.Disarmed {
		t.Fatalf("the exit is armed off its state: %+v", ex.State)
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
	if res.Waiting || res.Sides[0].Unknown != 1 {
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

func TestPositionThresholdsCompareExactBoundaries(t *testing.T) {
	// A close exactly on the threshold reads True, as the recipe's stop-loss
	// expression (close <= entry * (1 + v/100)) does. The raw quotients are a
	// few ulps off (-7.9999999999999964, 9.999999999999986).
	cases := []struct {
		name  string
		cond  Condition
		pos   Position
		close float64
	}{
		{"-8% stop on a 6.25 entry", Condition{Kind: KindPosition, Metric: MetricReturnSinceEntry, Op: OpIsAtMost, Value: f(-8)}, Position{EntryPrice: 6.25}, 5.75},
		{"+10% on a 3.00 entry", Condition{Kind: KindPosition, Metric: MetricReturnSinceEntry, Op: OpIsAtLeast, Value: f(10)}, Position{EntryPrice: 3.00}, 3.30},
		{"-8% under a 12.50 pivot", Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpIsAtMost, Value: f(-8)}, Position{EntryPrice: 9, Pivot: f(12.50)}, 11.50},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			o := &Observation{Metrics: map[string]float64{MetricClose: c.close}}
			if got := evalCondition(c.cond, o, nil, &c.pos, false); got != True {
				t.Fatalf("close %v on %+v: got %v, want true", c.close, c.pos, got)
			}
		})
	}
}

func TestAnOutOfRangeRuleOutcomeReadsUnknown(t *testing.T) {
	// A caller that maps a rule outcome wrongly must not read as a pass: the
	// ALL group would otherwise fire an entry on it.
	spec := entryOf(OpAll, Condition{Kind: KindRule, RuleID: "breakout", Op: OpPasses})
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline, Baselined: true}
	res, err := Evaluate(a, 1, []Subject{{
		Key: "code:BHP", Side: SideEntry,
		Current: Observation{Rules: map[string]Truth{"breakout": Truth(7)}},
		State:   DefaultState(),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if r := res.Subjects[0]; r.Value != Unknown || r.Emit {
		t.Fatalf("an out-of-range outcome must read unknown and not fire: %+v", r)
	}
}
