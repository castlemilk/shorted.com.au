package shorts

// mcp_public_alerts.go: the public MCP server's alerts:write tools, behind
// mcp.AlertsWriteOperator.
//
// Every monitor rule is alertsCore (alerts_core.go), the same code the web /alerts
// API runs. What this file adds is the mapping from the tools' plain strings to the
// API's enums, and the one place the caller's verified address is read.
//
// Owner: every method takes the verified token's uid, which the mcp package reads
// from TokenInfo. Nothing here reads an owner from input.
//
// Address: create needs a verified address and refuses without one (verifiedAccountEmail,
// firebase_users.go). Resume reads the address best-effort and, if it cannot be read,
// resumes without changing it, as the web handler does for an unverified account.
// Pause and delete and the reads need no address.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// historyCompanyLimit caps the stocks shown per event.
const historyCompanyLimit = 10

// publicAlertsSource is the public alerts operator. The store and the rule are the
// server's own, so the web API and the tools share them.
type publicAlertsSource struct {
	core          alertsCore
	store         ShortsStore
	verifiedEmail func(ctx context.Context, userID string) (string, error)
}

var _ mcp.AlertsWriteOperator = (*publicAlertsSource)(nil)

// newPublicAlertsSource builds the operator for this server. Nil reader means no
// Firebase account store on this deployment: create and resume then refuse, and the
// reads and pause and delete still work.
func newPublicAlertsSource(s *ShortsServer, users firebaseUsersReader) *publicAlertsSource {
	return &publicAlertsSource{
		core:  s.alertsCore(),
		store: s.store,
		verifiedEmail: func(ctx context.Context, uid string) (string, error) {
			return verifiedAccountEmail(ctx, users, uid)
		},
	}
}

// ownMonitorView is one monitor as the tools show it: no address, no owner.
func ownMonitorView(m *shortsstore.AlertMonitor) mcp.AlertsOwnMonitor {
	row := mcp.AlertsOwnMonitor{
		ID: m.ID, Scope: m.Scope, Target: m.Target, Condition: m.Condition, Threshold: m.Threshold,
		Cadence: m.Cadence, Status: m.Status, HasEmail: m.UserEmail != "", CreatedAt: m.CreatedAt.UTC().Format(time.RFC3339),
	}
	if m.LastEventReportDate != nil {
		row.LastEventReportDate = *m.LastEventReportDate
	}
	if m.LastEventEmailStatus != nil {
		row.LastDeliveryStatus = publicDelivery(*m.LastEventEmailStatus)
	}
	return row
}

// publicDelivery is the short delivery state a tool shows. Queued states read as
// pending, as the web page shows them; no provider id or error text leaves here.
func publicDelivery(status string) string {
	switch alertDeliveryStatusFromStore(status) {
	case shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_PENDING:
		return "pending"
	case shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SENT:
		return "sent"
	case shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_FAILED:
		return "failed"
	case shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SKIPPED_UNENTITLED:
		return "skipped_unentitled"
	case shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SKIPPED_NO_EMAIL:
		return "skipped_no_email"
	case shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SKIPPED_PAUSED:
		return "skipped_paused"
	}
	return "unknown"
}

func (a *publicAlertsSource) ListMyAlerts(ctx context.Context, userID string, limit, offset int) (*mcp.ListMyAlertsOutput, error) {
	// Listing never needs the address, so it does not read it.
	monitors, total, checked, err := a.core.listMonitors(ctx, userID, "", int32(limit), int32(offset))
	if err != nil {
		return nil, err
	}
	out := &mcp.ListMyAlertsOutput{Monitors: []mcp.AlertsOwnMonitor{}, TotalCount: int(total), CheckedThroughReportDate: checked}
	for _, m := range monitors {
		out.Monitors = append(out.Monitors, ownMonitorView(m))
	}
	return out, nil
}

func (a *publicAlertsSource) CreateAlert(ctx context.Context, userID string, in mcp.CreateAlertInput) (*mcp.AlertsOwnMonitor, error) {
	msg, err := createRequestFromTool(in)
	if err != nil {
		return nil, err
	}
	email, err := a.verifiedEmail(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("an alert is emailed to your verified address, so none was created: %w", err)
	}
	monitor, err := a.core.createMonitor(ctx, userID, email, msg)
	if err != nil {
		return nil, err
	}
	row := ownMonitorView(monitor)
	return &row, nil
}

