package shorts

// alerts_core.go: the alerts business rules, once.
//
// The Connect handlers (alerts.go) and the admin MCP operator (mcp_admin_alerts.go)
// both call these functions. That is the only place that decides who may create or
// resume a monitor, what a monitor may target, how many a user may hold, and whose
// address an alert is mailed to. A second copy would drift, and the rule is the
// product.
//
// Every function takes the owner's id and the owner's VERIFIED address, or "" when
// the address is not verified. The caller resolves verification (alertEmailFor for
// a Firebase session, a verified source for anything else); these functions store
// only the address they are given, so an unverified sign-up address cannot reach a
// row through them.
//
// Errors carry a kind, so each caller maps them to its own protocol (a Connect code
// in alerts.go, a tool error in the MCP server). The messages are the API contract
// and are unchanged.

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// alertsMonitorStore is the slice of the store the alerts rules use.
type alertsMonitorStore interface {
	CreateAlertMonitor(input shortsstore.CreateAlertMonitorInput) (*shortsstore.AlertMonitor, error)
	ListAlertMonitors(userID string, limit, offset int32) ([]*shortsstore.AlertMonitor, int32, error)
	UpdateAlertMonitorStatus(userID, monitorID, status, userEmail string) (*shortsstore.AlertMonitor, error)
	RefreshAlertMonitorEmail(userID, userEmail string) error
	DeleteAlertMonitor(userID, monitorID string) error
	CanonicalIndustry(target string) (string, bool, error)
	StockCodeKnown(code string) (bool, error)
	AlertCheckedThrough() (string, error)
}

// alertsCore is the shared alerts rule with its dependencies made explicit.
type alertsCore struct {
	store alertsMonitorStore
	// entitled answers the subscription rule for a user: the same ResolveEntitlement
	// the paid features use (ShortsServer.loadEntitlement).
	entitled func(userID string) (bool, error)
	logger   Logger
}

// alertsErrorKind says which protocol status a refusal maps to.
type alertsErrorKind int

const (
	alertsKindInternal alertsErrorKind = iota
	alertsKindPermission
	alertsKindInvalid
	alertsKindNotFound
	alertsKindExists
	alertsKindLimit
)

// alertsError is a refusal of the shared rule: its kind and the message the caller
// shows. Error() is the message.
type alertsError struct {
	kind alertsErrorKind
	err  error
}

func (e *alertsError) Error() string { return e.err.Error() }
func (e *alertsError) Unwrap() error { return e.err }

func alertsFail(kind alertsErrorKind, err error) error {
	return &alertsError{kind: kind, err: err}
}

// kindOf returns the refusal's kind, or internal for any other error.
func kindOf(err error) alertsErrorKind {
	var ae *alertsError
	if errors.As(err, &ae) {
		return ae.kind
	}
	return alertsKindInternal
}

// validateAlertMonitorInput turns the request into the store's input. It is the
// whole request-shape rule: scope, condition, cadence, target and threshold.
func validateAlertMonitorInput(userID, verifiedEmail string, msg *shortsv1alpha1.CreateAlertMonitorRequest) (shortsstore.CreateAlertMonitorInput, error) {
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
		UserID:    userID,
		UserEmail: verifiedEmail,
		Scope:     scope,
		Target:    target,
		Condition: condition,
		Threshold: threshold,
		Cadence:   cadence,
	}, nil
}

// requirePremium is the entitlement check create and resume share. It is a method of the
// core so a caller can run it BEFORE any other work (the public path reads the caller's
// address only after it passes), and so the refusal is the same wherever it is asked.
func (c alertsCore) requirePremium(userID string) error {
	entitled, err := c.entitled(userID)
	if err != nil {
		c.logger.Errorf("failed to check subscription for user %s: %v", userID, err)
		return alertsFail(alertsKindInternal, errors.New("failed to check subscription"))
	}
	if !entitled {
		return alertsFail(alertsKindPermission, errors.New(alertsNeedPremium))
	}
	return nil
}

