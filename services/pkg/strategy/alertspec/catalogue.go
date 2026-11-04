package alertspec

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// Condition kinds.
const (
	KindStatus   = "status"
	KindRule     = "rule"
	KindMetric   = "metric"
	KindPosition = "position"
)

// Operators. The state operators read the value on the session; the transition
// operators also need the previous session and are true only on the session
// the value moves across the line (see evaluate.go).
const (
	OpIs           = "is"
	OpBecomes      = "becomes"
	OpLeaves       = "leaves"
	OpPasses       = "passes"
	OpFails        = "fails"
	OpBecomesPass  = "becomes_pass"
	OpIsAtLeast    = "is_at_least"
	OpIsAtMost     = "is_at_most"
	OpCrossesAbove = "crosses_above"
	OpCrossesBelow = "crosses_below"
	OpReaches      = "reaches"
)

// Metric names, as a condition's Metric field spells them.
const (
	MetricShortPct          = "short_pct"
	MetricDaysToCover       = "days_to_cover"
	MetricDollarVolume20d   = "dollar_volume_20d"
	MetricClose             = "close"
	MetricCloseVsPivotPct   = "close_vs_pivot_pct"
	MetricPctOff52wHigh     = "pct_off_52w_high"
	MetricRS3mPct           = "rs_3m_pct"
	MetricRS6mPercentile    = "rs_6m_percentile"
	MetricVolumeRatio50d    = "volume_ratio_50d"
	MetricCloseVsSMA        = "close_vs_sma_pct"
	MetricCloseVsEntryPivot = "close_vs_entry_pivot_pct"
	MetricReturnSinceEntry  = "return_since_entry_pct"
	MetricSessionsHeld      = "sessions_held"
)

// SMAKey is the Observation.Metrics key of close_vs_sma_pct over n sessions.
func SMAKey(n int) string {
	return fmt.Sprintf("%s_%d", MetricCloseVsSMA, n)
}

// metricDef is one row of the catalogue. entry and exit list the operators
// allowed on each side; a nil list means the side does not take the metric.
type metricDef struct {
	kind  string
	entry []string
	exit  []string
	// valid checks the threshold; nil accepts any finite value.
	valid func(float64) bool
	// needsN marks close_vs_sma_pct, whose N must be 50 or 200.
	needsN bool
}

// stateAndCross is the operator set of a plain threshold metric.
var stateAndCross = []string{OpIsAtLeast, OpIsAtMost, OpCrossesAbove, OpCrossesBelow}

func nonNegative(v float64) bool { return v >= 0 }
func positive(v float64) bool    { return v > 0 }
func percentage(v float64) bool  { return v >= 0 && v <= 100 }

var metricDefs = map[string]metricDef{
	MetricShortPct:          {kind: KindMetric, entry: stateAndCross, valid: percentage},
	MetricDaysToCover:       {kind: KindMetric, entry: stateAndCross, valid: nonNegative},
	MetricDollarVolume20d:   {kind: KindMetric, entry: stateAndCross, valid: nonNegative},
	MetricClose:             {kind: KindMetric, entry: stateAndCross, valid: positive},
	MetricCloseVsPivotPct:   {kind: KindMetric, entry: stateAndCross},
	MetricPctOff52wHigh:     {kind: KindMetric, entry: stateAndCross},
	MetricRS3mPct:           {kind: KindMetric, entry: stateAndCross},
	MetricRS6mPercentile:    {kind: KindMetric, entry: stateAndCross, valid: percentage},
	MetricVolumeRatio50d:    {kind: KindMetric, entry: []string{OpIsAtLeast, OpCrossesAbove}, valid: nonNegative},
	MetricCloseVsSMA:        {kind: KindMetric, entry: []string{OpIsAtMost, OpCrossesBelow}, exit: []string{OpIsAtMost, OpCrossesBelow}, needsN: true},
	MetricCloseVsEntryPivot: {kind: KindPosition, exit: []string{OpIsAtMost, OpCrossesBelow}},
	MetricReturnSinceEntry:  {kind: KindPosition, exit: []string{OpIsAtMost, OpIsAtLeast}},
	MetricSessionsHeld: {kind: KindPosition, exit: []string{OpReaches}, valid: func(v float64) bool {
		return v == math.Trunc(v) && v >= 1 && v <= MaxHoldSessions
	}},
}

// statusOps and ruleOps are the operators per side for status and rule
// conditions. A status condition on the exit side is "leaves triggered" only.
var (
	statusEntryOps = []string{OpIs, OpBecomes, OpLeaves}
	statusExitOps  = []string{OpLeaves}
	ruleEntryOps   = []string{OpPasses, OpFails, OpBecomesPass}
	ruleExitOps    = []string{OpFails}
)

// Validate reports every way the spec breaks the catalogue, joined into one
// error, or nil when it is a valid alert. ruleIDs is the set of rule ids of the
// alert's pinned version; a nil set skips the rule-existence check, so the
// structure alone is checked.
func (s Spec) Validate(ruleIDs map[string]bool) error {
	var errs []error
	if s.Repeat != RepeatOncePerEvent {
		errs = append(errs, fmt.Errorf("repeat must be %q", RepeatOncePerEvent))
	}
	if s.Cooldown < 0 || s.Cooldown > MaxCooldownSessions {
		errs = append(errs, fmt.Errorf("cooldown_sessions must be between 0 and %d", MaxCooldownSessions))
	}
	if !s.Entry.Enabled && !s.Exit.Enabled {
		errs = append(errs, errors.New("enable at least one of entry and exit"))
	}
	errs = append(errs, validateSection(SideEntry, s.Entry, ruleIDs)...)
	errs = append(errs, validateSection(SideExit, s.Exit, ruleIDs)...)
	return errors.Join(errs...)
}

