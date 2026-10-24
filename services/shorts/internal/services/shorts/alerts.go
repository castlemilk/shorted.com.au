package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// alertsNeedPremium is the message for every refusal that is about entitlement.
const alertsNeedPremium = "alerts require an active Premium subscription"

// CreateAlertMonitor saves a premium short-interest monitor for the current user.
func (s *ShortsServer) CreateAlertMonitor(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.CreateAlertMonitorRequest],
) (*connect.Response[shortsv1alpha1.CreateAlertMonitorResponse], error) {
	userClaims, ok := UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("user not authenticated"))
	}
	// Alerts follow the same entitlement rule as the rate-limit tier and the
	// subscription RPC, read from the store rather than from the claims, so a
	// stale or missing tier on the claims cannot decide it.
	_, ent, err := s.loadEntitlement(userClaims.UserID, time.Now())
	if err != nil {
		s.logger.Errorf("failed to check subscription for user %s: %v", userClaims.UserID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check subscription"))
	}
	if !ent.Entitled {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New(alertsNeedPremium))
	}

	input, err := validateCreateAlertMonitor(userClaims, req.Msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	// A target the evaluator can never match saves a monitor that silently never
	// fires. Refuse it here, and store an industry under its canonical spelling so
	// that "materials" and "Materials" are one monitor.
	switch input.Scope {
	case "industry":
		canonical, found, err := s.store.CanonicalIndustry(input.Target)
		if err != nil {
			s.logger.Errorf("failed to resolve industry %q: %v", input.Target, err)
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check industry"))
		}
		if !found {
			return nil, connect.NewError(connect.CodeInvalidArgument, errUnknownIndustry)
		}
		input.Target = canonical
	case "stock":
		known, err := s.store.StockCodeKnown(input.Target)
		if err != nil {
			s.logger.Errorf("failed to check stock code %q: %v", input.Target, err)
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check stock code"))
		}
		if !known {
			return nil, connect.NewError(connect.CodeInvalidArgument, errUnknownASXCode)
		}
	}

	monitor, err := s.store.CreateAlertMonitor(input)
	if err != nil {
		if errors.Is(err, shortsstore.ErrAlertMonitorExists) {
			return nil, connect.NewError(connect.CodeAlreadyExists, fmt.Errorf("monitor already exists"))
		}
		s.logger.Errorf("failed to create alert monitor for user %s: %v", userClaims.UserID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to save monitor"))
	}

	return connect.NewResponse(&shortsv1alpha1.CreateAlertMonitorResponse{
		Monitor: alertMonitorToProto(monitor),
	}), nil
}

// ListAlertMonitors returns the current user's short-interest monitors, each with
// its newest alert event, and the latest report the evaluator has checked.
func (s *ShortsServer) ListAlertMonitors(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListAlertMonitorsRequest],
) (*connect.Response[shortsv1alpha1.ListAlertMonitorsResponse], error) {
	userClaims, ok := UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("user not authenticated"))
	}

	limit := clampAlertLimit(req.Msg.Limit)
	offset := req.Msg.Offset
	if offset < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("offset must be non-negative"))
	}

	monitors, total, err := s.store.ListAlertMonitors(userClaims.UserID, limit, offset)
	if err != nil {
		s.logger.Errorf("failed to list alert monitors for user %s: %v", userClaims.UserID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load monitors"))
	}
	checked, err := s.store.AlertCheckedThrough()
	if err != nil {
		s.logger.Errorf("failed to read alert evaluator state: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load monitors"))
	}

	resp := &shortsv1alpha1.ListAlertMonitorsResponse{
		Monitors:                 make([]*shortsv1alpha1.AlertMonitor, 0, len(monitors)),
		TotalCount:               total,
		CheckedThroughReportDate: checked,
	}
	for _, monitor := range monitors {
		resp.Monitors = append(resp.Monitors, alertMonitorToProto(monitor))
	}

	return connect.NewResponse(resp), nil
}

