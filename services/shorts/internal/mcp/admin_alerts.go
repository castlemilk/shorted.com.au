package mcp

// admin_alerts.go: the short-interest alerts smoke test, as an administrator
// drives it from Claude. Five tools, each acting on the CALLER'S OWN account:
//
//   - alerts_status (jobs:read) the alerts pipeline: monitor counts across
//     owners, the caller's own monitors, the newest evaluator runs and events.
//   - find_alert_crossing (jobs:read) the most recent report date on which a
//     stock crossed a threshold, by the evaluator's own rule.
//   - run_alerts_smoke_test (jobs:run) one end-to-end check: a daily monitor for
//     the caller, a replay of one report date for the caller only (a real email
//     goes to the caller's verified address), and the job execution's name.
//   - alerts_smoke_result (jobs:read) what that replay did: the event row on
//     that date and the execution's state.
//   - delete_alert_monitor (jobs:run) removes one of the caller's monitors.
//
// Ownership is structural, not requested: the owner id is the verified token's
// uid (tokenUserID), never a tool input. Every tool takes its scope first. The
// write path (run_alerts_smoke_test) is the same override run the picks job
// uses: the argv is built server-side (jobmonitor/alerts_replay.go).
//
// The email is never an input and never an output in full. The monitor's
// address is the caller's VERIFIED one, and the output masks it.

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

// The alerts tool names and their scopes. The smoke test is a write (it creates a
// monitor and starts a job), so it carries jobs:run like the picks tools.
const (
	AlertsStatusTool       = "alerts_status"
	FindAlertCrossingTool  = "find_alert_crossing"
	RunAlertsSmokeTool     = "run_alerts_smoke_test"
	AlertsSmokeResultTool  = "alerts_smoke_result"
	DeleteAlertMonitorTool = "delete_alert_monitor"
)

// AlertsDefaultThreshold is the smoke test's threshold when none is given.
const AlertsDefaultThreshold = 5.0

// AlertsCondition is the one condition the smoke test and the crossing finder
// support: the evaluator's short_interest_above. The evaluator has no "below"
// rule, so a below search would report crossings no alert would ever send.
const AlertsCondition = "above"

