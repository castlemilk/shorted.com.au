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

// runTen evaluates an entry alert over a sequence, carrying state and baseline
// as the daily job does. The stock under test is "code:BHP"; a companion that
// is always known keeps one missing day from being an outage. It returns the
// sessions that fired and the sessions that were skipped.
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
		wasBaselined := a.Baselined
		res, err := Evaluate(a, session, []Subject{
			{Key: "code:BHP", Side: SideEntry, Current: cur, Previous: prev, State: state},
			companion,
		})
		if err != nil {
			t.Fatalf("session %d: %v", session, err)
		}
		if res.Waiting {
			t.Fatalf("session %d: unexpected outage: %+v", session, res.Sides)
		}
		if res.SetBaseline {
			a.Baselined = true
		}
		r := res.Subjects[0]
		if r.ExistingMatch && wasBaselined {
			t.Fatalf("session %d: an existing-match event after the baseline", session)
		}
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

func TestAStateConditionThroughAGapFiresOnce(t *testing.T) {
	// A state operator (is at least 5) is true on 2, unknown on 3 and still
	// true on 4: the stock stays armed-off through the gap and does not fire
	// again. The reset on 5 re-arms it.
	spec := entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpIsAtLeast, Value: f(5)})
	spec.Cooldown = 0
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline}
	seq := []ten{
		{"", 4},  // 1: baseline, below
		{"", 6},  // 2: qualifies: fires
		{"", -1}, // 3: no data: the first skip, state kept
		{"", 6},  // 4: still qualifies after the gap: no fire
		{"", 4},  // 5: reset
		{"", 6},  // 6: qualifies again: fires
	}
	fired, skipped := runTen(t, a, seq)
	if want := []Session{2, 6}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("fired on %v, want %v", fired, want)
	}
	if want := []Session{3}; !reflect.DeepEqual(skipped, want) {
		t.Fatalf("skipped on %v, want %v", skipped, want)
	}
}

func TestACooldownDoesNotDeferAReQualification(t *testing.T) {
	// The stock fires on 2 and its cooldown runs to 7. It drops out on 3 and
	// re-qualifies on 4, inside the cooldown: that trigger is dropped, not
	// deferred. It then stays qualified past the cooldown's end, which is not
	// a new event (the stock never reset after 4). Only the reset on 11 and
	// the re-qualification on 12 fire again.
	spec := entryOf(OpAll, Condition{Kind: KindMetric, Metric: MetricShortPct, Op: OpIsAtLeast, Value: f(5)})
	spec.Cooldown = 5
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline}
	seq := []ten{
		{"", 4}, {"", 6}, {"", 4}, {"", 6}, {"", 6}, {"", 6},
		{"", 6}, {"", 6}, {"", 6}, {"", 6}, {"", 4}, {"", 6},
	}
	fired, skipped := runTen(t, a, seq)
	if want := []Session{2, 12}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("fired on %v, want %v", fired, want)
	}
	if len(skipped) != 0 {
		t.Fatalf("no session lacked data, skipped %v", skipped)
	}
}

// runHeld runs one tracked position on the exit side, day by day.
//
// closes holds each session's close, a negative value meaning no close that
// session. The position is held heldAtFirst sessions on the first session and
// one more each session after it. The prior session's observation is passed
// as Previous only when it had a close, which is how a halted or missing bar
// reaches the next session.
func runHeld(t *testing.T, a Alert, pos Position, heldAtFirst int, closes []float64) []Session {
	t.Helper()
	state := DefaultState()
	var prev *Observation
	var fired []Session
	for i, c := range closes {
		session := Session(i + 1)
		p := pos
		p.SessionsHeld = heldAtFirst + i
		cur := Observation{Metrics: map[string]float64{}}
		if c >= 0 {
			cur.Metrics[MetricClose] = c
		}
		res, err := Evaluate(a, session, []Subject{{Key: "entry:7", Side: SideExit, Position: &p, Current: cur, Previous: prev, State: state}})
		if err != nil {
			t.Fatalf("session %d: %v", session, err)
		}
		if res.SetBaseline {
			a.Baselined = true
		}
		r := res.Subjects[0]
		if r.Emit {
			fired = append(fired, session)
		}
		state = r.State
		if c >= 0 {
			cc := cur
			prev = &cc
		} else {
			prev = nil
		}
	}
	return fired
}

