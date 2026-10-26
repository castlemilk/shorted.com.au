package mcp

// alerts_write.go: the signed-in user's own short-interest alerts, on the PUBLIC
// /mcp server, behind the alerts:write scope.
//
// This is the one exception to the public server's read-only rule (CLAUDE.md,
// "MCP server"). The rule it relaxes exists so anonymous callers cannot change
// state; these tools keep that property by construction:
//
//   - They are NOT in Registry(). They live in AlertsWriteRegistry(), and the
//     server that lists them is a second prebuilt server, chosen per request only
//     when the request's VERIFIED token carries alerts:write (HandlerWithAlerts).
//     An anonymous request, and a token without the scope, get the base server
//     byte-for-byte, and a call to one of these tools by name is an unknown tool.
//   - The owner is the verified token's uid, read from TokenInfo. No tool takes an
//     owner field, and the schema refuses one.
//   - Every write goes through the shared alerts rule (services/shorts/internal/
//     services/shorts/alerts_core.go) that the web /alerts page uses, so validation,
//     limits and the Premium rule cannot differ between the two.
//
// The tools call the operator, never a Connect RPC, so the interceptor chain does
// not run for them. That is why the public visibility guard does not cover them;
// TestAlertsWriteToolsReachOnlyTheirOperator (alerts_write_test.go) pins that the
// tools reach nothing but the operator, by reading this file's source.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// ScopeAlertsWrite is the public scope for the signed-in user's own alerts.
const ScopeAlertsWrite = "alerts:write"

// AddressNoter is an optional extension of AlertsWriteOperator. An operator that can
// read the caller's address state returns a sentence for the list text when the address
// is not verified, and "" when it is. It is kept out of AlertsWriteOperator so existing
// operators and test fakes keep compiling and get no note.
type AddressNoter interface {
	AddressNote(ctx context.Context, userID string) string
}

// AlertsWriteOperator is the alerts rule as the public tools see it. Every method
// takes the verified owner id. The implementation applies the shared rule.
type AlertsWriteOperator interface {
	ListMyAlerts(ctx context.Context, userID string, limit, offset int) (*ListMyAlertsOutput, error)
	CreateAlert(ctx context.Context, userID string, in CreateAlertInput) (*AlertsOwnMonitor, error)
	SetAlertPaused(ctx context.Context, userID, monitorID string, paused bool) (*AlertsOwnMonitor, error)
	DeleteAlert(ctx context.Context, userID, monitorID string) error
	AlertHistory(ctx context.Context, userID, monitorID string, limit, offset int) (*AlertHistoryOutput, error)
}

// AlertsWriteTool is one alerts tool. Its scope is always ScopeAlertsWrite; it is a
// field so the registry can say so in one place.
type AlertsWriteTool struct {
	Name     string
	Scope    string
	register func(*sdk.Server, AlertsWriteOperator)
}

// AlertsWriteRegistry is every alerts tool, in published order.
func AlertsWriteRegistry() []AlertsWriteTool {
	return []AlertsWriteTool{
		listMyAlertsTool(),
		createAlertTool(),
		pauseAlertTool(),
		resumeAlertTool(),
		deleteAlertTool(),
		listMyAlertHistoryTool(),
	}
}

// registerAlertsWrite adds every alerts tool to server.
func registerAlertsWrite(server *sdk.Server, op AlertsWriteOperator) {
	for _, t := range AlertsWriteRegistry() {
		t.register(server, op)
	}
}

// hasAlertsWrite reports whether the request's verified token carries alerts:write.
// It reads TokenInfo that the bearer middleware put in the context; without a verified
// token there is none, and the answer is no.
func hasAlertsWrite(r *http.Request) bool {
	info := auth.TokenInfoFromContext(r.Context())
	return info != nil && slices.Contains(info.Scopes, ScopeAlertsWrite)
}

// alertsWriteUser is the owner of a call: the verified token's uid, and nothing else.
func alertsWriteUser(req *sdk.CallToolRequest) (string, error) {
	uid := tokenUserID(req)
	if uid == "" {
		return "", errors.New("this connection has no verified account; sign in and reconnect")
	}
	return uid, nil
}

// alertsWriteScopeCheck is the per-tool half of the scope check. The server choice
// already enforces it; this makes a tool that is reached any other way refuse too.
func alertsWriteScopeCheck(req *sdk.CallToolRequest) *sdk.CallToolResult {
	return requireScope(req, ScopeAlertsWrite)
}

// --- inputs and outputs -------------------------------------------------------

// ListMyAlertsInput pages the caller's monitors.
type ListMyAlertsInput struct {
	Limit  int `json:"limit,omitempty" jsonschema:"Monitors per page, 1 to 100. Default 20."`
	Offset int `json:"offset,omitempty" jsonschema:"Monitors to skip. Default 0."`
}

// ListMyAlertsOutput is one page of the caller's monitors, newest first.
type ListMyAlertsOutput struct {
	Monitors                 []AlertsOwnMonitor `json:"monitors"`
	TotalCount               int                `json:"totalCount"`
	CheckedThroughReportDate string             `json:"checkedThroughReportDate,omitempty" jsonschema:"The latest report date the evaluator has checked."`
}

