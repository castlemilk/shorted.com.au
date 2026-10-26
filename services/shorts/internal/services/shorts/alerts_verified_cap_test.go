package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// Alert mail goes only to a verified address. The web tier checks this for its own
// calls; these tests pin the API's own enforcement, which a Firebase token, an API
// token or a direct internal call reaches without the web tier.

func TestAlertEmailFor(t *testing.T) {
	cases := []struct {
		name   string
		claims *Claims
		want   string
	}{
		{"no claims", nil, ""},
		{"unverified address", &Claims{Email: "a@example.com"}, ""},
		{"verified address", &Claims{Email: "a@example.com", EmailVerified: true}, "a@example.com"},
		{"verified flag without an address", &Claims{EmailVerified: true}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, alertEmailFor(tc.claims))
		})
	}
}

// A token is data the caller can edit, so the verified flag must never come from one.
// The field is tagged json:"-", and an explicit email_verified claim is ignored.
func TestClaimsEmailVerifiedIsNeverReadFromAToken(t *testing.T) {
	var c Claims
	require.NoError(t, json.Unmarshal([]byte(`{"user_id":"u","email":"a@example.com","email_verified":true,"EmailVerified":true}`), &c))
	assert.Equal(t, "a@example.com", c.Email)
	assert.False(t, c.EmailVerified, "a token must not be able to claim its address is verified")
}

func TestEmailVerifiedFromFirebaseClaims(t *testing.T) {
	cases := []struct {
		name   string
		claims map[string]any
		want   bool
	}{
		{"verified boolean", map[string]any{"email_verified": true}, true},
		{"unverified boolean", map[string]any{"email_verified": false}, false},
		{"string true is not verified", map[string]any{"email_verified": "true"}, false},
		{"claim absent", map[string]any{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, emailVerifiedFromFirebaseClaims(tc.claims))
		})
	}
}

// The internal branch trusts x-user-email-verified only. Other web callers send
// x-user-email for their own reasons, so the address alone proves nothing.
func TestInternalCallerIsEmailVerifiedOnlyWhenTheWebAssertsIt(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "test-internal-secret")
	cases := []struct {
		name  string
		extra map[string]string
		want  bool
	}{
		{"the alerts transport asserts verification", map[string]string{"x-user-email-verified": "true"}, true},
		{"a bare address is not verification", nil, false},
		{"an explicit false", map[string]string{"x-user-email-verified": "false"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen *Claims
			srv := adminRPC(t, AuthInterceptorOptions{}, &seen)
			headers := map[string]string{
				"x-internal-secret": "test-internal-secret",
				"x-user-id":         "uid-owner",
				"x-user-email":      "owner@example.com",
				"x-user-roles":      "admin",
			}
			maps.Copy(headers, tc.extra)
			_, err := callRPC[shortsv1alpha1.GetSyncStatusRequest, shortsv1alpha1.GetSyncStatusResponse](t, srv,
				getSyncStatusProcedure, &shortsv1alpha1.GetSyncStatusRequest{}, headers, "")
			require.NoError(t, err)
			require.NotNil(t, seen)
			assert.Equal(t, "owner@example.com", seen.Email)
			assert.Equal(t, tc.want, seen.EmailVerified)
		})
	}
}

func TestCreateAlertMonitor_UnverifiedAddressIsNotStored(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	mockStore.EXPECT().StockCodeKnown("BHP").Return(true, nil)
	mockStore.EXPECT().
		CreateAlertMonitor(gomock.Any()).
		DoAndReturn(func(input shortsstore.CreateAlertMonitorInput) (*shortsstore.AlertMonitor, error) {
			require.Empty(t, input.UserEmail, "an unverified address must never be stored as the alert address")
			return &shortsstore.AlertMonitor{ID: "alert_1", UserID: input.UserID, Scope: input.Scope, Target: input.Target, Condition: input.Condition, Cadence: input.Cadence, Status: "active"}, nil
		})

	srv := newTestServer(t, mockStore)
	_, err := srv.CreateAlertMonitor(unverifiedUserContext("premium"), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:        shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK,
		Target:       "BHP",
		Condition:    shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE,
		Threshold:    5,
		HasThreshold: true,
		Cadence:      shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
	}))
	require.NoError(t, err)
}