// ListAlertEvents returns the current user's alert events, newest report first.
func (s *ShortsServer) ListAlertEvents(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListAlertEventsRequest],
) (*connect.Response[shortsv1alpha1.ListAlertEventsResponse], error) {
	userClaims, ok := UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("user not authenticated"))
	}

	limit := clampAlertLimit(req.Msg.Limit)
	offset := req.Msg.Offset
	if offset < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("offset must be non-negative"))
	}
	monitorID := strings.TrimSpace(req.Msg.MonitorId)
	if monitorID != "" && !isAlertMonitorID(monitorID) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid monitor id"))
	}

	events, total, err := s.store.ListAlertEvents(userClaims.UserID, monitorID, limit, offset)
	if err != nil {
		s.logger.Errorf("failed to list alert events for user %s: %v", userClaims.UserID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load alert events"))
	}

	resp := &shortsv1alpha1.ListAlertEventsResponse{
		Events:     make([]*shortsv1alpha1.AlertEvent, 0, len(events)),
		TotalCount: total,
	}
	for _, event := range events {
		resp.Events = append(resp.Events, s.alertEventToProto(event))
	}
	return connect.NewResponse(resp), nil
}

// UpdateAlertMonitorStatus pauses or resumes one of the current user's monitors.
// Pausing never needs a subscription, so a lapsed customer can always stop an
// alert. Resuming needs Premium.
func (s *ShortsServer) UpdateAlertMonitorStatus(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.UpdateAlertMonitorStatusRequest],
) (*connect.Response[shortsv1alpha1.UpdateAlertMonitorStatusResponse], error) {
	userClaims, ok := UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("user not authenticated"))
	}
	if !isAlertMonitorID(req.Msg.Id) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid monitor id"))
	}
	status, err := alertMonitorStatusToStore(req.Msg.Status)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	if status == alertevents.MonitorStatusActive {
		_, ent, err := s.loadEntitlement(userClaims.UserID, time.Now())
		if err != nil {
			s.logger.Errorf("failed to check subscription for user %s: %v", userClaims.UserID, err)
			return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to check subscription"))
		}
		if !ent.Entitled {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New(alertsNeedPremium))
		}
	}

	monitor, err := s.store.UpdateAlertMonitorStatus(userClaims.UserID, req.Msg.Id, status, userClaims.Email)
	if err != nil {
		switch {
		case errors.Is(err, shortsstore.ErrAlertMonitorNotFound):
			return nil, connect.NewError(connect.CodeNotFound, errAlertMonitorNotFound)
		case errors.Is(err, shortsstore.ErrAlertMonitorExists):
			return nil, connect.NewError(connect.CodeAlreadyExists, errAlertMonitorDuplicate)
		}
		s.logger.Errorf("failed to update alert monitor %s for user %s: %v", req.Msg.Id, userClaims.UserID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to update monitor"))
	}

	return connect.NewResponse(&shortsv1alpha1.UpdateAlertMonitorStatusResponse{
		Monitor: alertMonitorToProto(monitor),
	}), nil
}

// DeleteAlertMonitor removes one of the current user's monitors, and its events.
func (s *ShortsServer) DeleteAlertMonitor(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.DeleteAlertMonitorRequest],
) (*connect.Response[shortsv1alpha1.DeleteAlertMonitorResponse], error) {
	userClaims, ok := UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("user not authenticated"))
	}
	if !isAlertMonitorID(req.Msg.Id) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("invalid monitor id"))
	}

	if err := s.store.DeleteAlertMonitor(userClaims.UserID, req.Msg.Id); err != nil {
		if errors.Is(err, shortsstore.ErrAlertMonitorNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errAlertMonitorNotFound)
		}
		s.logger.Errorf("failed to delete alert monitor %s for user %s: %v", req.Msg.Id, userClaims.UserID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to delete monitor"))
	}
	return connect.NewResponse(&shortsv1alpha1.DeleteAlertMonitorResponse{}), nil
}