// closesAt returns n closes of 10.5 (above the pivot of 10), with the given
// sessions (1-based) replaced by the listed values.
func closesAt(n int, replace map[int]float64) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = 10.5
		if v, ok := replace[i+1]; ok {
			out[i] = v
		}
	}
	return out
}

func timeStopPosition() Position {
	return Position{EntryPrice: 9, Pivot: f(10)}
}

func TestTimeStopFiresOnTheTwentiethSessionAfterEntry(t *testing.T) {
	// The entry session is session 1 (held 0), so the twentieth session after
	// it is session 21 (held 20). The time stop reads "reaches 20".
	spec := exitOf(OpAll, Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)})
	spec.Cooldown = 0
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline, Baselined: true}
	fired := runHeld(t, a, timeStopPosition(), 0, closesAt(25, nil))
	if want := []Session{21}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("time stop fired on %v, want %v", fired, want)
	}
}

func TestTimeStopSurvivesAMissingBarAndAnOutage(t *testing.T) {
	// The exit is ANY(close crosses below the pivot, held reaches 20). Session
	// 19 has no bar (so session 20 has no previous close), and session 20 has
	// no data at all (an alert-level outage for this single position). Neither
	// may lose the time stop: it fires on 21, the twentieth session after entry.
	spec := exitOf(OpAny,
		Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
		Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
	)
	spec.Cooldown = 0
	cases := map[string]map[int]float64{
		"missing bar on 19":        {19: -1},
		"outage on 20":             {20: -1},
		"missing 19 and outage 20": {19: -1, 20: -1},
	}
	for name, replace := range cases {
		t.Run(name, func(t *testing.T) {
			a := Alert{Spec: spec, FirstEval: FirstEvalBaseline, Baselined: true}
			fired := runHeld(t, a, timeStopPosition(), 0, closesAt(25, replace))
			if want := []Session{21}; !reflect.DeepEqual(fired, want) {
				t.Fatalf("fired on %v, want %v", fired, want)
			}
		})
	}
}

func TestTimeStopInAnAllGroupFiresWhenTheGroupReads(t *testing.T) {
	// ALL(close at or under the pivot, held reaches 20). The close is above
	// the pivot until 21 and under it from 22, so the group first reads True
	// on 22, when the time stop has already passed.
	spec := exitOf(OpAll,
		Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpIsAtMost, Value: f(0)},
		Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
	)
	spec.Cooldown = 0
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline, Baselined: true}
	closes := closesAt(25, map[int]float64{22: 9.9, 23: 9.9, 24: 9.9, 25: 9.9})
	fired := runHeld(t, a, timeStopPosition(), 0, closes)
	if want := []Session{22}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("fired on %v, want %v", fired, want)
	}
}

func TestALatelyLinkedPositionReachesItsTimeStop(t *testing.T) {
	// Linked five sessions after its entry (held 5 on the first session): the
	// time stop of 10 is reached on the fifth session after linking, not never.
	spec := exitOf(OpAll, Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(10)})
	spec.Cooldown = 0
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline, Baselined: true}
	fired := runHeld(t, a, timeStopPosition(), 5, closesAt(8, nil))
	if want := []Session{6}; !reflect.DeepEqual(fired, want) {
		t.Fatalf("late link fired on %v, want %v", fired, want)
	}
}