// CreateAlertInput mirrors the create request of the web alerts API field for field.
type CreateAlertInput struct {
	Scope     string   `json:"scope" jsonschema:"industry or stock."`
	Target    string   `json:"target" jsonschema:"An ASX code for a stock alert, or an industry name as listed on Industry Intelligence."`
	Condition string   `json:"condition" jsonschema:"short_interest_above (crosses the threshold upward), short_interest_rises (rises by at least the threshold in points), or new_top_ten_entry (industry only, no threshold)."`
	Cadence   string   `json:"cadence" jsonschema:"daily or weekly."`
	Threshold *float64 `json:"threshold,omitempty" jsonschema:"Percent above 0 and at most 100. Required unless the condition is new_top_ten_entry."`
}

// AlertStateOutput is one monitor after a pause or a resume.
type AlertStateOutput struct {
	Monitor AlertsOwnMonitor `json:"monitor"`
}

// AlertIDInput names one of the caller's monitors.
type AlertIDInput struct {
	MonitorID string `json:"monitor_id" jsonschema:"The monitor id from list_my_alerts or create_alert."`
}

// DeleteAlertOutput confirms a deletion.
type DeleteAlertOutput struct {
	MonitorID string `json:"monitorId"`
	Deleted   bool   `json:"deleted"`
}

// AlertHistoryInput pages the caller's alert events, newest report first.
type AlertHistoryInput struct {
	MonitorID string `json:"monitor_id,omitempty" jsonschema:"Only this monitor's events. Omit for all of the caller's monitors."`
	Limit     int    `json:"limit,omitempty" jsonschema:"Events per page, 1 to 100. Default 20."`
	Offset    int    `json:"offset,omitempty" jsonschema:"Events to skip. Default 0."`
}

// AlertHistoryOutput is one page of events.
type AlertHistoryOutput struct {
	Events     []AlertHistoryEvent `json:"events"`
	TotalCount int                 `json:"totalCount"`
}

// AlertHistoryEvent is one alert the caller's monitor fired. Delivery is a short
// status only: no provider ids and no error text.
type AlertHistoryEvent struct {
	ID             int64                 `json:"id"`
	MonitorID      string                `json:"monitorId"`
	Scope          string                `json:"scope"`
	Target         string                `json:"target"`
	Condition      string                `json:"condition"`
	ReportDate     string                `json:"reportDate"`
	ComparedToDate string                `json:"comparedToDate"`
	Companies      []AlertHistoryCompany `json:"companies" jsonschema:"The stocks that moved, strongest first, at most ten."`
	CompaniesTotal int                   `json:"companiesTotal"`
	Delivery       string                `json:"delivery" jsonschema:"pending | sent | failed | skipped_unentitled | skipped_no_email | skipped_paused."`
	SentAt         string                `json:"sentAt,omitempty"`
}

// AlertHistoryCompany is one stock in an event.
type AlertHistoryCompany struct {
	Code     string   `json:"code"`
	Name     string   `json:"name,omitempty"`
	Latest   float64  `json:"latest"`
	Previous *float64 `json:"previous,omitempty"`
}

// --- validation -----------------------------------------------------------------

var alertIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// normaliseAlertID trims and checks a monitor id. The trimmed value is the one used.
func normaliseAlertID(in string) (string, error) {
	id := strings.TrimSpace(in)
	if !alertIDPattern.MatchString(id) {
		return "", errors.New("monitor_id must be a monitor id")
	}
	return id, nil
}

// pageArgs applies the shared list defaults: 20 per page, at most 100.
func pageArgs(limit, offset int) (int, int, error) {
	if offset < 0 {
		return 0, 0, errors.New("offset must be zero or more")
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	return limit, offset, nil
}

// --- tools -----------------------------------------------------------------------

// alertsWriteTool builds one alerts tool. Every handler has the same shape: check the
// scope, read the verified owner, validate the input, then call the operator.
func alertsWriteTool[I, O any](name, title, description string, ann *sdk.ToolAnnotations,
	run func(ctx context.Context, op AlertsWriteOperator, uid string, in I) (O, string, error),
) AlertsWriteTool {
	t := AlertsWriteTool{Name: name, Scope: ScopeAlertsWrite}
	t.register = func(server *sdk.Server, op AlertsWriteOperator) {
		sdk.AddTool(server, &sdk.Tool{Name: name, Title: title, Description: description, Annotations: ann},
			func(ctx context.Context, req *sdk.CallToolRequest, in I) (*sdk.CallToolResult, O, error) {
				var zero O
				if denied := alertsWriteScopeCheck(req); denied != nil {
					return denied, zero, nil
				}
				uid, err := alertsWriteUser(req)
				if err != nil {
					return toolFailure(err), zero, nil
				}
				out, text, err := run(ctx, op, uid, in)
				if err != nil {
					return toolFailure(err), zero, nil
				}
				return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
			})
	}
	return t
}

func readAnnotations() *sdk.ToolAnnotations {
	return &sdk.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: new(false), IdempotentHint: true, OpenWorldHint: new(false)}
}