// PauseAlertMonitorByToken pauses the monitor named by the signed token in an
// alert email. It is public, because the email link carries no session. It can
// only pause: it never resumes or deletes, so a leaked link pauses one alert at
// worst. The token follows the same secret as the newsletter links, and the
// alert-monitor prefix keeps the two from standing in for each other.
func (s *ShortsServer) PauseAlertMonitorByToken(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.PauseAlertMonitorByTokenRequest],
) (*connect.Response[shortsv1alpha1.PauseAlertMonitorByTokenResponse], error) {
	if s.unsubscribeSecret == "" {
		s.logger.Errorf("alert pause: UNSUBSCRIBE_SECRET not configured")
		return nil, connect.NewError(connect.CodeInternal, errors.New("unsubscribe not configured"))
	}
	monitorID, ok := unsubscribe.ParseAlertMonitorToken(req.Msg.Token, s.unsubscribeSecret)
	if !ok {
		// Logged without the token. A spike here means one-click pauses are failing,
		// for example after UNSUBSCRIBE_SECRET was rotated and a job kept the old copy.
		s.logger.Warnf("alert pause: token rejected (malformed, wrong secret, or not an alert token)")
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid token"))
	}

	monitor, alreadyPaused, err := s.store.PauseAlertMonitorByID(monitorID)
	if err != nil {
		if errors.Is(err, shortsstore.ErrAlertMonitorNotFound) {
			return nil, connect.NewError(connect.CodeNotFound, errAlertMonitorNotFound)
		}
		s.logger.Errorf("failed to pause alert monitor from token: %v", err)
		return nil, connect.NewError(connect.CodeInternal, errors.New("failed to pause monitor"))
	}

	resp := &shortsv1alpha1.PauseAlertMonitorByTokenResponse{
		Scope:         alertMonitorScopeFromStore(monitor.Scope),
		Target:        monitor.Target,
		Condition:     alertMonitorConditionFromStore(monitor.Condition),
		Cadence:       alertMonitorCadenceFromStore(monitor.Cadence),
		AlreadyPaused: alreadyPaused,
		HasThreshold:  monitor.Threshold != nil,
	}
	if monitor.Threshold != nil {
		resp.Threshold = *monitor.Threshold
	}
	return connect.NewResponse(resp), nil
}

// Error messages returned to the caller. The two capitalised ones are copy the
// API contract quotes verbatim, so the ST1005 capitalisation rule does not apply.
var (
	errAlertMonitorNotFound = errors.New("alert monitor not found")
	//nolint:staticcheck // ST1005: user-facing copy, quoted verbatim by the API contract
	errAlertMonitorDuplicate = errors.New("An identical monitor is already active")
	//nolint:staticcheck // ST1005: user-facing copy, quoted verbatim by the API contract
	errUnknownIndustry = errors.New("Unknown industry: choose one listed on Industry Intelligence")
	//nolint:staticcheck // ST1005: user-facing copy, quoted verbatim by the API contract
	errUnknownASXCode = errors.New("Unknown ASX code")
)

func validateCreateAlertMonitor(claims *Claims, msg *shortsv1alpha1.CreateAlertMonitorRequest) (shortsstore.CreateAlertMonitorInput, error) {
	scope, err := alertMonitorScopeToStore(msg.Scope)
	if err != nil {
		return shortsstore.CreateAlertMonitorInput{}, err
	}
	condition, err := alertMonitorConditionToStore(msg.Condition)
	if err != nil {
		return shortsstore.CreateAlertMonitorInput{}, err
	}
	cadence, err := alertMonitorCadenceToStore(msg.Cadence)
	if err != nil {
		return shortsstore.CreateAlertMonitorInput{}, err
	}

	target := normalizeAlertTarget(scope, msg.Target)
	if target == "" {
		return shortsstore.CreateAlertMonitorInput{}, fmt.Errorf("target is required")
	}
	if scope == "stock" && condition == "new_top_ten_entry" {
		return shortsstore.CreateAlertMonitorInput{}, fmt.Errorf("top-ten entry monitors are industry alerts")
	}

	var threshold *float64
	if condition != "new_top_ten_entry" {
		if !msg.HasThreshold {
			return shortsstore.CreateAlertMonitorInput{}, fmt.Errorf("threshold is required")
		}
		if math.IsNaN(msg.Threshold) || math.IsInf(msg.Threshold, 0) || msg.Threshold <= 0 || msg.Threshold > 100 {
			return shortsstore.CreateAlertMonitorInput{}, fmt.Errorf("threshold must be greater than 0 and at most 100")
		}
		value := msg.Threshold
		threshold = &value
	}

	return shortsstore.CreateAlertMonitorInput{
		UserID:    claims.UserID,
		UserEmail: claims.Email,
		Scope:     scope,
		Target:    target,
		Condition: condition,
		Threshold: threshold,
		Cadence:   cadence,
	}, nil
}

