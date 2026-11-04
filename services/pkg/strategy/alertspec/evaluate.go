package alertspec

import (
	"fmt"
	"math"
)

// Alert is what Evaluate needs to know about the alert itself.
type Alert struct {
	Spec Spec
	// FirstEval is FirstEvalBaseline or FirstEvalNotifyExisting.
	FirstEval string
	// Baselined is true once the alert has been evaluated (its
	// baseline_as_of is set). Until then every transition operator is read
	// in its state form.
	Baselined bool
}

// Subject is one stock (entry side) or one tracked position (exit side) on a
// session, with its stored state.
type Subject struct {
	// Key names the subject: "code:BHP" or "entry:<tracked entry id>".
	Key     string
	Side    string // SideEntry or SideExit
	Current Observation
	// Previous is the session before Current, or nil when it is unavailable.
	// Every transition operator reads it, so a nil Previous makes it unknown.
	Previous *Observation
	// Position is the tracked entry an exit subject reads. Nil on the entry side.
	Position *Position
	State    State
}

// SubjectResult is the outcome for one subject on the session.
type SubjectResult struct {
	Key        string
	Side       string
	Value      Truth   // the section's value
	Conditions []Truth // each condition's value, in section order
	// Emit is true when an entry or exit event fires for this subject.
	Emit bool
	// ExistingMatch marks an event raised on the first evaluation of a
	// notify-existing alert, rather than a new transition.
	ExistingMatch bool
	// SkipReason is set on every subject whose section is unknown on the
	// session, including one whose side is waiting. Skipped is true only on
	// the first such session, when an in-app skipped event is written.
	Skipped    bool
	SkipReason string
	// State is the state to store (the default state means delete the row).
	State State
}

// SideOutage is how much of one enabled side has data on the session.
type SideOutage struct {
	Side string
	// Unknown counts the side's subjects whose section is unknown; Total counts
	// every subject evaluated on the side, except the pivot-less positions
	// counted in NoPivot.
	Unknown int
	Total   int
	// NoPivot counts the tracked positions with no captured pivot whose section
	// is unknown only because of that pivot. The user chose no pivot, so these
	// are not a data outage: they are skipped on their own and kept out of Total
	// and Unknown.
	NoPivot int
	// Waiting is true when more than half of the side's subjects are unknown.
	Waiting bool
}

// Result is the outcome of one alert on one session.
type Result struct {
	// Waiting is true when an enabled side has more than half of its subjects
	// without data (see Sides). A waiting side fires nothing, writes no events
	// and leaves its subjects' state alone. The other side is evaluated as
	// usual, so a stale entry universe does not hold back the exits of tracked
	// positions. On the first evaluation the baseline gate decides what waits
	// (see SetBaseline): when the gate side waits, only the gate side is held,
	// and the other side is evaluated in transition forms with normal arming,
	// so a tracked position's exit is not lost behind a stale entry universe.
	Waiting bool
	// Sides holds one entry per enabled side, entry first.
	Sides []SideOutage
	// SetBaseline is true when this session is the alert's first evaluated
	// session, so the caller sets baseline_as_of to it. The baseline is set
	// unless the gate side waits: the entry side when enabled, else the exit
	// side. A waiting exit side beside a known entry side does not hold it.
	SetBaseline bool
	// Subjects holds one result per subject on an enabled side, in input order.
	// Subjects on a disabled side are not evaluated and do not appear.
	Subjects []SubjectResult
}