var (
	alertsCodePattern = regexp.MustCompile(`^[A-Z0-9]{1,6}$`)
	alertsDatePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// AdminAlertsOperator is the alerts half of the admin operator. Every method
// takes the caller's uid explicitly; the tools pass the verified token's uid.
type AdminAlertsOperator interface {
	AlertsStatus(ctx context.Context, userID string) (*AlertsStatusOutput, error)
	FindAlertCrossing(ctx context.Context, in FindAlertCrossingInput) (*FindAlertCrossingOutput, error)
	RunAlertsSmoke(ctx context.Context, userID, actor string, in RunAlertsSmokeInput) (*RunAlertsSmokeOutput, error)
	AlertsSmokeResult(ctx context.Context, userID string, in AlertsSmokeResultInput) (*AlertsSmokeResultOutput, error)
	DeleteOwnAlertMonitor(ctx context.Context, userID, monitorID string) error
}

// tokenUserID is the verified token's uid, the only owner the alerts tools act
// for. Empty when the request carries no verified identity.
func tokenUserID(req *sdk.CallToolRequest) string {
	if req != nil && req.Extra != nil && req.Extra.TokenInfo != nil {
		return strings.TrimSpace(req.Extra.TokenInfo.UserID)
	}
	return ""
}

func requireTokenUser(req *sdk.CallToolRequest) (string, error) {
	uid := tokenUserID(req)
	if uid == "" {
		return "", errors.New("no verified administrator identity on this connection; reconnect the Shorted admin connector")
	}
	return uid, nil
}

// MaskAlertEmail shows the first letter of the local part and the domain:
// b***@shorted.com.au. Anything without an "@" is masked entirely.
func MaskAlertEmail(email string) string {
	at := strings.LastIndex(email, "@")
	if at <= 0 {
		return "***"
	}
	return email[:1] + "***" + email[at:]
}

// --- alerts_status ----------------------------------------------------------

// AlertsStatusOutput is the alerts pipeline as an administrator sees it.
type AlertsStatusOutput struct {
	ObservedAt string                `json:"observedAt"`
	Monitors   []AlertMonitorCount   `json:"monitors" jsonschema:"Monitor counts by status and cadence, across every owner. Counts only."`
	Mine       []AlertsOwnMonitor    `json:"mine" jsonschema:"The caller's own monitors, newest first. No address or user id is returned for anyone."`
	MineTotal  int                   `json:"mineTotal"`
	Runs       []AlertsEvaluatorRun  `json:"runs" jsonschema:"The ten newest evaluator runs, newest first."`
	Events     []AlertsEvent         `json:"events" jsonschema:"The twenty newest alert events across owners, newest first. own says whether the caller owns the monitor. No address, user id or message body is returned for any owner."`
	Delivery   AlertDeliveryFeedback `json:"delivery" jsonschema:"Resend feedback across owners. Counts only."`
	Sources    []JobSource           `json:"sources"`
}

// AlertDeliveryFeedback is what Resend reported after alert emails were accepted:
// bounced or complained deliveries, and addresses now suppressed from alerts.
type AlertDeliveryFeedback struct {
	Bounced    int64 `json:"bounced"`
	Complained int64 `json:"complained"`
	Suppressed int64 `json:"suppressed"`
}

// AlertMonitorCount is one status and cadence bucket.
type AlertMonitorCount struct {
	Status  string `json:"status"`
	Cadence string `json:"cadence"`
	Count   int    `json:"count"`
}

// AlertsOwnMonitor is one of the caller's monitors.
type AlertsOwnMonitor struct {
	ID                  string   `json:"id"`
	Scope               string   `json:"scope"`
	Target              string   `json:"target"`
	Condition           string   `json:"condition"`
	Threshold           *float64 `json:"threshold,omitempty"`
	Cadence             string   `json:"cadence"`
	Status              string   `json:"status"`
	HasEmail            bool     `json:"hasEmail" jsonschema:"Whether the monitor has a verified address to send to. The address itself is never returned."`
	CreatedAt           string   `json:"createdAt"`
	LastEventReportDate string   `json:"lastEventReportDate,omitempty"`
	LastDeliveryStatus  string   `json:"lastDeliveryStatus,omitempty"`
}

// AlertsEvaluatorRun is one run of the evaluator, or of a replay.
type AlertsEvaluatorRun struct {
	ID                int64  `json:"id"`
	StartedAt         string `json:"startedAt"`
	FinishedAt        string `json:"finishedAt,omitempty"`
	Outcome           string `json:"outcome" jsonschema:"running | succeeded | degraded | failed."`
	Note              string `json:"note,omitempty" jsonschema:"What kind of run it was. A replay names its owner only when it is the caller's."`
	MonitorsEvaluated int    `json:"monitorsEvaluated"`
	EventsCreated     int    `json:"eventsCreated"`
	EmailsSent        int    `json:"emailsSent"`
	EmailsRetrying    int    `json:"emailsRetrying"`
	EmailsFailed      int    `json:"emailsFailed"`
	SkippedUnentitled int    `json:"skippedUnentitled"`
	HasCanaryResendID bool   `json:"hasCanaryResendId"`
	Error             string `json:"error,omitempty"`
}

// AlertsEvent is one alert event. Own is true only for the caller's monitors.
type AlertsEvent struct {
	ID              int64    `json:"id"`
	MonitorID       string   `json:"monitorId" jsonschema:"The monitor id. Set for the caller's own events only; blank for other owners' events."`
	Own             bool     `json:"own"`
	Target          string   `json:"target"`
	ReportDate      string   `json:"reportDate"`
	ComparedToDate  string   `json:"comparedToDate"`
	LatestPercent   *float64 `json:"latestPercent,omitempty"`
	PreviousPercent *float64 `json:"previousPercent,omitempty"`
	EmailStatus     string   `json:"emailStatus"`
	EmailAttempts   int      `json:"emailAttempts"`
	HasResendID     bool     `json:"hasResendId"`
	LastError       string   `json:"lastError,omitempty" jsonschema:"At most 200 characters. A status code or Resend error name, never an address."`
}

func alertsStatusTool() AdminTool {
	return adminScopedReadTool(ScopeJobsRead, AlertsStatusTool, "Short-interest alerts status",
		"The alerts pipeline: monitor counts across owners by status and cadence, the caller's own monitors, the ten newest evaluator "+
			"runs and the twenty newest alert events. Use it before and after run_alerts_smoke_test. Counts and runs are operator views; "+
			"other owners' monitors are never listed. For other owners' events, the monitor id and the error text are blanked, and no address or user id is ever returned.",
		nil, func(ctx context.Context, op AdminOperator, req *sdk.CallToolRequest, _ struct{}) (*AlertsStatusOutput, error) {
			uid, err := requireTokenUser(req)
			if err != nil {
				return nil, err
			}
			return op.AlertsStatus(ctx, uid)
		})
}

// --- find_alert_crossing ----------------------------------------------------

// FindAlertCrossingInput names what to search for. Every field is optional.
type FindAlertCrossingInput struct {
	Code      string   `json:"code,omitempty" jsonschema:"An ASX code to check, e.g. BHP. Omit it to search every stock whose newest reading is at or above the threshold."`
	Threshold *float64 `json:"threshold,omitempty" jsonschema:"Short-interest percent, above 0 and at most 100. Default 5."`
	Condition string   `json:"condition,omitempty" jsonschema:"Only above (the default) is supported: the evaluator's short_interest_above, an upward crossing. The evaluator has no below rule."`
}

// FindAlertCrossingOutput is the crossing found, or the reason none was.
type FindAlertCrossingOutput struct {
	Found          bool    `json:"found"`
	Code           string  `json:"code,omitempty"`
	Name           string  `json:"name,omitempty"`
	ReportDate     string  `json:"reportDate,omitempty" jsonschema:"The report date the evaluator would fire on (YYYY-MM-DD)."`
	ComparedToDate string  `json:"comparedToDate,omitempty" jsonschema:"The report the date is compared with."`
	PreviousDate   string  `json:"previousDate,omitempty" jsonschema:"The report the previous reading came from. Differs from comparedToDate only when the code was missing from that report."`
	Previous       float64 `json:"previous,omitempty"`
	Latest         float64 `json:"latest,omitempty"`
	Threshold      float64 `json:"threshold"`
	Condition      string  `json:"condition"`
	WindowFrom     string  `json:"windowFrom" jsonschema:"The oldest report date searched."`
	WindowTo       string  `json:"windowTo" jsonschema:"The newest report date searched."`
	Note           string  `json:"note,omitempty"`
}

func findAlertCrossingTool() AdminTool {
	return adminScopedReadTool(ScopeJobsRead, FindAlertCrossingTool, "Find a short-interest crossing",
		"The most recent report date on which a stock crossed a threshold upward, by the evaluator's own rule: the previous reading below the "+
			"threshold and the latest at or above it, both to two decimal places, over the last 20 report dates. Use the result as the input to "+
			"run_alerts_smoke_test. Read-only.",
		nil, func(ctx context.Context, op AdminOperator, _ *sdk.CallToolRequest, in FindAlertCrossingInput) (*FindAlertCrossingOutput, error) {
			if _, err := NormaliseAlertsSearch(in.Code, in.Threshold, in.Condition); err != nil {
				return nil, err
			}
			return op.FindAlertCrossing(ctx, in)
		})
}

// normaliseAlertsSearch validates the shared inputs of find and smoke test. It
// returns the code (upper-cased), threshold and condition with defaults applied.
func NormaliseAlertsSearch(code string, threshold *float64, condition string) (alertsSearch, error) {
	out := alertsSearch{Code: strings.ToUpper(strings.TrimSpace(code)), Threshold: AlertsDefaultThreshold, Condition: AlertsCondition}
	if out.Code != "" && !alertsCodePattern.MatchString(out.Code) {
		return alertsSearch{}, fmt.Errorf("code %q is not an ASX code", code)
	}
	if threshold != nil {
		v := *threshold
		if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 || v > 100 {
			return alertsSearch{}, errors.New("threshold must be above 0 and at most 100")
		}
		out.Threshold = v
	}
	switch c := strings.ToLower(strings.TrimSpace(condition)); c {
	case "", AlertsCondition:
	case "below":
		return alertsSearch{}, errors.New("the evaluator has no below rule: short_interest_above fires on an upward crossing only, so a below search would report crossings no alert sends. Use above")
	default:
		return alertsSearch{}, fmt.Errorf("condition %q is not supported; use above", condition)
	}
	return out, nil
}

type alertsSearch struct {
	Code      string
	Threshold float64
	Condition string
}

// --- run_alerts_smoke_test --------------------------------------------------

// RunAlertsSmokeInput is the end-to-end check's input. All fields are optional:
// with none, the most recent crossing among the stocks that cross is used.
type RunAlertsSmokeInput struct {
	Code      string   `json:"code,omitempty" jsonschema:"The ASX code to monitor and replay. Required with date."`
	Threshold *float64 `json:"threshold,omitempty" jsonschema:"Short-interest percent, above 0 and at most 100. Default 5."`
	Condition string   `json:"condition,omitempty" jsonschema:"Only above (the default)."`
	Date      string   `json:"date,omitempty" jsonschema:"A report date to replay, YYYY-MM-DD. It must be one the stock crossed on (checked here). Omit it to use the most recent crossing."`
}

// RunAlertsSmokeOutput is what the smoke test started and on what terms.
type RunAlertsSmokeOutput struct {
	MonitorID      string   `json:"monitorId"`
	MonitorState   string   `json:"monitorState" jsonschema:"created | reused: the caller's identical active monitor was already there."`
	Code           string   `json:"code"`
	Name           string   `json:"name,omitempty"`
	Date           string   `json:"date"`
	ComparedToDate string   `json:"comparedToDate"`
	PreviousDate   string   `json:"previousDate,omitempty"`
	Previous       float64  `json:"previous"`
	Latest         float64  `json:"latest"`
	Threshold      float64  `json:"threshold"`
	Condition      string   `json:"condition"`
	EmailTo        string   `json:"emailTo" jsonschema:"The caller's verified address, masked: first letter and domain only."`
	Execution      string   `json:"execution" jsonschema:"Pass to alerts_smoke_result with the monitor id and date."`
	Args           []string `json:"args" jsonschema:"The job invocation the server constructed."`
	// Also says what else the replay does: it emails any other daily monitor of the
	// caller's that crossed on Date.
	Also string `json:"also"`
	Next string `json:"next"`
}

func runAlertsSmokeTool() AdminTool {
	t := AdminTool{Name: RunAlertsSmokeTool, Scope: ScopeJobsRun}
	t.register = func(server *sdk.Server, op AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:  t.Name,
			Title: "Run the alerts smoke test",
			Description: "End-to-end check of short-interest alerts on the caller's own account. Refuses unless the caller holds an active " +
				"Premium entitlement and has a verified address. Creates (or reuses) one daily monitor for a stock that crossed a threshold, " +
				"then replays that report date for the caller only: a real alert email goes to the caller's verified address. Starts an " +
				"execution of the shorted-alerts-replay job; check alerts_smoke_result in one to two minutes. The monitor stays active " +
				"afterwards: it emails again on future crossings until it is paused (the link in the email) or deleted with delete_alert_monitor. " +
				"The replay also emails any other daily monitor of yours that crossed on the same report date, not only this one. " +
				"Refuses when the monitor already has an event for that date, because a replay would send nothing and the old row would read as this run's result.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: new(false), IdempotentHint: false, OpenWorldHint: new(true)},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in RunAlertsSmokeInput) (*sdk.CallToolResult, RunAlertsSmokeOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, RunAlertsSmokeOutput{}, nil
			}
			uid, err := requireTokenUser(req)
			if err != nil {
				return toolFailure(err), RunAlertsSmokeOutput{}, nil
			}
			search, err := NormaliseAlertsSearch(in.Code, in.Threshold, in.Condition)
			if err != nil {
				return toolFailure(err), RunAlertsSmokeOutput{}, nil
			}
			if in.Date != "" {
				if !alertsDatePattern.MatchString(in.Date) {
					return toolFailure(errors.New("date must be YYYY-MM-DD")), RunAlertsSmokeOutput{}, nil
				}
				if search.Code == "" {
					return toolFailure(errors.New("give the code with the date: the date must be one the stock crossed on")), RunAlertsSmokeOutput{}, nil
				}
				if _, err := jobmonitor.NormalizeAlertsReplayDate(in.Date, time.Now().UTC()); err != nil {
					return toolFailure(err), RunAlertsSmokeOutput{}, nil
				}
			}
			actor := adminActor(req)
			log.Infof("admin run_alerts_smoke_test: actor=%s", actor)
			ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
			defer cancel()
			out, err := op.RunAlertsSmoke(ctx, uid, actor, in)
			if err != nil {
				return toolFailure(err), RunAlertsSmokeOutput{}, nil
			}
			text := fmt.Sprintf("Smoke test started for %s (%s %g): replaying %s for your verified address %s (monitor %s, %s). Check alerts_smoke_result in one to two minutes.",
				out.Code, out.Condition, out.Threshold, out.Date, out.EmailTo, out.MonitorID, out.MonitorState)
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, *out, nil
		})
	}
	return t
}

