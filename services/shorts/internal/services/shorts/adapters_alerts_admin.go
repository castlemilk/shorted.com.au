package shorts

// adapters_alerts_admin.go forwards the admin alerts reads through StoreAdapter.
//
// The admin tools reach the store by type assertion (alertsAdminStoreFrom in
// mcp_admin_alerts.go). serve.go asserts on the adapter, not on the Postgres
// store under it, so every method the admin view needs must be forwarded here.
// Without them the assertion yields nil and every alerts tool reports the store
// as not configured. TestAlertsAdminStoreReachableThroughTheAdapter pins this.

import (
	"context"
	"fmt"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// adminAlertsStoreOf returns the underlying store's admin view, or an error naming
// the gap when the backend does not provide one.
func (s *StoreAdapter) adminAlertsStoreOf() (shorts.AdminAlertsStore, error) {
	a, ok := s.store.(shorts.AdminAlertsStore)
	if !ok {
		return nil, fmt.Errorf("the store backend (%T) does not provide the admin alerts view", s.store)
	}
	return a, nil
}

func (s *StoreAdapter) ReportWindow(ctx context.Context) (shorts.AlertWindow, error) {
	a, err := s.adminAlertsStoreOf()
	if err != nil {
		return shorts.AlertWindow{}, err
	}
	return a.ReportWindow(ctx)
}

func (s *StoreAdapter) AdminAlertMonitorCounts(ctx context.Context) ([]shorts.AlertMonitorCount, error) {
	a, err := s.adminAlertsStoreOf()
	if err != nil {
		return nil, err
	}
	return a.AdminAlertMonitorCounts(ctx)
}

func (s *StoreAdapter) AdminAlertDeliveryHealth(ctx context.Context) (shorts.AlertDeliveryHealth, error) {
	a, err := s.adminAlertsStoreOf()
	if err != nil {
		return shorts.AlertDeliveryHealth{}, err
	}
	return a.AdminAlertDeliveryHealth(ctx)
}

func (s *StoreAdapter) AdminAlertEvaluatorRuns(ctx context.Context, limit int) ([]shorts.AdminAlertRun, error) {
	a, err := s.adminAlertsStoreOf()
	if err != nil {
		return nil, err
	}
	return a.AdminAlertEvaluatorRuns(ctx, limit)
}

func (s *StoreAdapter) AdminRecentAlertEvents(ctx context.Context, limit int) ([]shorts.AdminAlertEvent, error) {
	a, err := s.adminAlertsStoreOf()
	if err != nil {
		return nil, err
	}
	return a.AdminRecentAlertEvents(ctx, limit)
}

func (s *StoreAdapter) AdminAlertEventsOnDate(ctx context.Context, userID, monitorID, reportDate string) (bool, []shorts.AdminAlertEvent, error) {
	a, err := s.adminAlertsStoreOf()
	if err != nil {
		return false, nil, err
	}
	return a.AdminAlertEventsOnDate(ctx, userID, monitorID, reportDate)
}