// isAlertMonitorID reports whether id has the form of a monitor id, which the
// database mints as a UUID. Anything else cannot name a monitor.
func isAlertMonitorID(id string) bool {
	_, err := uuid.Parse(strings.TrimSpace(id))
	return err == nil
}

// clampAlertLimit applies the list default and maximum shared by the alert lists.
func clampAlertLimit(limit int32) int32 {
	if limit <= 0 {
		return 20
	}
	if limit > 100 {
		return 100
	}
	return limit
}

func normalizeAlertTarget(scope, target string) string {
	normalized := strings.Join(strings.Fields(strings.TrimSpace(target)), " ")
	if scope == "stock" {
		return strings.ToUpper(normalized)
	}
	return normalized
}

func alertMonitorScopeToStore(scope shortsv1alpha1.AlertMonitorScope) (string, error) {
	switch scope {
	case shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_INDUSTRY:
		return "industry", nil
	case shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK:
		return "stock", nil
	default:
		return "", fmt.Errorf("scope is required")
	}
}

func alertMonitorConditionToStore(condition shortsv1alpha1.AlertMonitorCondition) (string, error) {
	switch condition {
	case shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE:
		return "short_interest_above", nil
	case shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_RISES:
		return "short_interest_rises", nil
	case shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_NEW_TOP_TEN_ENTRY:
		return "new_top_ten_entry", nil
	default:
		return "", fmt.Errorf("condition is required")
	}
}

func alertMonitorCadenceToStore(cadence shortsv1alpha1.AlertMonitorCadence) (string, error) {
	switch cadence {
	case shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY:
		return "daily", nil
	case shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_WEEKLY:
		return "weekly", nil
	default:
		return "", fmt.Errorf("cadence is required")
	}
}

func alertMonitorStatusToStore(status shortsv1alpha1.AlertMonitorStatus) (string, error) {
	switch status {
	case shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_ACTIVE:
		return alertevents.MonitorStatusActive, nil
	case shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_PAUSED:
		return alertevents.MonitorStatusPaused, nil
	default:
		return "", fmt.Errorf("status must be active or paused")
	}
}

func alertMonitorToProto(monitor *shortsstore.AlertMonitor) *shortsv1alpha1.AlertMonitor {
	if monitor == nil {
		return nil
	}

	resp := &shortsv1alpha1.AlertMonitor{
		Id:           monitor.ID,
		Scope:        alertMonitorScopeFromStore(monitor.Scope),
		Target:       monitor.Target,
		Condition:    alertMonitorConditionFromStore(monitor.Condition),
		Cadence:      alertMonitorCadenceFromStore(monitor.Cadence),
		Status:       alertMonitorStatusFromStore(monitor.Status),
		CreatedAt:    timestamppb.New(monitor.CreatedAt),
		UpdatedAt:    timestamppb.New(monitor.UpdatedAt),
		HasThreshold: monitor.Threshold != nil,
	}
	if monitor.Threshold != nil {
		resp.Threshold = *monitor.Threshold
	}
	if monitor.LastEventReportDate != nil {
		resp.LastEventReportDate = *monitor.LastEventReportDate
	}
	if monitor.LastEventEmailStatus != nil {
		resp.LastDeliveryStatus = alertDeliveryStatusFromStore(*monitor.LastEventEmailStatus)
	}
	if monitor.LastEventAt != nil {
		resp.LastEventAt = timestamppb.New(*monitor.LastEventAt)
	}
	return resp
}

