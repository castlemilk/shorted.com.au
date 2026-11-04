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
	// Skipped is true on the first session the subject has no usable data:
	// an in-app skipped event is written, with SkipReason.
	Skipped    bool
	SkipReason string
	// State is the state to store (the default state means delete the row).
	State State
}

// Result is the outcome of one alert on one session.
type Result struct {
	// Waiting is true when more than half of the alert's subjects have no
	// data. Nothing fires, no state changes and no skipped events are written.
	Waiting       bool
	WaitingReason string
	// SetBaseline is true when this session is the alert's first evaluated
	// session, so the caller sets baseline_as_of to it.
	SetBaseline bool
	// Subjects holds one result per subject on an enabled side, in input order.
	// Subjects on a disabled side are not evaluated and do not appear.
	Subjects []SubjectResult
}

// WaitingReason is the copy an alert shows while it waits for data.
const WaitingReason = "Waiting for data: more than half of the stocks have no data on this session"

// Evaluate runs one alert over its subjects on one session. It is a pure
// function of its inputs: the caller supplies the session ordinal, the
// observations, the tracked positions and the stored state.
//
// For each subject the section is evaluated in Kleene logic. A True value on a
// subject that was not armed or was cooling down does not fire. An unknown
// value leaves the subject's state alone, apart from recording the first
// session it went unknown. The first evaluation takes every transition
// operator in its state form, so a stock that is already in a state does not
// read as a fresh event (see evalCondition).
func Evaluate(a Alert, session Session, subjects []Subject) (Result, error) {
	if err := a.Spec.Validate(nil); err != nil {
		return Result{}, fmt.Errorf("alertspec: invalid spec: %w", err)
	}
	if a.FirstEval != FirstEvalBaseline && a.FirstEval != FirstEvalNotifyExisting {
		return Result{}, fmt.Errorf("alertspec: first_eval %q is not a mode", a.FirstEval)
	}
	firstEval := !a.Baselined

	type pending struct {
		SubjectResult
		skipReason string
	}
	var results []pending
	unknown := 0
	for _, sub := range subjects {
		sec, err := sectionOf(a.Spec, sub.Side)
		if err != nil {
			return Result{}, err
		}
		if !sec.Enabled {
			continue
		}
		conds := make([]Truth, len(sec.Conditions))
		for i, c := range sec.Conditions {
			conds[i] = evalCondition(c, &sub.Current, sub.Previous, sub.Position, firstEval)
		}
		v := combine(sec.Op, conds)
		p := pending{SubjectResult: SubjectResult{Key: sub.Key, Side: sub.Side, Value: v, Conditions: conds, State: sub.State}}
		if v == Unknown {
			unknown++
			p.skipReason = unknownReason(sec, conds)
		}
		results = append(results, p)
	}

	if n := len(results); n > 0 && 2*unknown > n {
		out := make([]SubjectResult, n)
		for i, r := range results {
			out[i] = r.SubjectResult
		}
		return Result{Waiting: true, WaitingReason: WaitingReason, Subjects: out}, nil
	}

	out := make([]SubjectResult, len(results))
	for i, p := range results {
		r := p.SubjectResult
		s := r.State
		if r.Value == Unknown {
			if s.UnavailableSince == nil {
				since := session
				s.UnavailableSince = &since
				r.Skipped = true
				r.SkipReason = p.skipReason
			}
		} else {
			s.UnavailableSince = nil
			if s.CooldownUntil != nil && session >= *s.CooldownUntil {
				s.CooldownUntil = nil
			}
			switch {
			case firstEval:
				if r.Value == True {
					if a.FirstEval == FirstEvalNotifyExisting {
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
	return Result{SetBaseline: firstEval && len(out) > 0, Subjects: out}, nil
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
//	crosses_below v -> is_at_most v    reaches N    -> is_at_least N
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

// statusIs is True or False when the status is known, Unknown otherwise.
func statusIs(o *Observation, want string) Truth {
	if o == nil || o.Status == "" {
		return Unknown
	}
	return FromBool(o.Status == want)
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
// sessions held. isPrev selects the previous session's value, where the
// sessions held is one less.
func metricValue(c Condition, o *Observation, pos *Position, isPrev bool) (float64, bool) {
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
	case MetricSessionsHeld:
		if pos == nil {
			return 0, false
		}
		n := pos.SessionsHeld
		if isPrev {
			n--
		}
		if n < 0 {
			n = 0
		}
		return float64(n), true
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
	x, okx := metricValue(c, cur, pos, false)
	cmp := func(ok bool, x float64, f func(float64) bool) Truth {
		if !ok {
			return Unknown
		}
		return FromBool(f(x))
	}
	atLeast := func(x float64) bool { return x >= v }
	atMost := func(x float64) bool { return x <= v }
	switch c.Op {
	case OpIsAtLeast:
		return cmp(okx, x, atLeast)
	case OpIsAtMost:
		return cmp(okx, x, atMost)
	case OpCrossesAbove, OpReaches:
		if stateForm {
			return cmp(okx, x, atLeast)
		}
		y, oky := metricValue(c, prev, pos, true)
		return and(cmp(oky, y, func(p float64) bool { return p < v }), cmp(okx, x, atLeast))
	case OpCrossesBelow:
		if stateForm {
			return cmp(okx, x, atMost)
		}
		y, oky := metricValue(c, prev, pos, true)
		return and(cmp(oky, y, func(p float64) bool { return p > v }), cmp(okx, x, atMost))
	}
	return Unknown
}