func listMyAlertsTool() AlertsWriteTool {
	return alertsWriteTool("list_my_alerts", "List my alerts",
		"The short-interest alerts you own, newest first, with status and last delivery. Read-only.",
		readAnnotations(),
		func(ctx context.Context, op AlertsWriteOperator, uid string, in ListMyAlertsInput) (*ListMyAlertsOutput, string, error) {
			limit, offset, err := pageArgs(in.Limit, in.Offset)
			if err != nil {
				return nil, "", err
			}
			out, err := op.ListMyAlerts(ctx, uid, limit, offset)
			if err != nil {
				return nil, "", err
			}
			text := fmt.Sprintf("%d of your alerts (showing %d).", out.TotalCount, len(out.Monitors))
			if n, ok := op.(AddressNoter); ok {
				text += n.AddressNote(ctx, uid)
			}
			return out, text, nil
		})
}

func createAlertTool() AlertsWriteTool {
	return alertsWriteTool("create_alert", "Create an alert",
		"Create a short-interest alert for a stock or an industry, emailed to your verified address. Needs an active Premium subscription, "+
			"and at most 50 active alerts per account. Pause or delete it with pause_alert or delete_alert.",
		&sdk.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: new(false), IdempotentHint: false, OpenWorldHint: new(false)},
		func(ctx context.Context, op AlertsWriteOperator, uid string, in CreateAlertInput) (*AlertsOwnMonitor, string, error) {
			m, err := op.CreateAlert(ctx, uid, in)
			if err != nil {
				return nil, "", err
			}
			return m, fmt.Sprintf("Created %s alert on %s (%s, %s).", m.Cadence, m.Target, m.Condition, m.ID), nil
		})
}

func pauseAlertTool() AlertsWriteTool {
	return alertsWriteTool("pause_alert", "Pause an alert",
		"Pause one of your alerts so it stops emailing. Works without a subscription. Idempotent.",
		&sdk.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: new(false), IdempotentHint: true, OpenWorldHint: new(false)},
		func(ctx context.Context, op AlertsWriteOperator, uid string, in AlertIDInput) (*AlertStateOutput, string, error) {
			id, err := normaliseAlertID(in.MonitorID)
			if err != nil {
				return nil, "", err
			}
			m, err := op.SetAlertPaused(ctx, uid, id, true)
			if err != nil {
				return nil, "", err
			}
			return &AlertStateOutput{Monitor: *m}, "Paused alert " + m.ID + ".", nil
		})
}

func resumeAlertTool() AlertsWriteTool {
	return alertsWriteTool("resume_alert", "Resume an alert",
		"Resume one of your paused alerts. Needs an active Premium subscription. Idempotent.",
		&sdk.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: new(false), IdempotentHint: true, OpenWorldHint: new(false)},
		func(ctx context.Context, op AlertsWriteOperator, uid string, in AlertIDInput) (*AlertStateOutput, string, error) {
			id, err := normaliseAlertID(in.MonitorID)
			if err != nil {
				return nil, "", err
			}
			m, err := op.SetAlertPaused(ctx, uid, id, false)
			if err != nil {
				return nil, "", err
			}
			return &AlertStateOutput{Monitor: *m}, "Resumed alert " + m.ID + ".", nil
		})
}

func deleteAlertTool() AlertsWriteTool {
	return alertsWriteTool("delete_alert", "Delete an alert",
		"Delete one of your alerts and its history. Other accounts' alerts are never reachable. Destructive: the alert cannot be restored.",
		&sdk.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: new(true), IdempotentHint: false, OpenWorldHint: new(false)},
		func(ctx context.Context, op AlertsWriteOperator, uid string, in AlertIDInput) (*DeleteAlertOutput, string, error) {
			id, err := normaliseAlertID(in.MonitorID)
			if err != nil {
				return nil, "", err
			}
			if err := op.DeleteAlert(ctx, uid, id); err != nil {
				return nil, "", err
			}
			return &DeleteAlertOutput{MonitorID: id, Deleted: true}, "Deleted alert " + id + ".", nil
		})
}

func listMyAlertHistoryTool() AlertsWriteTool {
	return alertsWriteTool("list_my_alert_history", "Alert history",
		"Alerts your monitors fired, newest report first: the report date, the stocks that moved, and whether the email was sent. Read-only.",
		readAnnotations(),
		func(ctx context.Context, op AlertsWriteOperator, uid string, in AlertHistoryInput) (*AlertHistoryOutput, string, error) {
			monitorID := ""
			if strings.TrimSpace(in.MonitorID) != "" {
				id, err := normaliseAlertID(in.MonitorID)
				if err != nil {
					return nil, "", err
				}
				monitorID = id
			}
			limit, offset, err := pageArgs(in.Limit, in.Offset)
			if err != nil {
				return nil, "", err
			}
			out, err := op.AlertHistory(ctx, uid, monitorID, limit, offset)
			if err != nil {
				return nil, "", err
			}
			return out, fmt.Sprintf("%d alert events (showing %d).", out.TotalCount, len(out.Events)), nil
		})
}