func TestPivotlessPositionsRecordSkipsAndReachTheirTimeStop(t *testing.T) {
	// The exit is ANY(close crosses below the pivot, held reaches 20). Three
	// positions are linked on session 1: entry:1 has a pivot of 10 and closes
	// under it on session 10; entry:2 and entry:3 have no pivot. The pivot-less
	// positions are not an outage: the baseline is set on session 1, they
	// record their skip on session 1, and their time stop fires on session 21.
	spec := exitOf(OpAny,
		Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
		Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
	)
	spec.Cooldown = 0
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline}
	keys := []string{"entry:1", "entry:2", "entry:3"}
	pivots := map[string]*float64{"entry:1": f(10), "entry:2": nil, "entry:3": nil}
	state := map[string]State{}
	prev := map[string]*Observation{}
	fired := map[string][]Session{}
	skipped := map[string][]Session{}
	for day := 1; day <= 25; day++ {
		session := Session(day)
		var subs []Subject
		curs := map[string]Observation{}
		for _, k := range keys {
			// After its first exit a tracked entry is exit_signalled and the
			// caller stops evaluating it (7.4).
			if len(fired[k]) > 0 {
				continue
			}
			close := 10.5
			if k == "entry:1" && day >= 10 {
				close = 9.9
			}
			cur := Observation{Metrics: map[string]float64{MetricClose: close}}
			curs[k] = cur
			subs = append(subs, Subject{
				Key: k, Side: SideExit,
				Position: &Position{EntryPrice: 9, Pivot: pivots[k], SessionsHeld: day - 1},
				Current:  cur, Previous: prev[k], State: state[k],
			})
		}
		res, err := Evaluate(a, session, subs)
		if err != nil {
			t.Fatalf("session %d: %v", day, err)
		}
		if res.Waiting {
			t.Fatalf("session %d: pivot-less positions made the alert wait: %+v", day, res.Sides)
		}
		if res.SetBaseline {
			a.Baselined = true
		}
		for _, r := range res.Subjects {
			if r.Emit {
				fired[r.Key] = append(fired[r.Key], session)
			}
			if r.Skipped {
				skipped[r.Key] = append(skipped[r.Key], session)
			}
			state[r.Key] = r.State
			c := curs[r.Key]
			prev[r.Key] = &c
		}
	}
	wantFired := map[string][]Session{"entry:1": {10}, "entry:2": {21}, "entry:3": {21}}
	if !reflect.DeepEqual(fired, wantFired) {
		t.Fatalf("fired %v, want %v", fired, wantFired)
	}
	wantSkipped := map[string][]Session{"entry:2": {1}, "entry:3": {1}}
	if !reflect.DeepEqual(skipped, wantSkipped) {
		t.Fatalf("skipped %v, want %v", skipped, wantSkipped)
	}
}

// feed is one subject's observation on one session of a multi-subject run.
type feed struct {
	key  string
	side string
	obs  Observation
	pos  *Position
}

// runFeed evaluates an alert over n sessions with subjects supplied per
// session, carrying each subject's state and previous observation as the daily
// job does. It returns the sessions on which each key fired, and the session
// the baseline was set on (zero when it never was).
func runFeed(t *testing.T, a Alert, n int, feedAt func(Session) []feed) (fired map[string][]Session, baselineOn Session) {
	t.Helper()
	fired = map[string][]Session{}
	states := map[string]State{}
	prev := map[string]*Observation{}
	for i := 0; i < n; i++ {
		session := Session(i + 1)
		var subs []Subject
		for _, fd := range feedAt(session) {
			o := fd.obs
			subs = append(subs, Subject{Key: fd.key, Side: fd.side, Current: o, Previous: prev[fd.key], Position: fd.pos, State: stateOr(states, fd.key)})
			cur := o
			prev[fd.key] = &cur
		}
		res, err := Evaluate(a, session, subs)
		if err != nil {
			t.Fatalf("session %d: %v", session, err)
		}
		for _, r := range res.Subjects {
			states[r.Key] = r.State
			if r.Emit {
				fired[r.Key] = append(fired[r.Key], session)
			}
		}
		if res.SetBaseline {
			a.Baselined = true
			baselineOn = session
		}
	}
	return fired, baselineOn
}

func stateOr(states map[string]State, key string) State {
	if s, ok := states[key]; ok {
		return s
	}
	return DefaultState()
}

