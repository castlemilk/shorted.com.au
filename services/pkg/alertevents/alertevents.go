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
	// StatusAwaitingEntitlement is retired. The evaluator no longer writes it: an
	// entitlement lookup that does not give a definitive answer fails the whole run
	// before anything is committed, so no event waits on a lookup. The value stays
	// in the table's CHECK list and in this package, so the migration is unchanged
	// and the API still maps it.
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
	// Stock is the detail the stock-scope email shows around the figures. It is
	// set when the evaluator enriches a stock event and is absent on older rows.
	Stock *StockDetail `json:"stock,omitempty"`
}

// StockDetail is the context an alert email shows beside one stock's figures:
// its identity, its position in the short-interest ranking, and its recent
// history. Every field is optional, so an email omits what the row lacks.
type StockDetail struct {
	Name          string   `json:"name,omitempty"`
	Industry      string   `json:"industry,omitempty"`
	LogoURL       string   `json:"logo_url,omitempty"`
	SharesShort   *float64 `json:"shares_short,omitempty"`
	SharesOnIssue *float64 `json:"shares_on_issue,omitempty"`
	// Rank is the stock's place by short percent among every code with a reading
	// on the report date, out of Ranked. 0 means not ranked.
	Rank   int `json:"rank,omitempty"`
	Ranked int `json:"ranked,omitempty"`
	// Change20 is the latest reading minus the reading 20 report dates earlier,
	// in points, when that reading exists.
	Change20 *float64 `json:"change20,omitempty"`
	// History is about six months of report dates, oldest first, at most 130.
	History []Point `json:"history,omitempty"`
}

// Point is one reading in StockDetail.History: a report date and the short
// percent to two decimal places.
type Point struct {
	D string  `json:"d"`
	P float64 `json:"p"`
}

// Company is one company an event fired on. Previous and Change are nil when the
// company has no earlier reading (a new listing, or long absent from the
// reports). Rank and PreviousRank are 1-based positions in the industry's top
// ten, and 0 means not ranked.
//
// PreviousDate is the report date the Previous reading and PreviousRank were taken
// on. It is the event's compared-to date unless the company was absent from that
// report and its last reading came from earlier in the lookback window, so a
// reader can always tell which report a figure belongs to.
type Company struct {
	Code         string   `json:"code"`
	Name         string   `json:"name"`
	Latest       float64  `json:"latest"`
	Previous     *float64 `json:"previous"`
	Change       *float64 `json:"change"`
	Rank         int      `json:"rank"`
	PreviousRank int      `json:"previous_rank"`
	PreviousDate string   `json:"previous_date,omitempty"`
	// LogoURL is the company's logo, when the metadata has one. Empty means the
	// email draws a monogram instead.
	LogoURL string `json:"logo_url,omitempty"`
}