func TestUpdateAlertMonitorStatus_UnverifiedResumeNeverWritesAnAddress(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	// The empty address tells the store to keep the stored one.
	mockStore.EXPECT().
		UpdateAlertMonitorStatus("user_1", alertTestMonitorID, "active", "").
		Return(&shortsstore.AlertMonitor{ID: alertTestMonitorID, UserID: "user_1", Status: "active"}, nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.UpdateAlertMonitorStatus(unverifiedUserContext("premium"), connect.NewRequest(&shortsv1alpha1.UpdateAlertMonitorStatusRequest{
		Id:     alertTestMonitorID,
		Status: shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_ACTIVE,
	}))
	require.NoError(t, err)
}

// The list refreshes the stored address only from a verified one. With no refresh
// expectation, any call to RefreshAlertMonitorEmail fails the test.
func TestListAlertMonitors_UnverifiedNeverRefreshesTheAddress(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListAlertMonitors("user_1", int32(20), int32(0)).Return(nil, int32(0), nil)
	mockStore.EXPECT().AlertCheckedThrough().Return("", nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.ListAlertMonitors(unverifiedUserContext("premium"), connect.NewRequest(&shortsv1alpha1.ListAlertMonitorsRequest{}))
	require.NoError(t, err)
}

// A refresh that fails is logged, and the list still loads.
func TestListAlertMonitors_FailedRefreshStillLoadsTheList(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().RefreshAlertMonitorEmail("user_1", "ben@shorted.com.au").Return(errors.New("store down"))
	mockStore.EXPECT().ListAlertMonitors("user_1", int32(20), int32(0)).Return(nil, int32(0), nil)
	mockStore.EXPECT().AlertCheckedThrough().Return("", nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.ListAlertMonitors(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.ListAlertMonitorsRequest{}))
	require.NoError(t, err)
}

func TestCreateAlertMonitor_AtTheCapIsResourceExhausted(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	mockStore.EXPECT().StockCodeKnown("BHP").Return(true, nil)
	mockStore.EXPECT().CreateAlertMonitor(gomock.Any()).Return(nil, shortsstore.ErrAlertMonitorLimit)

	srv := newTestServer(t, mockStore)
	_, err := srv.CreateAlertMonitor(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:        shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK,
		Target:       "BHP",
		Condition:    shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE,
		Threshold:    5,
		HasThreshold: true,
		Cadence:      shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
	assert.ErrorContains(t, err, "You already have 50 active alerts. Pause or delete one to add another.")
}

func TestUpdateAlertMonitorStatus_ResumeAtTheCapIsResourceExhausted(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	mockStore.EXPECT().
		UpdateAlertMonitorStatus("user_1", alertTestMonitorID, "active", "ben@shorted.com.au").
		Return(nil, shortsstore.ErrAlertMonitorLimit)

	srv := newTestServer(t, mockStore)
	_, err := srv.UpdateAlertMonitorStatus(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.UpdateAlertMonitorStatusRequest{
		Id:     alertTestMonitorID,
		Status: shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_ACTIVE,
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
	assert.ErrorContains(t, err, "before resuming this one")
}

// An API token carries an address, and it can say that address is verified. Through
// the real interceptor, neither makes the address verified: the bespoke branch never
// sets EmailVerified, so an alert cannot be routed to an unverified inbox by minting a
// token. Only the Firebase branch (its email_verified claim) or the alerts transport's
// explicit header can.
func TestBespokeAPITokenIsNeverEmailVerified(t *testing.T) {
	setAdminCutover(t, time.Now().Add(-time.Hour))

	// PauseAlertMonitorByToken is public and role-free, so a valid bearer token reaches
	// the handler with its claims resolved, which is what this test reads.
	const publicProcedure = "/shorts.v1alpha1.AlertsService/PauseAlertMonitorByToken"
	var seen *Claims
	srv := serveRPC(t, publicProcedure, AuthInterceptorOptions{},
		func(ctx context.Context, _ *connect.Request[shortsv1alpha1.PauseAlertMonitorByTokenRequest]) (*connect.Response[shortsv1alpha1.PauseAlertMonitorByTokenResponse], error) {
			seen, _ = UserFromContext(ctx)
			return connect.NewResponse(&shortsv1alpha1.PauseAlertMonitorByTokenResponse{}), nil
		})

	token := bespokeToken(t, Claims{
		ExpiresAt:     jwt.NewNumericDate(time.Now().Add(time.Hour)),
		UserID:        "uid-1",
		Email:         "victim@example.com",
		EmailVerified: true, // a token cannot assert this; the json tag is "-"
		Roles:         []string{"api-user"},
	})
	if _, err := callRPC[shortsv1alpha1.PauseAlertMonitorByTokenRequest, shortsv1alpha1.PauseAlertMonitorByTokenResponse](t, srv,
		publicProcedure, &shortsv1alpha1.PauseAlertMonitorByTokenRequest{Token: "x"}, nil, token); err != nil {
		t.Fatalf("public call with a valid bespoke token: %v", err)
	}
	if seen == nil || seen.Email != "victim@example.com" {
		t.Fatalf("the interceptor did not resolve the bespoke token's claims: %+v", seen)
	}
	if seen.EmailVerified {
		t.Fatal("a bespoke API token must never make its address verified")
	}
}

// A user who is unverified at one list and verified at the next gets the address
// backfilled onto the monitors they already have, with no re-creation. Each request's
// claims decide, so nothing from the first sign-in is kept.
func TestListAlertMonitors_BackfillsTheAddressOnceTheAccountIsVerified(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	gomock.InOrder(
		// Unverified: the list loads and nothing is refreshed.
		mockStore.EXPECT().ListAlertMonitors("user_1", int32(20), int32(0)).Return(nil, int32(0), nil),
		mockStore.EXPECT().AlertCheckedThrough().Return("", nil),
		// Verified on the next request: the refresh runs before the list.
		mockStore.EXPECT().RefreshAlertMonitorEmail("user_1", "ben@shorted.com.au").Return(nil),
		mockStore.EXPECT().ListAlertMonitors("user_1", int32(20), int32(0)).Return(nil, int32(0), nil),
		mockStore.EXPECT().AlertCheckedThrough().Return("", nil),
	)

	srv := newTestServer(t, mockStore)
	_, err := srv.ListAlertMonitors(unverifiedUserContext("premium"), connect.NewRequest(&shortsv1alpha1.ListAlertMonitorsRequest{}))
	require.NoError(t, err)
	_, err = srv.ListAlertMonitors(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.ListAlertMonitorsRequest{}))
	require.NoError(t, err)
}