// Evaluate runs one alert over its subjects on one session. It is a pure
// function of its inputs: the caller supplies the session ordinal, the
// observations, the tracked positions and the stored state.
//
// For each subject the section is evaluated in Kleene logic. A True value on a
// subject that was not armed or was cooling down does not fire. An unknown
// value leaves the subject's state alone, apart from recording the first
// session it went unknown. The first evaluation takes every transition
// operator in its state form, so a stock that is already in a state does not
// read as a fresh event (see evalCondition). The exception is an exit side
// evaluated while the entry side holds the first evaluation: it reads transition
// forms, so its events are raised as they happen.
func Evaluate(a Alert, session Session, subjects []Subject) (Result, error) {
	if err := a.Spec.Validate(nil); err != nil {
		return Result{}, fmt.Errorf("alertspec: invalid spec: %w", err)
	}
	if a.FirstEval != FirstEvalBaseline && a.FirstEval != FirstEvalNotifyExisting {
		return Result{}, fmt.Errorf("alertspec: first_eval %q is not a mode", a.FirstEval)
	}
	firstEval := !a.Baselined

	// The enabled sides, entry first, with their counts still zero.
	var template []SideOutage
	sideIdx := map[string]int{}
	for _, side := range []string{SideEntry, SideExit} {
		sec, err := sectionOf(a.Spec, side)
		if err != nil {
			return Result{}, err
		}
		if sec.Enabled {
			sideIdx[side] = len(template)
			template = append(template, SideOutage{Side: side})
		}
	}
	// The baseline gate is the entry side when it is enabled, else the exit side.
	gate := SideExit
	if _, ok := sideIdx[SideEntry]; ok {
		gate = SideEntry
	}

	type pending struct {
		SubjectResult
		skipReason string
	}
	// scan evaluates every subject on an enabled side and counts each side's
	// outage. first reports whether a side reads its first-evaluation forms.
	scan := func(first func(side string) bool) ([]pending, []SideOutage, error) {
		sides := append([]SideOutage(nil), template...)
		var results []pending
		for _, sub := range subjects {
			sec, err := sectionOf(a.Spec, sub.Side)
			if err != nil {
				return nil, nil, err
			}
			if !sec.Enabled {
				continue
			}
			conds := make([]Truth, len(sec.Conditions))
			for i, c := range sec.Conditions {
				conds[i] = evalCondition(c, &sub.Current, sub.Previous, sub.Position, first(sub.Side))
			}
			v := combine(sec.Op, conds)
			p := pending{SubjectResult: SubjectResult{Key: sub.Key, Side: sub.Side, Value: v, Conditions: conds, State: sub.State}}
			so := &sides[sideIdx[sub.Side]]
			if v == Unknown {
				p.skipReason = unknownReason(sec, conds)
			}
			if v == Unknown && noPivotOnly(sec, conds, sub.Position) {
				so.NoPivot++
			} else {
				so.Total++
				if v == Unknown {
					so.Unknown++
				}
			}
			results = append(results, p)
		}
		for i := range sides {
			sides[i].Waiting = sides[i].Total > 0 && 2*sides[i].Unknown > sides[i].Total
		}
		return results, sides, nil
	}
	// firstFor returns the first-evaluation reading per side. While the gate
	// side holds the first evaluation, only the gate side reads it: the other
	// side is evaluated as a baselined side, in transition forms.
	firstFor := func(holding bool) func(string) bool {
		return func(side string) bool { return firstEval && (!holding || side == gate) }
	}

	results, sides, err := scan(firstFor(false))
	if err != nil {
		return Result{}, err
	}
	// Only the gate side decides whether the first evaluation waits. An exit
	// side waiting on its own, beside a known entry side, does not hold it.
	holding := false
	if i, ok := sideIdx[gate]; ok && firstEval {
		holding = sides[i].Waiting
	}
	if holding {
		results, sides, err = scan(firstFor(true))
		if err != nil {
			return Result{}, err
		}
	}

	waitingAny := false
	for i := range sides {
		waitingAny = waitingAny || sides[i].Waiting
	}
	firstOf := firstFor(holding)
	frozen := func(side string) bool {
		return sides[sideIdx[side]].Waiting || (holding && side == gate)
	}

	out := make([]SubjectResult, len(results))
	for i, p := range results {
		r := p.SubjectResult
		r.SkipReason = p.skipReason
		s := r.State
		if frozen(r.Side) {
			out[i] = r
			continue
		}
		if r.Value == Unknown {
			if s.UnavailableSince == nil {
				since := session
				s.UnavailableSince = &since
				r.Skipped = true
			}
		} else {
			s.UnavailableSince = nil
			if s.CooldownUntil != nil && session >= *s.CooldownUntil {
				s.CooldownUntil = nil
			}
			switch {
			case firstOf(r.Side):
				if r.Value == True {
					// A subject that already raised its event on a session of
					// the hold is disarmed, so the baseline does not raise it again.
					if a.FirstEval == FirstEvalNotifyExisting && !s.Disarmed {
						r.Emit = true
						r.ExistingMatch = true
					}
					s.Disarmed = true
				}
			case r.Value == True && !s.Last && !s.Disarmed && s.CooldownUntil == nil:
				r.Emit = true
				s.Disarmed = true
				if a.Spec.Cooldown > 0 {
					until := session + Session(a.Spec.Cooldown)
					s.CooldownUntil = &until
				}
			}
			if r.Value == False {
				s.Disarmed = false
			}
			s.Last = r.Value == True
		}
		r.State = s
		out[i] = r
	}
	return Result{
		Waiting:     waitingAny,
		Sides:       sides,
		SetBaseline: firstEval && !holding && len(out) > 0,
		Subjects:    out,
	}, nil
}