// --- alerts_smoke_result ----------------------------------------------------

// AlertsSmokeResultInput names the monitor and date the smoke test used.
type AlertsSmokeResultInput struct {
	MonitorID string `json:"monitor_id" jsonschema:"The monitorId run_alerts_smoke_test returned. Must be one of the caller's monitors."`
	Date      string `json:"date" jsonschema:"The report date that was replayed, YYYY-MM-DD."`
	Execution string `json:"execution,omitempty" jsonschema:"The execution name run_alerts_smoke_test returned, to include the job's state."`
}

// AlertsSmokeResultOutput is what the replay did for the caller's monitor.
type AlertsSmokeResultOutput struct {
	MonitorID string             `json:"monitorId"`
	Date      string             `json:"date"`
	Events    []AlertsSmokeEvent `json:"events" jsonschema:"The event rows for this monitor on this date. Empty means the evaluator has not written one yet, or the date did not cross."`
	Replay    *AlertsReplayState `json:"replay,omitempty" jsonschema:"The execution's state, when an execution name was given."`
	Next      string             `json:"next"`
}

// AlertsSmokeEvent is one event row for the smoke test's monitor and date.
type AlertsSmokeEvent struct {
	EmailStatus   string   `json:"emailStatus" jsonschema:"pending | sending | sent | failed | skipped_unentitled | skipped_no_email | skipped_paused | awaiting_entitlement."`
	EmailAttempts int      `json:"emailAttempts"`
	HasResendID   bool     `json:"hasResendId" jsonschema:"Whether Resend accepted the message. The id itself is not returned."`
	LastError     string   `json:"lastError,omitempty"`
	Latest        *float64 `json:"latest,omitempty"`
	Previous      *float64 `json:"previous,omitempty"`
	// CreatedAt and RunID say when and by which evaluator run the row was written.
	CreatedAt string `json:"createdAt" jsonschema:"When the row was written (RFC 3339)."`
	RunID     int64  `json:"runId,omitempty" jsonschema:"The evaluator run that wrote the row, when it has one."`
	// PredatesExecution is set when an execution was given and the row was written
	// before that execution started: the row is an older run's, not this replay's.
	PredatesExecution bool `json:"predatesExecution,omitempty"`
}

