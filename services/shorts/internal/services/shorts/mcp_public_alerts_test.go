package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// publicFakeStore records the writes the public tools make. Every method the shared rule
// uses is here; ShortsStore is embedded nil, so an unexpected call panics in the test.
type publicFakeStore struct {
	ShortsStore
	monitors       []*shortsstore.AlertMonitor
	created        []shortsstore.CreateAlertMonitorInput
	statusWrites   []string
	deleted        []string
	createErr      error
	events         []*shortsstore.AlertEvent
	canonicalFound bool
}

func (f *publicFakeStore) CreateAlertMonitor(in shortsstore.CreateAlertMonitorInput) (*shortsstore.AlertMonitor, error) {
	f.created = append(f.created, in)
	if f.createErr != nil {
		return nil, f.createErr
	}
	th := in.Threshold
	m := &shortsstore.AlertMonitor{ID: "7d2c4f1e-0a9b-4c3d-8e2f-1a2b3c4d5e6f", UserID: in.UserID, UserEmail: in.UserEmail,
		Scope: in.Scope, Target: in.Target, Condition: in.Condition, Threshold: th, Cadence: in.Cadence, Status: "active", CreatedAt: time.Now()}
	f.monitors = append(f.monitors, m)
	return m, nil
}
func (f *publicFakeStore) ListAlertMonitors(userID string, limit, offset int32) ([]*shortsstore.AlertMonitor, int32, error) {
	var mine []*shortsstore.AlertMonitor
	for _, m := range f.monitors {
		if m.UserID == userID {
			mine = append(mine, m)
		}
	}
	return mine, int32(len(mine)), nil
}
func (f *publicFakeStore) UpdateAlertMonitorStatus(userID, monitorID, status, userEmail string) (*shortsstore.AlertMonitor, error) {
	f.statusWrites = append(f.statusWrites, userID+":"+status+":"+userEmail)
	for _, m := range f.monitors {
		if m.UserID == userID && m.ID == monitorID {
			m.Status = status
			return m, nil
		}
	}
	return nil, shortsstore.ErrAlertMonitorNotFound
}
func (f *publicFakeStore) RefreshAlertMonitorEmail(string, string) error { return nil }
func (f *publicFakeStore) DeleteAlertMonitor(userID, monitorID string) error {
	f.deleted = append(f.deleted, userID+"/"+monitorID)
	for _, m := range f.monitors {
		if m.UserID == userID && m.ID == monitorID {
			return nil
		}
	}
	return shortsstore.ErrAlertMonitorNotFound
}
func (f *publicFakeStore) CanonicalIndustry(target string) (string, bool, error) {
	return target, f.canonicalFound, nil
}
func (f *publicFakeStore) StockCodeKnown(string) (bool, error)  { return true, nil }
func (f *publicFakeStore) AlertCheckedThrough() (string, error) { return "", nil }
func (f *publicFakeStore) ListAlertEvents(userID, monitorID string, _, _ int32) ([]*shortsstore.AlertEvent, int32, error) {
	var out []*shortsstore.AlertEvent
	for _, e := range f.events {
		if e.MonitorID == monitorID || monitorID == "" {
			out = append(out, e)
		}
	}
	return out, int32(len(out)), nil
}

// publicSource builds the public operator over the fake. premium decides the entitlement;
// email is the verified address, or the refusal the resolver gives.
func publicSource(store *publicFakeStore, premium bool, email string, emailErr error) *publicAlertsSource {
	return &publicAlertsSource{
		core:  alertsCore{store: store, entitled: func(string) (bool, error) { return premium, nil }, logger: NewLoggerAdapter()},
		store: store,
		verifiedEmail: func(context.Context, string) (string, error) {
			if emailErr != nil {
				return "", emailErr
			}
			return email, nil
		},
		upgradeURL: defaultUpgradeURL,
	}
}

var bhpAbove = mcp.CreateAlertInput{Scope: "stock", Target: "BHP", Condition: "short_interest_above", Cadence: "daily", Threshold: ptrFloat(5)}

func ptrFloat(v float64) *float64 { return &v }