// createMonitor saves a premium monitor for userID. Order matters and is pinned by
// the handler tests: entitlement, then the request shape, then the target, then the
// store. A refused create writes nothing.
func (c alertsCore) createMonitor(_ context.Context, userID, verifiedEmail string, msg *shortsv1alpha1.CreateAlertMonitorRequest) (*shortsstore.AlertMonitor, error) {
	if err := c.requirePremium(userID); err != nil {
		return nil, err
	}

	input, err := validateAlertMonitorInput(userID, verifiedEmail, msg)
	if err != nil {
		return nil, alertsFail(alertsKindInvalid, err)
	}

	// A target the evaluator can never match saves a monitor that silently never
	// fires. Refuse it here, and store an industry under its canonical spelling so
	// that "materials" and "Materials" are one monitor.
	switch input.Scope {
	case "industry":
		canonical, found, err := c.store.CanonicalIndustry(input.Target)
		if err != nil {
			c.logger.Errorf("failed to resolve industry %q: %v", input.Target, err)
			return nil, alertsFail(alertsKindInternal, errors.New("failed to check industry"))
		}
		if !found {
			return nil, alertsFail(alertsKindInvalid, errUnknownIndustry)
		}
		input.Target = canonical
	case "stock":
		known, err := c.store.StockCodeKnown(input.Target)
		if err != nil {
			c.logger.Errorf("failed to check stock code %q: %v", input.Target, err)
			return nil, alertsFail(alertsKindInternal, errors.New("failed to check stock code"))
		}
		if !known {
			return nil, alertsFail(alertsKindInvalid, errUnknownASXCode)
		}
	}

	monitor, err := c.store.CreateAlertMonitor(input)
	if err != nil {
		switch {
		case errors.Is(err, shortsstore.ErrAlertMonitorExists):
			return nil, alertsFail(alertsKindExists, errors.New("monitor already exists"))
		case errors.Is(err, shortsstore.ErrAlertMonitorLimit):
			return nil, alertsFail(alertsKindLimit, errAlertMonitorCreateLimit)
		}
		c.logger.Errorf("failed to create alert monitor for user %s: %v", userID, err)
		return nil, alertsFail(alertsKindInternal, errors.New("failed to save monitor"))
	}
	return monitor, nil
}

// listMonitors returns userID's monitors, newest first, and the latest report the
// evaluator has checked. A non-empty verifiedEmail first points the user's monitors
// at that address (best effort, logged on failure), as the alerts page always has.
// The caller clamps limit and offset.
func (c alertsCore) listMonitors(_ context.Context, userID, verifiedEmail string, limit, offset int32) ([]*shortsstore.AlertMonitor, int32, string, error) {
	if verifiedEmail != "" {
		if err := c.store.RefreshAlertMonitorEmail(userID, verifiedEmail); err != nil {
			c.logger.Errorf("failed to refresh alert email for user %s: %v", userID, err)
		}
	}
	monitors, total, err := c.store.ListAlertMonitors(userID, limit, offset)
	if err != nil {
		c.logger.Errorf("failed to list alert monitors for user %s: %v", userID, err)
		return nil, 0, "", alertsFail(alertsKindInternal, errors.New("failed to load monitors"))
	}
	checked, err := c.store.AlertCheckedThrough()
	if err != nil {
		c.logger.Errorf("failed to read alert evaluator state: %v", err)
		return nil, 0, "", alertsFail(alertsKindInternal, errors.New("failed to load monitors"))
	}
	return monitors, total, checked, nil
}

// setMonitorStatus pauses or resumes one of userID's monitors. Pausing needs no
// subscription, so a lapsed customer can always stop an alert; resuming needs
// Premium. status is the store's form (alertevents.MonitorStatus*).
func (c alertsCore) setMonitorStatus(_ context.Context, userID, verifiedEmail, monitorID, status string) (*shortsstore.AlertMonitor, error) {
	if status == alertevents.MonitorStatusActive {
		if err := c.requirePremium(userID); err != nil {
			return nil, err
		}
	}

	monitor, err := c.store.UpdateAlertMonitorStatus(userID, monitorID, status, verifiedEmail)
	if err != nil {
		switch {
		case errors.Is(err, shortsstore.ErrAlertMonitorNotFound):
			return nil, alertsFail(alertsKindNotFound, errAlertMonitorNotFound)
		case errors.Is(err, shortsstore.ErrAlertMonitorExists):
			return nil, alertsFail(alertsKindExists, errAlertMonitorDuplicate)
		case errors.Is(err, shortsstore.ErrAlertMonitorLimit):
			return nil, alertsFail(alertsKindLimit, errAlertMonitorResumeLimit)
		}
		c.logger.Errorf("failed to update alert monitor %s for user %s: %v", monitorID, userID, err)
		return nil, alertsFail(alertsKindInternal, errors.New("failed to update monitor"))
	}
	return monitor, nil
}

// deleteMonitor removes one of userID's monitors and its events. Another user's
// monitor is not found: the store matches on the owner, never the id alone.
func (c alertsCore) deleteMonitor(_ context.Context, userID, monitorID string) error {
	if err := c.store.DeleteAlertMonitor(userID, monitorID); err != nil {
		if errors.Is(err, shortsstore.ErrAlertMonitorNotFound) {
			return alertsFail(alertsKindNotFound, errAlertMonitorNotFound)
		}
		c.logger.Errorf("failed to delete alert monitor %s for user %s: %v", monitorID, userID, err)
		return alertsFail(alertsKindInternal, errors.New("failed to delete monitor"))
	}
	return nil
}

// alertsCore is the shared rule over this server's own store and subscription rule.
func (s *ShortsServer) alertsCore() alertsCore {
	return alertsCore{
		store: s.store,
		// Alerts are a premium web feature. API Access is paid, but it carries no
		// alerts, so the gate reads the premium-feature rule, not paid access.
		entitled: func(userID string) (bool, error) {
			_, ent, err := s.loadEntitlement(userID, time.Now())
			return ent.HasPremiumFeatures(), err
		},
		logger: s.logger,
	}
}