func (a *publicAlertsSource) SetAlertPaused(ctx context.Context, userID, monitorID string, paused bool) (*mcp.AlertsOwnMonitor, error) {
	var (
		status = alertevents.MonitorStatusPaused
		email  string
	)
	if !paused {
		status = alertevents.MonitorStatusActive
		// Best effort: an unreadable or unverified address leaves the stored one as it is.
		if e, err := a.verifiedEmail(ctx, userID); err == nil {
			email = e
		}
	}
	monitor, err := a.core.setMonitorStatus(ctx, userID, email, monitorID, status)
	if err != nil {
		return nil, err
	}
	row := ownMonitorView(monitor)
	return &row, nil
}

func (a *publicAlertsSource) DeleteAlert(ctx context.Context, userID, monitorID string) error {
	return a.core.deleteMonitor(ctx, userID, monitorID)
}

func (a *publicAlertsSource) AlertHistory(ctx context.Context, userID, monitorID string, limit, offset int) (*mcp.AlertHistoryOutput, error) {
	events, total, err := a.store.ListAlertEvents(userID, monitorID, int32(limit), int32(offset))
	if err != nil {
		return nil, errors.New("the alert history could not be read")
	}
	out := &mcp.AlertHistoryOutput{Events: []mcp.AlertHistoryEvent{}, TotalCount: int(total)}
	for _, e := range events {
		out.Events = append(out.Events, historyEventView(e))
	}
	return out, nil
}

// historyEventView maps one event. The payload is decoded through the shared contract;
// one that does not decode yields an event with no stocks, not a failed list.
func historyEventView(e *shortsstore.AlertEvent) mcp.AlertHistoryEvent {
	payload := alertevents.Payload{}
	if len(e.Payload) > 0 {
		_ = json.Unmarshal(e.Payload, &payload)
	}
	row := mcp.AlertHistoryEvent{
		ID: e.ID, MonitorID: e.MonitorID, Scope: e.Scope, Target: e.Target, Condition: e.Condition,
		ReportDate: e.ReportDate, ComparedToDate: e.ComparedToDate,
		Companies: []mcp.AlertHistoryCompany{}, CompaniesTotal: payload.CompaniesTotal,
		Delivery: publicDelivery(e.EmailStatus),
	}
	for i, c := range payload.Companies {
		if i >= historyCompanyLimit {
			break
		}
		row.Companies = append(row.Companies, mcp.AlertHistoryCompany{Code: c.Code, Name: c.Name, Latest: c.Latest, Previous: c.Previous})
	}
	if e.SentAt != nil {
		row.SentAt = e.SentAt.UTC().Format(time.RFC3339)
	}
	return row
}

// createRequestFromTool maps the tool's plain strings onto the API request, refusing
// an unknown value by name rather than letting the shared rule say "is required".
func createRequestFromTool(in mcp.CreateAlertInput) (*shortsv1alpha1.CreateAlertMonitorRequest, error) {
	msg := &shortsv1alpha1.CreateAlertMonitorRequest{Target: in.Target}
	switch in.Scope {
	case "industry":
		msg.Scope = shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_INDUSTRY
	case "stock":
		msg.Scope = shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK
	default:
		return nil, errors.New("scope must be industry or stock")
	}
	switch in.Condition {
	case "short_interest_above":
		msg.Condition = shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE
	case "short_interest_rises":
		msg.Condition = shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_RISES
	case "new_top_ten_entry":
		msg.Condition = shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_NEW_TOP_TEN_ENTRY
	default:
		return nil, errors.New("condition must be short_interest_above, short_interest_rises or new_top_ten_entry")
	}
	switch in.Cadence {
	case "daily":
		msg.Cadence = shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY
	case "weekly":
		msg.Cadence = shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_WEEKLY
	default:
		return nil, errors.New("cadence must be daily or weekly")
	}
	if in.Threshold != nil {
		msg.Threshold = *in.Threshold
		msg.HasThreshold = true
	}
	return msg, nil
}