func sectionOf(s Spec, side string) (Section, error) {
	switch side {
	case SideEntry:
		return s.Entry, nil
	case SideExit:
		return s.Exit, nil
	}
	return Section{}, fmt.Errorf("alertspec: side %q is not entry or exit", side)
}

// combine applies a section's group operator. An empty group never fires.
func combine(op string, conds []Truth) Truth {
	if len(conds) == 0 {
		return False
	}
	if op == OpAny {
		return or(conds...)
	}
	return and(conds...)
}

// unknownReason names the first condition with no data.
func unknownReason(sec Section, conds []Truth) string {
	for i, t := range conds {
		if t == Unknown {
			return "no data for " + sec.Conditions[i].Label()
		}
	}
	return "no data"
}

// evalCondition reads one condition on the session. stateForm selects the
// first-evaluation reading of a transition operator:
//
//	becomes X       -> is X            becomes_pass -> passes
//	leaves X        -> is not X        crosses_above v -> is_at_least v
//	crosses_below v -> is_at_most v
//
// reaches N is a state operator on every session (the held count is at least
// N), so it has no transition reading and needs no previous session.
//
// Otherwise a transition needs the previous session as well: it is True only
// on the session the value moves across the line, and Unknown when the
// previous value is missing.
func evalCondition(c Condition, cur, prev *Observation, pos *Position, stateForm bool) Truth {
	switch c.Kind {
	case KindStatus:
		return evalStatus(c, cur, prev, stateForm)
	case KindRule:
		return evalRule(c, cur, prev, stateForm)
	case KindMetric, KindPosition:
		return evalMetric(c, cur, prev, pos, stateForm)
	}
	return Unknown
}

// statusIs is True or False when the status is a known ladder value (triggered,
// setup, watch, none) or StatusOther. A missing status, the v1 ladder's unknown
// rung and any other value are Unknown: none of them says the stock is not
// triggered.
func statusIs(o *Observation, want string) Truth {
	if o == nil {
		return Unknown
	}
	switch o.Status {
	case StatusTriggered, StatusSetup, StatusWatch, StatusNone, StatusOther:
		return FromBool(o.Status == want)
	}
	return Unknown
}

// noPivotOnly reports whether a section's unknown is the missing pivot of a
// tracked position and nothing else: the position has no captured pivot, and
// every unknown condition reads that pivot. It is only asked of an unknown
// section, so at least one condition is unknown.
func noPivotOnly(sec Section, conds []Truth, pos *Position) bool {
	if pos == nil || pos.Pivot != nil {
		return false
	}
	for i, t := range conds {
		if t == Unknown && sec.Conditions[i].Metric != MetricCloseVsEntryPivot {
			return false
		}
	}
	return true
}