// Creating needs a verified address: none is written without one.
func TestPublicCreateRefusesWithoutAVerifiedAddress(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, true, "", errors.New("this account has no email address on file"))
	_, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.Error(t, err)
	// Finding 6: the caller sees the public verify message, never the internal reason.
	assert.Equal(t, publicAddressUnverified, err.Error())
	assert.Empty(t, store.created)
}

// Creating needs Premium, through the shared rule: the same message the web API gives.
func TestPublicCreateNeedsPremiumLikeTheWebAPI(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, false, "ben@example.test", nil)
	_, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.Error(t, err)
	assert.EqualError(t, err, alertsNeedPremium+". Upgrade at "+defaultUpgradeURL)
	assert.Empty(t, store.created)
}

// The rule's validation is the same rule the web API runs. A bad threshold and an
// unknown scope are refused with the rule's wording and nothing is written.
func TestPublicCreateValidatesThroughTheSharedRule(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, true, "ben@example.test", nil)
	bad := bhpAbove
	bad.Threshold = ptrFloat(150)
	_, err := src.CreateAlert(context.Background(), "uid-a", bad)
	assert.EqualError(t, err, "threshold must be greater than 0 and at most 100")

	_, err = src.CreateAlert(context.Background(), "uid-a", mcp.CreateAlertInput{Scope: "sector", Target: "x", Condition: "short_interest_above", Cadence: "daily", Threshold: ptrFloat(5)})
	assert.ErrorContains(t, err, "scope must be industry or stock")

	industry := mcp.CreateAlertInput{Scope: "industry", Target: "Nowhere", Condition: "new_top_ten_entry", Cadence: "daily"}
	_, err = src.CreateAlert(context.Background(), "uid-a", industry)
	assert.EqualError(t, err, errUnknownIndustry.Error())
	assert.Empty(t, store.created, "a refused create writes nothing")
}

// A good create stores the caller's verified address, keyed to the verified uid.
func TestPublicCreateStoresTheVerifiedAddressForTheCaller(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, true, "ben@example.test", nil)
	out, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.NoError(t, err)
	require.Len(t, store.created, 1)
	assert.Equal(t, "uid-a", store.created[0].UserID)
	assert.Equal(t, "ben@example.test", store.created[0].UserEmail)
	assert.Equal(t, "BHP", out.Target)
	assert.True(t, out.HasEmail)
}

// The monitor cap is the shared rule's: the same refusal the web API gives.
func TestPublicCreateAtTheCapIsTheSharedRefusal(t *testing.T) {
	store := &publicFakeStore{createErr: shortsstore.ErrAlertMonitorLimit}
	src := publicSource(store, true, "ben@example.test", nil)
	_, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	assert.EqualError(t, err, errAlertMonitorCreateLimit.Error())
}

// Pausing needs no subscription, so a lapsed customer can always stop an alert.
func TestPublicPauseNeedsNoSubscription(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, true, "ben@example.test", nil)
	created, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.NoError(t, err)

	lapsed := publicSource(store, false, "", nil)
	paused, err := lapsed.SetAlertPaused(context.Background(), "uid-a", created.ID, true)
	require.NoError(t, err)
	assert.Equal(t, "paused", paused.Status)
}

// Resuming needs Premium, through the shared rule.
func TestPublicResumeNeedsPremium(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, true, "ben@example.test", nil)
	created, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.NoError(t, err)
	_, err = src.SetAlertPaused(context.Background(), "uid-a", created.ID, true)
	require.NoError(t, err)

	lapsed := publicSource(store, false, "", nil)
	_, err = lapsed.SetAlertPaused(context.Background(), "uid-a", created.ID, false)
	assert.EqualError(t, err, alertsNeedPremium+". Upgrade at "+defaultUpgradeURL)
	assert.NotContains(t, strings.Join(store.statusWrites, ","), ":active:", "a refused resume writes nothing")
}