// AlertsReplayState is the replay execution's state.
type AlertsReplayState struct {
	ExecutionName string `json:"executionName"`
	Status        string `json:"status" jsonschema:"running | succeeded | failed | unknown."`
	StartedAt     string `json:"startedAt,omitempty"`
	CompletedAt   string `json:"completedAt,omitempty"`
	LogURI        string `json:"logUri,omitempty"`
	Message       string `json:"message,omitempty"`
}

func alertsSmokeResultTool() AdminTool {
	return adminScopedReadTool(ScopeJobsRead, AlertsSmokeResultTool, "Check an alerts smoke test",
		"What the smoke test's replay did for one of the caller's monitors on one report date: the event row (email status, whether Resend "+
			"accepted it, any error) and, when given the execution name, the replay job's state. Read-only. A monitor that is not the caller's "+
			"reads as not found.",
		nil, func(ctx context.Context, op AdminOperator, req *sdk.CallToolRequest, in AlertsSmokeResultInput) (*AlertsSmokeResultOutput, error) {
			uid, err := requireTokenUser(req)
			if err != nil {
				return nil, err
			}
			in.MonitorID = strings.TrimSpace(in.MonitorID)
			if !isUUIDShape(in.MonitorID) {
				return nil, errors.New("monitor_id must be a monitor id")
			}
			if !alertsDatePattern.MatchString(in.Date) {
				return nil, errors.New("date must be YYYY-MM-DD")
			}
			return op.AlertsSmokeResult(ctx, uid, in)
		})
}