// alertEventToProto maps one event. The payload is decoded through the shared
// contract. A payload that does not decode is logged and the event is returned
// without its companies, so one bad row cannot blank the list.
func (s *ShortsServer) alertEventToProto(event *shortsstore.AlertEvent) *shortsv1alpha1.AlertEvent {
	payload := alertevents.Payload{}
	if len(event.Payload) > 0 {
		if err := json.Unmarshal(event.Payload, &payload); err != nil {
			s.logger.Errorf("alert event %d: payload does not decode: %v", event.ID, err)
			payload = alertevents.Payload{}
		}
	}

	resp := &shortsv1alpha1.AlertEvent{
		Id:             strconv.FormatInt(event.ID, 10),
		MonitorId:      event.MonitorID,
		Scope:          alertMonitorScopeFromStore(event.Scope),
		Target:         event.Target,
		Condition:      alertMonitorConditionFromStore(event.Condition),
		Cadence:        alertMonitorCadenceFromStore(event.Cadence),
		ReportDate:     event.ReportDate,
		ComparedToDate: event.ComparedToDate,
		Companies:      make([]*shortsv1alpha1.AlertEventCompany, 0, len(payload.Companies)),
		CompaniesTotal: int32(payload.CompaniesTotal),
		DeliveryStatus: alertDeliveryStatusFromStore(event.EmailStatus),
		CreatedAt:      timestamppb.New(event.CreatedAt),
		HasThreshold:   event.Threshold != nil,
	}
	if event.Threshold != nil {
		resp.Threshold = *event.Threshold
	}
	if event.SentAt != nil {
		resp.SentAt = timestamppb.New(*event.SentAt)
	}
	for _, c := range payload.Companies {
		company := &shortsv1alpha1.AlertEventCompany{
			ProductCode:   c.Code,
			CompanyName:   c.Name,
			LatestPercent: c.Latest,
			HasPrevious:   c.Previous != nil,
			HasChange:     c.Change != nil,
			Rank:          int32(c.Rank),
			PreviousRank:  int32(c.PreviousRank),
		}
		if c.Previous != nil {
			company.PreviousPercent = *c.Previous
		}
		if c.Change != nil {
			company.ChangePoints = *c.Change
		}
		resp.Companies = append(resp.Companies, company)
	}
	return resp
}

func alertMonitorScopeFromStore(scope string) shortsv1alpha1.AlertMonitorScope {
	switch scope {
	case "industry":
		return shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_INDUSTRY
	case "stock":
		return shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK
	default:
		return shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_UNSPECIFIED
	}
}

func alertMonitorConditionFromStore(condition string) shortsv1alpha1.AlertMonitorCondition {
	switch condition {
	case "short_interest_above":
		return shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE
	case "short_interest_rises":
		return shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_RISES
	case "new_top_ten_entry":
		return shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_NEW_TOP_TEN_ENTRY
	default:
		return shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_UNSPECIFIED
	}
}

func alertMonitorCadenceFromStore(cadence string) shortsv1alpha1.AlertMonitorCadence {
	switch cadence {
	case "daily":
		return shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY
	case "weekly":
		return shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_WEEKLY
	default:
		return shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_UNSPECIFIED
	}
}

func alertMonitorStatusFromStore(status string) shortsv1alpha1.AlertMonitorStatus {
	switch status {
	case "active":
		return shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_ACTIVE
	case "paused":
		return shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_PAUSED
	default:
		return shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_UNSPECIFIED
	}
}

// alertDeliveryStatusFromStore maps an email_status to the API's delivery state.
// A send in flight reads as pending: the user sees one queued state, not the
// evaluator's claim bookkeeping.
func alertDeliveryStatusFromStore(status string) shortsv1alpha1.AlertDeliveryStatus {
	switch status {
	case alertevents.StatusPending, alertevents.StatusSending, alertevents.StatusAwaitingEntitlement:
		return shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_PENDING
	case alertevents.StatusSent:
		return shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SENT
	case alertevents.StatusFailed:
		return shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_FAILED
	case alertevents.StatusSkippedUnentitled:
		return shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SKIPPED_UNENTITLED
	case alertevents.StatusSkippedNoEmail:
		return shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SKIPPED_NO_EMAIL
	case alertevents.StatusSkippedPaused:
		return shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SKIPPED_PAUSED
	default:
		return shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_UNSPECIFIED
	}
}