// Resuming an unverified account still resumes, and leaves the stored address alone.
func TestPublicResumeWithoutAVerifiedAddressLeavesTheAddress(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, true, "ben@example.test", nil)
	created, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.NoError(t, err)
	_, err = src.SetAlertPaused(context.Background(), "uid-a", created.ID, true)
	require.NoError(t, err)

	noAddress := publicSource(store, true, "", errors.New("not verified"))
	resumed, err := noAddress.SetAlertPaused(context.Background(), "uid-a", created.ID, false)
	require.NoError(t, err)
	assert.Equal(t, "active", resumed.Status)
	assert.Equal(t, "uid-a:active:", store.statusWrites[len(store.statusWrites)-1], "an unreadable address changes nothing")
}

// Another owner's monitor is not found, and nothing is deleted.
func TestPublicDeleteIsOwnerChecked(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, true, "ben@example.test", nil)
	created, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.NoError(t, err)

	err = src.DeleteAlert(context.Background(), "uid-b", created.ID)
	assert.EqualError(t, err, errAlertMonitorNotFound.Error())
	require.NoError(t, src.DeleteAlert(context.Background(), "uid-a", created.ID))
}

// History names the stocks and the delivery state, and carries no provider or error fields.
func TestPublicHistoryCarriesNoProviderIdsOrErrorText(t *testing.T) {
	payload, _ := json.Marshal(alertevents.Payload{CompaniesTotal: 1, Companies: []alertevents.Company{{Code: "BHP", Name: "BHP Group", Latest: 5.5, Previous: ptrFloat(4)}}})
	sent := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	store := &publicFakeStore{events: []*shortsstore.AlertEvent{{
		ID: 9, MonitorID: "m1", Scope: "stock", Target: "BHP", Condition: "short_interest_above", ReportDate: "2026-10-21",
		ComparedToDate: "2026-10-20", Payload: payload, EmailStatus: "sent", SentAt: &sent,
	}, {ID: 10, MonitorID: "m1", Target: "BHP", EmailStatus: "sending"}}}
	src := publicSource(store, true, "", nil)
	out, err := src.AlertHistory(context.Background(), "uid-a", "", 20, 0)
	require.NoError(t, err)
	require.Len(t, out.Events, 2)
	assert.Equal(t, "sent", out.Events[0].Delivery)
	assert.Equal(t, "2026-10-21T09:00:00Z", out.Events[0].SentAt)
	assert.Equal(t, "BHP", out.Events[0].Companies[0].Code)
	assert.Equal(t, "pending", out.Events[1].Delivery, "a queued send reads as pending")

	raw, err := json.Marshal(out)
	require.NoError(t, err)
	for _, forbidden := range []string{"resend", "last_error", "lastError", "send_claimed", "entitlement"} {
		assert.NotContains(t, strings.ToLower(string(raw)), forbidden)
	}
}

// Every tool-facing string is mapped to the API's enum, not passed through.
func TestPublicCreateMapsEveryFieldToTheAPIEnums(t *testing.T) {
	msg, err := createRequestFromTool(mcp.CreateAlertInput{Scope: "industry", Target: "Materials", Condition: "new_top_ten_entry", Cadence: "weekly"})
	require.NoError(t, err)
	assert.False(t, msg.HasThreshold)
	assert.Equal(t, "Materials", msg.Target)
	_, err = createRequestFromTool(mcp.CreateAlertInput{Scope: "stock", Target: "BHP", Condition: "below", Cadence: "daily"})
	assert.ErrorContains(t, err, "condition must be")
	_, err = createRequestFromTool(mcp.CreateAlertInput{Scope: "stock", Target: "BHP", Condition: "short_interest_above", Cadence: "hourly"})
	assert.ErrorContains(t, err, "cadence must be daily or weekly")
}

// One rule set, checked against the source: the public operator must not call the
// Connect client. A Connect call would run the interceptor chain and bypass the
// shared rule's ownership and entitlement path as this file wires them.
func TestPublicAlertsReachOnlyTheSharedRule(t *testing.T) {
	src, err := os.ReadFile("mcp_public_alerts.go")
	require.NoError(t, err)
	for _, forbidden := range []string{"shortsv1alpha1connect", "connect.NewRequest", "connect.NewError"} {
		assert.NotContains(t, string(src), forbidden, "the public alerts operator must not use %s", forbidden)
	}
}

