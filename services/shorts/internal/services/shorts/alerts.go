package shorts

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// CreateAlertMonitor saves a premium short-interest monitor for the current user.
func (s *ShortsServer) CreateAlertMonitor(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.CreateAlertMonitorRequest],
) (*connect.Response[shortsv1alpha1.CreateAlertMonitorResponse], error) {
	userClaims, ok := UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("user not authenticated"))
	}
	if !canCreateAlertMonitors(userClaims.Tier) {
		return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("alerts require an active Premium subscription"))
	}

	input, err := validateCreateAlertMonitor(userClaims, req.Msg)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
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

// ListAlertMonitors returns the current user's short-interest monitors.
func (s *ShortsServer) ListAlertMonitors(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListAlertMonitorsRequest],
) (*connect.Response[shortsv1alpha1.ListAlertMonitorsResponse], error) {
	userClaims, ok := UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("user not authenticated"))
	}

	limit := req.Msg.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	offset := req.Msg.Offset
	if offset < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("offset must be non-negative"))
	}

	monitors, total, err := s.store.ListAlertMonitors(userClaims.UserID, limit, offset)
	if err != nil {
		s.logger.Errorf("failed to list alert monitors for user %s: %v", userClaims.UserID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to load monitors"))
	}

	resp := &shortsv1alpha1.ListAlertMonitorsResponse{
		Monitors:   make([]*shortsv1alpha1.AlertMonitor, 0, len(monitors)),
		TotalCount: total,
	}
	for _, monitor := range monitors {
		resp.Monitors = append(resp.Monitors, alertMonitorToProto(monitor))
	}

	return connect.NewResponse(resp), nil
}

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

func canCreateAlertMonitors(tier string) bool {
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case "premium", "pro", "enterprise":
		return true
	default:
		return false
	}
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