func validateSection(side string, sec Section, ruleIDs map[string]bool) []error {
	var errs []error
	if len(sec.Conditions) > MaxConditionsPerSection {
		errs = append(errs, fmt.Errorf("%s: at most %d conditions", side, MaxConditionsPerSection))
	}
	if !sec.Enabled {
		// A disabled side keeps its draft, so its conditions must still be well formed.
		for i, c := range sec.Conditions {
			if err := validateCondition(side, c, ruleIDs); err != nil {
				errs = append(errs, fmt.Errorf("%s.conditions[%d]: %w", side, i, err))
			}
		}
		return errs
	}
	if sec.Op != OpAll && sec.Op != OpAny {
		errs = append(errs, fmt.Errorf("%s: op must be %q or %q", side, OpAll, OpAny))
	}
	if n := len(sec.Conditions); n < 1 || n > MaxConditionsPerSection {
		errs = append(errs, fmt.Errorf("%s: an enabled side needs 1 to %d conditions", side, MaxConditionsPerSection))
	}
	for i, c := range sec.Conditions {
		if err := validateCondition(side, c, ruleIDs); err != nil {
			errs = append(errs, fmt.Errorf("%s.conditions[%d]: %w", side, i, err))
		}
	}
	return errs
}

func validateCondition(side string, c Condition, ruleIDs map[string]bool) error {
	switch c.Kind {
	case KindStatus:
		return validateStatus(side, c)
	case KindRule:
		return validateRule(side, c, ruleIDs)
	case KindMetric, KindPosition:
		return validateMetric(side, c)
	default:
		return fmt.Errorf("unknown kind %q", c.Kind)
	}
}

func validateStatus(side string, c Condition) error {
	if c.Status != StatusTriggered && c.Status != StatusSetup {
		return fmt.Errorf("status must be %q or %q", StatusTriggered, StatusSetup)
	}
	if c.RuleID != "" || c.Metric != "" || c.N != 0 || c.Value != nil {
		return errors.New("a status condition takes only status and op")
	}
	ops, allowed := statusEntryOps, true
	if side == SideExit {
		ops = statusExitOps
		allowed = c.Status == StatusTriggered
	}
	if !allowed {
		return fmt.Errorf("on the exit side a status condition is %q only", "leaves "+StatusTriggered)
	}
	return checkOp(side, c.Op, ops)
}

func validateRule(side string, c Condition, ruleIDs map[string]bool) error {
	if !validRuleID(c.RuleID) {
		return fmt.Errorf("rule_id %q is not a rule id", c.RuleID)
	}
	if ruleIDs != nil && !ruleIDs[c.RuleID] {
		return fmt.Errorf("rule %q is not a rule of the pinned version", c.RuleID)
	}
	if c.Status != "" || c.Metric != "" || c.N != 0 || c.Value != nil {
		return errors.New("a rule condition takes only rule_id and op")
	}
	ops := ruleEntryOps
	if side == SideExit {
		ops = ruleExitOps
	}
	return checkOp(side, c.Op, ops)
}

func validateMetric(side string, c Condition) error {
	def, ok := metricDefs[c.Metric]
	if !ok {
		return fmt.Errorf("unknown metric %q", c.Metric)
	}
	if c.Kind != def.kind {
		return fmt.Errorf("metric %q is kind %q, not %q", c.Metric, def.kind, c.Kind)
	}
	if c.Status != "" || c.RuleID != "" {
		return errors.New("a metric condition takes only metric, n, op and value")
	}
	if def.needsN {
		if c.N != 50 && c.N != 200 {
			return fmt.Errorf("%s needs n of 50 or 200", c.Metric)
		}
	} else if c.N != 0 {
		return fmt.Errorf("%s takes no n", c.Metric)
	}
	if c.Value == nil {
		return fmt.Errorf("%s needs a value", c.Metric)
	}
	v := *c.Value
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return fmt.Errorf("%s value must be a finite number", c.Metric)
	}
	if def.valid != nil && !def.valid(v) {
		return fmt.Errorf("%s value %v is out of range", c.Metric, v)
	}
	ops := def.entry
	if side == SideExit {
		ops = def.exit
	}
	if ops == nil {
		return fmt.Errorf("%s is not available on the %s side", c.Metric, side)
	}
	return checkOp(side, c.Op, ops)
}

func checkOp(side, op string, allowed []string) error {
	for _, a := range allowed {
		if op == a {
			return nil
		}
	}
	return fmt.Errorf("op %q is not allowed on the %s side (allowed: %s)", op, side, strings.Join(allowed, ", "))
}

// validRuleID accepts the lower-case snake_case ids the rule registry uses.
func validRuleID(id string) bool {
	if l := len(id); l < 1 || l > 40 {
		return false
	}
	for i, r := range id {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9' && i > 0:
		case r == '_' && i > 0:
		default:
			return false
		}
	}
	return true
}

// Label names a condition for a skip reason or a log line.
func (c Condition) Label() string {
	switch c.Kind {
	case KindStatus:
		return "status " + c.Status
	case KindRule:
		return "rule " + c.RuleID
	case KindMetric:
		if c.Metric == MetricCloseVsSMA {
			return fmt.Sprintf("%s %d", c.Metric, c.N)
		}
	}
	return c.Metric
}