// wiredPublicStore sends the monitor calls to a publicFakeStore, so a test can run the
// public operator through StoreAdapter as serve.go does. A method the adapter does not
// forward reaches the nil embedded store and panics, which is the regression to catch.
type wiredPublicStore struct {
	shortsstore.Store
	f *publicFakeStore
}

func (w wiredPublicStore) CreateAlertMonitor(in shortsstore.CreateAlertMonitorInput) (*shortsstore.AlertMonitor, error) {
	return w.f.CreateAlertMonitor(in)
}
func (w wiredPublicStore) ListAlertMonitors(u string, l, o int32) ([]*shortsstore.AlertMonitor, int32, error) {
	return w.f.ListAlertMonitors(u, l, o)
}
func (w wiredPublicStore) UpdateAlertMonitorStatus(u, id, st, e string) (*shortsstore.AlertMonitor, error) {
	return w.f.UpdateAlertMonitorStatus(u, id, st, e)
}
func (w wiredPublicStore) RefreshAlertMonitorEmail(u, e string) error {
	return w.f.RefreshAlertMonitorEmail(u, e)
}
func (w wiredPublicStore) DeleteAlertMonitor(u, id string) error {
	return w.f.DeleteAlertMonitor(u, id)
}
func (w wiredPublicStore) CanonicalIndustry(t string) (string, bool, error) {
	return w.f.CanonicalIndustry(t)
}
func (w wiredPublicStore) StockCodeKnown(c string) (bool, error) { return w.f.StockCodeKnown(c) }
func (w wiredPublicStore) AlertCheckedThrough() (string, error)  { return w.f.AlertCheckedThrough() }

// GetAPISubscription answers the entitlement lookup the shared rule makes: an active Premium row.
func (w wiredPublicStore) GetAPISubscription(userID string) (*shortsstore.APISubscription, error) {
	return activeRow("premium"), nil
}
func (w wiredPublicStore) ListAlertEvents(u, m string, l, o int32) ([]*shortsstore.AlertEvent, int32, error) {
	return w.f.ListAlertEvents(u, m, l, o)
}

// The public operator, built the way serve.go builds it, runs its writes and reads through
// the adapter. If the adapter stops forwarding a method, this fails rather than panicking
// in production.
func TestPublicOperatorWiredThroughTheAdapter(t *testing.T) {
	fake := &publicFakeStore{}
	s := &ShortsServer{store: NewStoreAdapter(wiredPublicStore{f: fake}), logger: NewLoggerAdapter()}
	src := newPublicAlertsSource(s, nil)
	src.verifiedEmail = func(context.Context, string) (string, error) { return "ben@example.test", nil }

	out, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.NoError(t, err)
	require.Len(t, fake.created, 1)
	assert.Equal(t, "uid-a", fake.created[0].UserID)
	assert.Equal(t, out.ID, fake.monitors[0].ID)

	list, err := src.ListMyAlerts(context.Background(), "uid-a", 20, 0)
	require.NoError(t, err)
	assert.Equal(t, 1, list.TotalCount)

	_, err = src.AlertHistory(context.Background(), "uid-a", "", 20, 0)
	require.NoError(t, err)
}

// The list note reads the same verified check create uses. A failed check reads as
// unverified, because nothing is emailed until the check works.
func TestPublicAlertsAddressNote(t *testing.T) {
	cases := []struct {
		name     string
		verified func(context.Context, string) (string, error)
		wantNote bool
	}{
		{"verified address: no note", func(context.Context, string) (string, error) { return "ben@shorted.com.au", nil }, false},
		{"unverified address: note", func(context.Context, string) (string, error) {
			return "", errors.New("the address on this account is not verified")
		}, true},
		{"failed lookup: note, since nothing can be emailed", func(context.Context, string) (string, error) {
			return "", errors.New("admin users: HTTP 503")
		}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := &publicAlertsSource{verifiedEmail: tc.verified}
			note := a.AddressNote(context.Background(), "uid-1")
			if tc.wantNote {
				assert.True(t, strings.Contains(note, "not emailed until your email address is verified"), note)
			} else {
				assert.Empty(t, note)
			}
		})
	}
}
