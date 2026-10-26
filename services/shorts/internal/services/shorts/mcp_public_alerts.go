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
	"strings"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
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
	// upgradeURL is named in the Premium refusal. It is the configured rate-limit upgrade URL
	// (RATE_LIMIT_UPGRADE_URL, default https://shorted.com.au/pricing), the same one the rate limiter
	// names to a caller at its quota.
	upgradeURL string
}

var _ mcp.AlertsWriteOperator = (*publicAlertsSource)(nil)

// newPublicAlertsSource builds the operator for this server. Nil reader means no
// Firebase account store on this deployment: create and resume then refuse, and the
// reads and pause and delete still work.
func newPublicAlertsSource(s *ShortsServer, users firebaseUsersReader) *publicAlertsSource {
	return &publicAlertsSource{
		core:       s.alertsCore(),
		store:      s.store,
		upgradeURL: upgradeURLOrDefault(s.config.RateLimitConfig.UpgradeURL),
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

// CreateAlert runs in the same order as the web create: the request's shape, then the
// Premium check, then the caller's verified address, then the monitor. An account without
// Premium never reaches the address lookup.
func (a *publicAlertsSource) CreateAlert(ctx context.Context, userID string, in mcp.CreateAlertInput) (*mcp.AlertsOwnMonitor, error) {
	msg, err := createRequestFromTool(in)
	if err != nil {
		return nil, err
	}
	if err := a.core.requirePremium(userID); err != nil {
		return nil, a.premiumRefusal(err)
	}
	email, err := a.addressFor(ctx, userID)
	if err != nil {
		return nil, err
	}
	monitor, err := a.core.createMonitor(ctx, userID, email, msg)
	if err != nil {
		return nil, a.premiumRefusal(err)
	}
	row := ownMonitorView(monitor)
	return &row, nil
}

// SetAlertPaused pauses without a subscription, and resumes with one. A resume checks
// Premium before it reads the address, like create. The address on a resume is best effort:
// an unreadable one leaves the stored address as it is, as the web handler does.
func (a *publicAlertsSource) SetAlertPaused(ctx context.Context, userID, monitorID string, paused bool) (*mcp.AlertsOwnMonitor, error) {
	var (
		status = alertevents.MonitorStatusPaused
		email  string
	)
	if !paused {
		status = alertevents.MonitorStatusActive
		if err := a.core.requirePremium(userID); err != nil {
			return nil, a.premiumRefusal(err)
		}
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

// unverifiedAlertsNote is the sentence a list response adds when the caller's address is not
// verified. It names the one thing the caller can do, and where.
const unverifiedAlertsNote = " Alerts are recorded but not emailed until your email address is verified in your Shorted account at https://shorted.com.au/alerts."

// AddressNote returns the note for a list response, or "" when the caller's address is
// verified. It uses the check create uses, so the note agrees with what a save would do. Any
// failure reads as unverified: nothing is emailed until the lookup works, so the note stays true.
func (a *publicAlertsSource) AddressNote(ctx context.Context, userID string) string {
	if _, err := a.verifiedEmail(ctx, userID); err != nil {
		return unverifiedAlertsNote
	}
	return ""
}

// addressFor reads the caller's verified address for a create. The failure the caller sees
// is the public one: it names the account, never the deployment (publicAddressError).
func (a *publicAlertsSource) addressFor(ctx context.Context, userID string) (string, error) {
	email, err := a.verifiedEmail(ctx, userID)
	if err != nil {
		return "", publicAddressError(err)
	}
	return email, nil
}

// premiumRefusal adds the upgrade URL to the Premium refusal, so the caller can act on it.
// Any other error passes through unchanged.
func (a *publicAlertsSource) premiumRefusal(err error) error {
	if err == nil || kindOf(err) != alertsKindPermission {
		return err
	}
	return fmt.Errorf("%s. Upgrade at %s", alertsNeedPremium, a.upgradeURL)
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

// defaultUpgradeURL is the pricing page, the same default the rate-limit config uses.
const defaultUpgradeURL = "https://shorted.com.au/pricing"

// upgradeURLOrDefault returns the configured upgrade URL, or the pricing page when none is set.
func upgradeURLOrDefault(configured string) string {
	if strings.TrimSpace(configured) == "" {
		return defaultUpgradeURL
	}
	return configured
}

// Public wording for an address that cannot be used. A caller reads these; they name the
// account, never the deployment, the admin path, or an internal URL. The unverified message
// names the public page where the caller fixes it, written without a scheme so the leak test
// can keep refusing any "http" in these messages.
const (
	//nolint:staticcheck // ST1005: user-facing copy, shown verbatim to the caller
	publicAddressUnverified = "Your Shorted email address isn't verified yet, so this alert was not created: alerts are emailed only to a verified address. " +
		"Open shorted.com.au/alerts?verify=1, choose \"Send verification email\", click the link in that email, then ask again to create the alert"
	//nolint:staticcheck // ST1005: user-facing copy, shown verbatim to the caller
	publicAccountService = "Couldn't reach the account service; try again shortly"
)

// publicAddressError maps a verified-address failure to the public wording, and logs the detail
// server-side. The detail may name an internal setting or an endpoint, so it stays in the log.
// The rule's own refusals (not verified, disabled, no address, no account) all read as the verify
// message, because the caller can act only on that.
func publicAddressError(err error) error {
	if err == nil {
		return nil
	}
	log.Warnf("public alerts: verified address unavailable: %v", err)
	msg := err.Error()
	switch {
	case strings.Contains(msg, "admin users") || strings.Contains(msg, "HTTP ") ||
		strings.Contains(msg, "not deployed") || strings.Contains(msg, "still rolling out") ||
		strings.Contains(msg, "web app") || strings.Contains(msg, "INTERNAL_SERVICE_SECRET"):
		return publicMessage(publicAccountService)
	default:
		return publicMessage(publicAddressUnverified)
	}
}

// publicMessage is an error whose text a public caller reads as written. It is
// a sentence, so it starts with a capital letter, which is why it is not built
// with errors.New (staticcheck ST1005 holds Go error strings to lower case).
type publicMessage string

func (m publicMessage) Error() string { return string(m) }