func TestTimeStopDuringAWaitingAlertIsNotLostOnceItResumes(t *testing.T) {
	// Three of four stocks read unknown on sessions 1 to 25, so the alert waits
	// and holds its position's exit with it. The stocks are known from 26, when
	// the first evaluation runs. The time stop (held 20) was reached long before,
	// so notify-existing reports it on 26 as an existing match. Baseline mode
	// records it silently, as the state the first evaluation finds.
	for _, mode := range []string{FirstEvalBaseline, FirstEvalNotifyExisting} {
		t.Run(mode, func(t *testing.T) {
			spec := exitOf(OpAny,
				Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
				Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
			)
			spec.Entry = entryOf(OpAll, Condition{Kind: KindStatus, Status: StatusTriggered, Op: OpIs}).Entry
			spec.Cooldown = 0
			a := Alert{Spec: spec, FirstEval: mode}
			fired, baselineOn := runFeed(t, a, 26, func(s Session) []feed {
				st := StatusUnknown
				if s >= 26 {
					st = StatusSetup
				}
				p := Position{EntryPrice: 9, Pivot: f(10), SessionsHeld: 5 + int(s)}
				var feeds []feed
				for _, k := range []string{"code:AAA", "code:BBB", "code:CCC"} {
					feeds = append(feeds, feed{key: k, side: SideEntry, obs: Observation{Status: st}})
				}
				return append(feeds, feed{key: "entry:7", side: SideExit, obs: Observation{Metrics: map[string]float64{MetricClose: 10.5}}, pos: &p})
			})
			want := []Session(nil)
			if mode == FirstEvalNotifyExisting {
				want = []Session{26}
			}
			if !reflect.DeepEqual(fired["entry:7"], want) {
				t.Fatalf("time stop fired on %v, want %v", fired["entry:7"], want)
			}
			if baselineOn != 26 {
				t.Fatalf("baseline set on %d, want 26", baselineOn)
			}
		})
	}
}

func TestAStaleScopeHoldsTheExitsAndSetsNoBaseline(t *testing.T) {
	// Two of four stocks have no data throughout, one has data, and the tracked
	// position closes under its pivot from session 5 and reaches its time stop
	// of 20 on session 21. With three of five subjects unknown the alert waits
	// on every session, so the exit fires nothing and the alert sets no
	// baseline.
	spec := exitOf(OpAny,
		Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
		Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
	)
	spec.Entry = entryOf(OpAll, Condition{Kind: KindStatus, Status: StatusTriggered, Op: OpIs}).Entry
	spec.Cooldown = 0
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline}
	pos := Position{EntryPrice: 9, Pivot: f(10)}
	fired, baselineOn := runFeed(t, a, 30, func(s Session) []feed {
		close := 10.5
		if s >= 5 {
			close = 9.9
		}
		p := pos
		p.SessionsHeld = int(s) - 1
		return []feed{
			{key: "code:AAA", side: SideEntry, obs: Observation{Status: StatusSetup}},
			{key: "code:BBB", side: SideEntry, obs: Observation{Status: StatusUnknown}},
			{key: "code:CCC", side: SideEntry, obs: Observation{Status: StatusUnknown}},
			{key: "code:DDD", side: SideEntry, obs: Observation{Status: StatusUnknown}},
			{key: "entry:7", side: SideExit, obs: Observation{Metrics: map[string]float64{MetricClose: close}}, pos: &p},
		}
	})
	if len(fired) != 0 {
		t.Fatalf("a waiting alert fires nothing, got %v", fired)
	}
	if baselineOn != 0 {
		t.Fatalf("a waiting alert sets no baseline, got %d", baselineOn)
	}
}

