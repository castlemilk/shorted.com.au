// Package alertevents is the contract between the shorted alerts evaluator
// (services/jobs/internal/jobs/alerts), which writes alert_events, and the
// shorts API, which reads them. The two build as separate Go modules, so the
// JSON shape and the status vocabulary live here and nowhere else. The
// migration's CHECK lists are pinned to these constants by a test next to the
// migration.
package alertevents

// Delivery states of an alert_events row (email_status).
const (
	StatusPending           = "pending"
	StatusSending           = "sending"
	StatusSent              = "sent"
	StatusFailed            = "failed"
	StatusSkippedUnentitled = "skipped_unentitled"
	StatusSkippedNoEmail    = "skipped_no_email"
	StatusSkippedPaused     = "skipped_paused"
	// StatusAwaitingEntitlement holds an event whose owner's entitlement lookup
	// failed for that owner alone. The evaluator re-checks it on each run and moves
	// it to pending or skipped_unentitled. It is never sent as it stands.
	StatusAwaitingEntitlement = "awaiting_entitlement"
)

// Statuses is every email_status the table admits.
var Statuses = []string{
	StatusPending,
	StatusSending,
	StatusSent,
	StatusFailed,
	StatusSkippedUnentitled,
	StatusSkippedNoEmail,
	StatusSkippedPaused,
	StatusAwaitingEntitlement,
}

// Monitor target types, conditions and cadences, as alert_monitors stores them.
const (
	ScopeStock                  = "stock"
	ScopeIndustry               = "industry"
	ConditionShortInterestAbove = "short_interest_above"
	ConditionShortInterestRises = "short_interest_rises"
	ConditionNewTopTenEntry     = "new_top_ten_entry"
	CadenceDaily                = "daily"
	CadenceWeekly               = "weekly"
)

// Monitor lifecycle states, as alert_monitors.status stores them.
const (
	MonitorStatusActive = "active"
	MonitorStatusPaused = "paused"
)

// Payload is alert_events.payload: the companies an event is about. The
// evaluator stores up to 50 companies and CompaniesTotal counts all of them.
// The API decodes it and the email lists up to 25.
type Payload struct {
	Companies      []Company `json:"companies"`
	CompaniesTotal int       `json:"companies_total"`
	Note           string    `json:"note,omitempty"`
}

// Company is one company an event fired on. Previous and Change are nil when the
// company has no earlier reading (a new listing, or long absent from the
// reports). Rank and PreviousRank are 1-based positions in the industry's top
// ten, and 0 means not ranked.
type Company struct {
	Code         string   `json:"code"`
	Name         string   `json:"name"`
	Latest       float64  `json:"latest"`
	Previous     *float64 `json:"previous"`
	Change       *float64 `json:"change"`
	Rank         int      `json:"rank"`
	PreviousRank int      `json:"previous_rank"`
}