func evalStatus(c Condition, cur, prev *Observation, stateForm bool) Truth {
	switch c.Op {
	case OpIs:
		return statusIs(cur, c.Status)
	case OpBecomes:
		if stateForm {
			return statusIs(cur, c.Status)
		}
		return and(statusIs(cur, c.Status), not(statusIs(prev, c.Status)))
	case OpLeaves:
		if stateForm {
			return not(statusIs(cur, c.Status))
		}
		return and(not(statusIs(cur, c.Status)), statusIs(prev, c.Status))
	}
	return Unknown
}

// ruleAt reads a rule's pass or fail on a session. A missing id is unknown.
func ruleAt(o *Observation, id string) Truth {
	if o == nil {
		return Unknown
	}
	t, ok := o.Rules[id]
	if !ok {
		return Unknown
	}
	return t
}

func evalRule(c Condition, cur, prev *Observation, stateForm bool) Truth {
	switch c.Op {
	case OpPasses:
		return ruleAt(cur, c.RuleID)
	case OpFails:
		return not(ruleAt(cur, c.RuleID))
	case OpBecomesPass:
		if stateForm {
			return ruleAt(cur, c.RuleID)
		}
		return and(ruleAt(cur, c.RuleID), not(ruleAt(prev, c.RuleID)))
	}
	return Unknown
}

// finiteMetric reads a stored metric, treating a missing or non-finite value as unknown.
func finiteMetric(o *Observation, key string) (float64, bool) {
	v, ok := o.Metrics[key]
	if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// metricValue reads a condition's value on one session. The position metrics
// are derived from the close and the tracked entry: the return since entry, the
// close against the captured pivot in percent (0 is the pivot), and the
// sessions held. The held count is a fact of the position, so it reads no
// market data and needs no observation.
func metricValue(c Condition, o *Observation, pos *Position) (float64, bool) {
	if c.Metric == MetricSessionsHeld {
		if pos == nil {
			return 0, false
		}
		return float64(pos.SessionsHeld), true
	}
	if o == nil {
		return 0, false
	}
	switch c.Metric {
	case MetricCloseVsEntryPivot:
		if pos == nil || pos.Pivot == nil || *pos.Pivot <= 0 {
			return 0, false
		}
		cl, ok := finiteMetric(o, MetricClose)
		if !ok {
			return 0, false
		}
		return (cl / *pos.Pivot - 1) * 100, true
	case MetricReturnSinceEntry:
		if pos == nil || pos.EntryPrice <= 0 {
			return 0, false
		}
		cl, ok := finiteMetric(o, MetricClose)
		if !ok {
			return 0, false
		}
		return (cl/pos.EntryPrice - 1) * 100, true
	}
	key := c.Metric
	if c.Metric == MetricCloseVsSMA {
		key = SMAKey(c.N)
	}
	return finiteMetric(o, key)
}

func evalMetric(c Condition, cur, prev *Observation, pos *Position, stateForm bool) Truth {
	if c.Value == nil {
		return Unknown
	}
	v := *c.Value
	x, okx := metricValue(c, cur, pos)
	cmp := func(ok bool, x float64, f func(float64) bool) Truth {
		if !ok {
			return Unknown
		}
		return FromBool(f(x))
	}
	atLeast := func(x float64) bool { return x >= v }
	atMost := func(x float64) bool { return x <= v }
	switch c.Op {
	case OpIsAtLeast, OpReaches:
		return cmp(okx, x, atLeast)
	case OpIsAtMost:
		return cmp(okx, x, atMost)
	case OpCrossesAbove:
		if stateForm {
			return cmp(okx, x, atLeast)
		}
		y, oky := metricValue(c, prev, pos)
		return and(cmp(oky, y, func(p float64) bool { return p < v }), cmp(okx, x, atLeast))
	case OpCrossesBelow:
		if stateForm {
			return cmp(okx, x, atMost)
		}
		y, oky := metricValue(c, prev, pos)
		return and(cmp(oky, y, func(p float64) bool { return p > v }), cmp(okx, x, atMost))
	}
	return Unknown
}