func TestAnExitReachedAsTheStockBecomesKnownFiresOnItsSessions(t *testing.T) {
	// The stock has no status until 14, so the alert (one of two subjects
	// unknown) is not waiting and is baselined on 1. The position closes under
	// its pivot on 15, a transition that fires there, and reaches its time stop
	// on 21 (held 20). Both fire once.
	spec := exitOf(OpAny,
		Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpCrossesBelow, Value: f(0)},
		Condition{Kind: KindPosition, Metric: MetricSessionsHeld, Op: OpReaches, Value: f(20)},
	)
	spec.Entry = entryOf(OpAll, Condition{Kind: KindStatus, Status: StatusTriggered, Op: OpIs}).Entry
	spec.Cooldown = 0
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline}
	fired, baselineOn := runFeed(t, a, 22, func(s Session) []feed {
		st := StatusUnknown
		if s >= 14 {
			st = StatusSetup
		}
		close := 10.5
		if s >= 15 {
			close = 9.9
		}
		p := Position{EntryPrice: 9, Pivot: f(10), SessionsHeld: int(s) - 1}
		return []feed{
			{key: "code:BHP", side: SideEntry, obs: Observation{Status: st}},
			{key: "entry:7", side: SideExit, obs: Observation{Metrics: map[string]float64{MetricClose: close}}, pos: &p},
		}
	})
	if want := []Session{15, 21}; !reflect.DeepEqual(fired["entry:7"], want) {
		t.Fatalf("exit fired on %v, want %v", fired["entry:7"], want)
	}
	if baselineOn != 1 {
		t.Fatalf("baseline set on %d, want 1", baselineOn)
	}
}

func TestAnExitUnderItsStopOnTheBaselineSessionIsRecordedSilently(t *testing.T) {
	// The stock is unknown on session 1 only. The position is already 10% under
	// its entry, so the baseline records that state without an event (the stock
	// being unknown does not make the alert wait). It fires nothing on 1 or 2.
	spec := exitOf(OpAny, Condition{Kind: KindPosition, Metric: MetricReturnSinceEntry, Op: OpIsAtMost, Value: f(-8)})
	spec.Entry = entryOf(OpAll, Condition{Kind: KindStatus, Status: StatusTriggered, Op: OpIs}).Entry
	spec.Cooldown = 0
	a := Alert{Spec: spec, FirstEval: FirstEvalBaseline}
	fired, baselineOn := runFeed(t, a, 3, func(s Session) []feed {
		st := StatusUnknown
		if s >= 2 {
			st = StatusSetup
		}
		p := Position{EntryPrice: 10}
		return []feed{
			{key: "code:BHP", side: SideEntry, obs: Observation{Status: st}},
			{key: "entry:7", side: SideExit, obs: Observation{Metrics: map[string]float64{MetricClose: 9}}, pos: &p},
		}
	})
	if len(fired) != 0 {
		t.Fatalf("the baseline records the stop without an event, fired %v", fired)
	}
	if baselineOn != 1 {
		t.Fatalf("baseline set on %d, want 1", baselineOn)
	}
}

func TestTwoPositionsWithoutACloseDoNotHoldAKnownExitOnTheBaseline(t *testing.T) {
	// Of four subjects, two positions have a pivot but no close. Two of four is
	// not more than half, so the alert is evaluated on 1 and baselined. The
	// position under its pivot is the state notify-existing reports on the first
	// evaluation, as an existing match, even beside the two with no close.
	spec := exitOf(OpAny, Condition{Kind: KindPosition, Metric: MetricCloseVsEntryPivot, Op: OpIsAtMost, Value: f(0)})
	spec.Cooldown = 0
	a := Alert{Spec: spec, FirstEval: FirstEvalNotifyExisting}
	fired, baselineOn := runFeed(t, a, 3, func(s Session) []feed {
		under := Observation{Metrics: map[string]float64{MetricClose: 9.9}}
		above := Observation{Metrics: map[string]float64{MetricClose: 10.5}}
		pivot := Position{EntryPrice: 9, Pivot: f(10)}
		return []feed{
			{key: "entry:1", side: SideExit, obs: Observation{}, pos: &pivot},
			{key: "entry:2", side: SideExit, obs: Observation{}, pos: &pivot},
			{key: "entry:3", side: SideExit, obs: under, pos: &pivot},
			{key: "entry:4", side: SideExit, obs: above, pos: &pivot},
		}
	})
	if baselineOn != 1 {
		t.Fatalf("baseline set on %d, want 1", baselineOn)
	}
	if want := []Session{1}; !reflect.DeepEqual(fired["entry:3"], want) {
		t.Fatalf("entry:3 fired on %v, want the existing match %v", fired["entry:3"], want)
	}
	if len(fired["entry:4"]) != 0 {
		t.Fatalf("the position above its pivot fires nothing, got %v", fired["entry:4"])
	}
}
