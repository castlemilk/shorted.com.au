package shorts

import (
	"context"
	"testing"
	"time"

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

// feedbackStore is a backend that records Resend feedback, standing in for Postgres.
type feedbackStore struct {
	shorts.Store
	gotEmailID string
}

func (f *feedbackStore) RecordResendFeedback(_ context.Context, emailID, _, _ string, _ []string) (shorts.ResendFeedbackResult, error) {
	f.gotEmailID = emailID
	return shorts.ResendFeedbackResult{Deliveries: 1}, nil
}

// serve.go hands the webhook the adapter, so the feedback write must be reachable
// through it. Without the forwarder the assertion is nil and /webhooks/resend answers
// "store not configured" in production with the signing secret set.
func TestResendWebhookStoreReachableThroughTheAdapter(t *testing.T) {
	backend := &feedbackStore{}
	w := resendWebhookStoreFrom(NewStoreAdapter(backend))
	require.NotNil(t, w, "the adapter must expose the Resend feedback write")

	res, err := w.RecordResendFeedback(context.Background(), "email-1", "bounced", "", nil)
	require.NoError(t, err)
	assert.Equal(t, int64(1), res.Deliveries)
	assert.Equal(t, "email-1", backend.gotEmailID, "the forwarded write reaches the store")
}

// A backend that does not record feedback is an error that says so, not a panic.
func TestResendFeedbackOverAStoreWithoutItSaysSo(t *testing.T) {
	_, err := NewStoreAdapter(plainStore{}).RecordResendFeedback(context.Background(), "email-1", "bounced", "", nil)
	require.Error(t, err)
	assert.ErrorContains(t, err, "does not record Resend feedback")
}

// allowlistStore is a backend that provides the housing crawl allowlist.
type allowlistStore struct{ shorts.Store }

func (allowlistStore) ListIngestRigs(context.Context) ([]shorts.IngestRig, error) {
	return []shorts.IngestRig{{Subject: "rig:gamma", Enabled: true}}, nil
}
func (allowlistStore) IngestRigState(context.Context, string) (bool, bool, error) {
	return true, true, nil
}
func (allowlistStore) EnableIngestRig(context.Context, string, *string) (bool, error) {
	return false, nil
}
func (allowlistStore) DisableIngestRig(context.Context, string) (string, error) {
	return shorts.IngestRigDisabled, nil
}

// The same regression as the alerts view, shipped again: CrawlRigStore asserts on the
// adapter, which did not forward the allowlist, so housing_crawl_rigs and
// housing_crawl_authorize answered "not configured" in production.
func TestCrawlRigStoreReachableThroughTheAdapter(t *testing.T) {
	src := newAdminMCPSource(&ShortsServer{store: NewStoreAdapter(allowlistStore{}), logger: NewLoggerAdapter()}, nil)
	store := src.CrawlRigStore()
	require.NotNil(t, store, "the adapter must expose the housing crawl allowlist")

	rows, err := store.ListCrawlRigs(context.Background())
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "rig:gamma", rows[0].Subject, "the forwarded read reaches the store")
}

func TestAdapterOverAStoreWithoutTheAllowlistSaysSo(t *testing.T) {
	_, err := NewStoreAdapter(plainStore{}).ListIngestRigs(context.Background())
	assert.ErrorContains(t, err, "does not provide the housing crawl allowlist")
}

// Every admin view the services reach by type assertion on the adapter. The adapter
// shipped twice without forwarding one (the alerts view, then the crawl allowlist), and a
// third time without the crawl ledger (#815), each time reading "not configured" in
// production while the tests, which fake the store directly, passed. Adding a view means
// adding it here: the build then fails until StoreAdapter forwards it.
var (
	_ shorts.AdminAlertsStore    = (*StoreAdapter)(nil)
	_ shorts.IngestRigAdminStore = (*StoreAdapter)(nil)
	_ shorts.CrawlOpsAdminStore  = (*StoreAdapter)(nil)
)

type crawlLedgerStore struct{ shorts.Store }

func (crawlLedgerStore) CrawlDispatchOpen(context.Context) (int64, int64, error) { return 7, 2, nil }
func (crawlLedgerStore) CrawlReceiptGroups(context.Context, time.Time, string, []string) ([]shorts.CrawlReceiptGroup, error) {
	return nil, nil
}
func (crawlLedgerStore) CrawlQuarantineReasons(context.Context, time.Time, string) ([]shorts.CrawlReasonCount, error) {
	return nil, nil
}
func (crawlLedgerStore) CrawlFinalizeWatermark(context.Context) (time.Time, time.Time, bool, error) {
	return time.Time{}, time.Time{}, false, nil
}
func (crawlLedgerStore) CrawlDispatchForRun(context.Context, string) ([]shorts.CrawlDispatchRow, error) {
	return nil, nil
}
func (crawlLedgerStore) CrawlOpenDispatchForSuburb(context.Context, string) ([]shorts.CrawlDispatchRow, error) {
	return nil, nil
}
func (crawlLedgerStore) CrawlDispatchForJob(context.Context, string) (*shorts.CrawlDispatchRow, error) {
	return nil, nil
}
func (crawlLedgerStore) CrawlReceiptsForJob(context.Context, string) ([]shorts.CrawlReceipt, error) {
	return nil, nil
}
func (crawlLedgerStore) CrawlQuarantineForJob(context.Context, string) ([]shorts.CrawlQuarantineEntry, error) {
	return nil, nil
}

func TestCrawlOpsReachableThroughTheAdapter(t *testing.T) {
	src := newAdminMCPSource(&ShortsServer{store: NewStoreAdapter(crawlLedgerStore{}), logger: NewLoggerAdapter()}, nil)
	ops := src.CrawlOps()
	require.NotNil(t, ops, "the adapter must expose the housing crawl ledger")

	open, expiring, err := ops.DispatchOpen(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(7), open, "the forwarded read reaches the store")
	assert.Equal(t, int64(2), expiring)
}

func TestAdapterOverAStoreWithoutTheCrawlLedgerSaysSo(t *testing.T) {
	_, _, err := NewStoreAdapter(plainStore{}).CrawlDispatchOpen(context.Background())
	assert.ErrorContains(t, err, "does not provide the housing crawl ledger")
}
