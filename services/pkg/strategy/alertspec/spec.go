// Package alertspec holds the strategy alert rule language: the condition
// catalogue, its validation, and the evaluation that decides when an alert
// fires for each stock or tracked position on a session.
//
// The package is pure. It does no I/O, reads no clock and draws no random
// numbers. Sessions are inputs: the caller passes each trading session as an
// ordinal (its position in the trading calendar), so cooldowns are counted in
// sessions and the arming state round-trips through a store unchanged. The
// daily job that runs Evaluate and the preview that reads it share this code,
// so an alert and the Signals tab agree on what a match is.
//
// Every condition resolves to True, False or Unknown (see truth.go). Unknown
// means the data was missing on the session: it never fires an alert, and an
// alert that cannot see most of its stocks waits rather than notifying.
package alertspec

import "encoding/json"

// Section names.
const (
	SideEntry = "entry"
	SideExit  = "exit"
)

// Group operators.
const (
	OpAll = "all"
	OpAny = "any"
)

// Repeat values. Only one exists in v1: a match notifies once per event.
const RepeatOncePerEvent = "once_per_event"

// First-evaluation modes, mirroring strategy_alerts.first_eval.
const (
	FirstEvalBaseline       = "baseline"
	FirstEvalNotifyExisting = "notify_existing"
)

// Limits from the product rules.
const (
	MaxConditionsPerSection = 6
	MaxCooldownSessions     = 20
	DefaultCooldownSessions = 1
	MaxHoldSessions         = 250
)

// Spec is one alert's rules. Field order and JSON names are the stored format
// of strategy_alerts.spec.
type Spec struct {
	Entry    Section `json:"entry"`
	Exit     Section `json:"exit"`
	Repeat   string  `json:"repeat"`
	Cooldown int     `json:"cooldown_sessions"`
}

// Section is one side of an alert: a group of conditions and how they combine.
type Section struct {
	Enabled    bool        `json:"enabled"`
	Op         string      `json:"op"`
	Conditions []Condition `json:"conditions"`
}

// Condition is one test on one stock (or one tracked position on the exit side).
//
// Kind is "status", "rule", "metric" or "position". Status is set for
// "status", RuleID for "rule", Metric for "metric" and "position", and N
// only for close_vs_sma_pct (50 or 200). Value is the threshold of the
// comparison operators; status and rule conditions take none.
type Condition struct {
	Kind   string   `json:"kind"`
	Status string   `json:"status,omitempty"`
	RuleID string   `json:"rule_id,omitempty"`
	Metric string   `json:"metric,omitempty"`
	N      int      `json:"n,omitempty"`
	Op     string   `json:"op"`
	Value  *float64 `json:"value,omitempty"`
}

// UnmarshalJSON applies the defaults a stored or submitted spec may omit: the
// cooldown is one session and the repeat mode is once per event. Cooldown 0 is
// a valid value, so a present zero is kept.
func (s *Spec) UnmarshalJSON(b []byte) error {
	type plain Spec
	p := plain{Cooldown: DefaultCooldownSessions, Repeat: RepeatOncePerEvent}
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*s = Spec(p)
	return nil
}

// DefaultEntry is the template every new alert starts from: the strategy's
// status becoming Triggered on a session.
func DefaultEntry() Section {
	return Section{
		Enabled: true,
		Op:      OpAll,
		Conditions: []Condition{
			{Kind: KindStatus, Status: StatusTriggered, Op: OpBecomes},
		},
	}
}

// Stock statuses a condition can read. The ladder's watch and none both read
// as StatusOther. StatusUnknown is the v1 ladder's unknown rung, which a
// condition reads as Unknown, not as a stock that is not triggered. A status
// outside this list is also Unknown.
const (
	StatusTriggered = "triggered"
	StatusSetup     = "setup"
	StatusOther     = "other"
	StatusUnknown   = "unknown"
)

// Observation is what the caller knows about one stock on one session. A zero
// Observation is a session with no data at all.
type Observation struct {
	// Status is the pinned version's ladder status on the session (see the
	// Status constants). "" and StatusUnknown are unknown.
	Status string
	// Rules holds each rule's outcome for the alert's pinned rule version,
	// keyed by rule id: True for pass, False for fail. A missing id is unknown.
	Rules map[string]Truth
	// Metrics holds the numeric values by metric name (SMAKey for the moving
	// averages). A missing or non-finite value is unknown. The position
	// metrics are derived here, from "close", and need no entry.
	Metrics map[string]float64
}

// Position is the tracked long entry an exit condition reads.
type Position struct {
	EntryPrice float64
	// Pivot is the captured pivot, or nil when none was captured. Pivot-based
	// exits are unknown without one.
	Pivot *float64
	// SessionsHeld counts the trading sessions after the entry session: 0 on
	// the entry session and N on the Nth session after it. The time stop of N
	// sessions is "sessions held reaches N", which first reads True on the Nth
	// session after the entry session, whether or not that session had data.
	SessionsHeld int
}

// Session is a trading session ordinal supplied by the caller.
type Session int

// State is the arming state of one (alert, side, subject). Its zero value is
// the default state: last value false, armed, no cooldown, available. Armed is
// stored inverted so that a zero State needs no initialisation.
type State struct {
	// Last is the section's value on the previous evaluated session.
	Last bool
	// Disarmed is set once a match has notified; it clears when the section
	// reads false again (the re-arm).
	Disarmed         bool
	CooldownUntil    *Session
	UnavailableSince *Session
}

// DefaultState is the state of a subject with no stored row.
func DefaultState() State {
	return State{}
}

// IsDefault reports whether the state equals DefaultState, in which case the
// caller deletes the stored row.
func (s State) IsDefault() bool {
	return !s.Last && !s.Disarmed && s.CooldownUntil == nil && s.UnavailableSince == nil
}
