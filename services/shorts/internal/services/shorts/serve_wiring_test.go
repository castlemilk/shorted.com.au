package shorts

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// adminViewStore is a store that provides the alerts admin view and the monitor
// reads. Its embedded shorts.Store is nil: a call to any method not overridden here
// panics, which is what a wiring test wants.
type adminViewStore struct {
	shorts.Store
	window shorts.AlertWindow
}

func (f adminViewStore) ReportWindow(context.Context) (shorts.AlertWindow, error) {
	return f.window, nil
}
func (f adminViewStore) AdminAlertDeliveryHealth(context.Context) (shorts.AlertDeliveryHealth, error) {
	return shorts.AlertDeliveryHealth{}, nil
}
func (f adminViewStore) AdminAlertMonitorCounts(context.Context) ([]shorts.AlertMonitorCount, error) {
	return []shorts.AlertMonitorCount{{Status: "active", Cadence: "daily", Count: 4}}, nil
}
func (f adminViewStore) AdminAlertEvaluatorRuns(context.Context, int) ([]shorts.AdminAlertRun, error) {
	return nil, nil
}
func (f adminViewStore) AdminRecentAlertEvents(context.Context, int) ([]shorts.AdminAlertEvent, error) {
	return nil, nil
}
func (f adminViewStore) AdminAlertEventsOnDate(context.Context, string, string, string) (bool, []shorts.AdminAlertEvent, error) {
	return false, nil, nil
}
func (f adminViewStore) ListAlertMonitors(string, int32, int32) ([]*shorts.AlertMonitor, int32, error) {
	return nil, 0, nil
}
func (f adminViewStore) AlertCheckedThrough() (string, error) { return "", nil }

// The regression that shipped: serve.go asserts on the adapter, and the adapter did
// not forward the admin view, so every alerts tool reported "not configured".
func TestAlertsAdminStoreReachableThroughTheAdapter(t *testing.T) {
	adapter := NewStoreAdapter(adminViewStore{})
	require.NotNil(t, alertsAdminStoreFrom(adapter), "the adapter must expose the admin alerts view")

	win, err := adapter.ReportWindow(context.Background())
	require.NoError(t, err)
	assert.Equal(t, shorts.AlertWindow{}, win)
	counts, err := adapter.AdminAlertMonitorCounts(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 4, counts[0].Count, "the forwarded read reaches the store")
}

// A backend without the view is an error that says so, never a panic or a silent
// empty answer.
func TestAdapterOverAStoreWithoutTheViewSaysSo(t *testing.T) {
	adapter := NewStoreAdapter(plainStore{})
	_, err := adapter.ReportWindow(context.Background())
	require.Error(t, err)
	assert.ErrorContains(t, err, "does not provide the admin alerts view")
}

// plainStore is a backend with no admin view: only the embedded nil Store.
type plainStore struct{ shorts.Store }

// The wiring test: the admin source is built by the same constructor serve.go uses,
// and an alerts tool runs through it. A field left out of newAdminMCPSource is a
// failure here, not an unconfigured tool in production.
func TestServeWiringBuildsAWorkingAlertsOperator(t *testing.T) {
	s := &ShortsServer{store: NewStoreAdapter(adminViewStore{}), logger: NewLoggerAdapter()}
	src := newAdminMCPSource(s, nil)

	require.NotNil(t, src.alerts, "alerts store must be wired")
	require.NotNil(t, src.entitled, "entitlement must be wired")
	require.NotNil(t, src.verifiedEmail, "verified-address resolver must be wired")

	out, err := src.AlertsStatus(context.Background(), "uid-admin")
	require.NoError(t, err)
	var counts string
	for _, source := range out.Sources {
		if source.Name == "alert_monitor_counts" {
			counts = source.Status
		}
		assert.NotEqual(t, "unconfigured", source.Status, "source %s reads as unconfigured", source.Name)
	}
	assert.Equal(t, "available", counts)
	assert.Equal(t, 4, out.Monitors[0].Count)
}