// --- delete_alert_monitor ---------------------------------------------------

// DeleteAlertMonitorInput names one of the caller's monitors.
type DeleteAlertMonitorInput struct {
	MonitorID string `json:"monitor_id" jsonschema:"A monitor id the caller owns. Its alert events are removed with it."`
}

// DeleteAlertMonitorOutput confirms the deletion.
type DeleteAlertMonitorOutput struct {
	MonitorID string `json:"monitorId"`
	Deleted   bool   `json:"deleted"`
}

func deleteAlertMonitorTool() AdminTool {
	t := AdminTool{Name: DeleteAlertMonitorTool, Scope: ScopeJobsRun}
	t.register = func(server *sdk.Server, op AdminOperator) {
		sdk.AddTool(server, &sdk.Tool{
			Name:        t.Name,
			Title:       "Delete one of your alert monitors",
			Description: "Delete one of the caller's own alert monitors and its events. Refused for a monitor the caller does not own. Use it to clear the monitor a smoke test created.",
			Annotations: &sdk.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: new(true), IdempotentHint: false, OpenWorldHint: new(false)},
		}, func(ctx context.Context, req *sdk.CallToolRequest, in DeleteAlertMonitorInput) (*sdk.CallToolResult, DeleteAlertMonitorOutput, error) {
			if denied := requireScope(req, t.Scope); denied != nil {
				return denied, DeleteAlertMonitorOutput{}, nil
			}
			uid, err := requireTokenUser(req)
			if err != nil {
				return toolFailure(err), DeleteAlertMonitorOutput{}, nil
			}
			in.MonitorID = strings.TrimSpace(in.MonitorID)
			if !isUUIDShape(in.MonitorID) {
				return toolFailure(errors.New("monitor_id must be a monitor id")), DeleteAlertMonitorOutput{}, nil
			}
			log.Infof("admin delete_alert_monitor: actor=%s", adminActor(req))
			if err := op.DeleteOwnAlertMonitor(ctx, uid, in.MonitorID); err != nil {
				return toolFailure(err), DeleteAlertMonitorOutput{}, nil
			}
			out := DeleteAlertMonitorOutput{MonitorID: in.MonitorID, Deleted: true}
			return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: "Deleted monitor " + in.MonitorID + "."}}}, out, nil
		})
	}
	return t
}

// isUUIDShape reports whether id has the 8-4-4-4-12 hex form the database mints
// for a monitor. Anything else cannot name one.
func isUUIDShape(id string) bool {
	return alertsUUIDPattern.MatchString(strings.TrimSpace(id))
}

var alertsUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// AlertsAdminTools is the alerts family, appended to AdminRegistry.
func alertsAdminTools() []AdminTool {
	return []AdminTool{alertsStatusTool(), findAlertCrossingTool(), runAlertsSmokeTool(), alertsSmokeResultTool(), deleteAlertMonitorTool()}
}
