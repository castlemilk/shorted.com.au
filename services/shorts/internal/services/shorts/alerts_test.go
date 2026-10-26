package shorts

import (
	"context"
	"errors"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestCreateAlertMonitor_SavesPremiumStockMonitor(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	mockStore.EXPECT().StockCodeKnown("BHP").Return(true, nil)
	now := time.Now().UTC()
	mockStore.EXPECT().
		CreateAlertMonitor(gomock.Any()).
		DoAndReturn(func(input shortsstore.CreateAlertMonitorInput) (*shortsstore.AlertMonitor, error) {
			require.Equal(t, "user_1", input.UserID)
			require.Equal(t, "ben@shorted.com.au", input.UserEmail)
			require.Equal(t, "stock", input.Scope)
			require.Equal(t, "BHP", input.Target)
			require.Equal(t, "short_interest_above", input.Condition)
			require.NotNil(t, input.Threshold)
			require.InDelta(t, 4.5, *input.Threshold, 0.001)
			require.Equal(t, "daily", input.Cadence)

			return &shortsstore.AlertMonitor{
				ID:        "alert_1",
				UserID:    input.UserID,
				UserEmail: input.UserEmail,
				Scope:     input.Scope,
				Target:    input.Target,
				Condition: input.Condition,
				Threshold: input.Threshold,
				Cadence:   input.Cadence,
				Status:    "active",
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		})

	srv := newTestServer(t, mockStore)
	resp, err := srv.CreateAlertMonitor(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:        shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK,
		Target:       " bhp ",
		Condition:    shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE,
		Threshold:    4.5,
		HasThreshold: true,
		Cadence:      shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
	}))

	require.NoError(t, err)
	require.NotNil(t, resp.Msg.Monitor)
	assert.Equal(t, "alert_1", resp.Msg.Monitor.Id)
	assert.Equal(t, "BHP", resp.Msg.Monitor.Target)
	assert.Equal(t, shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_ACTIVE, resp.Msg.Monitor.Status)
	assert.True(t, resp.Msg.Monitor.HasThreshold)
	assert.InDelta(t, 4.5, resp.Msg.Monitor.Threshold, 0.001)
	require.NotNil(t, resp.Msg.Monitor.CreatedAt)
	assert.Equal(t, now.Unix(), resp.Msg.Monitor.CreatedAt.AsTime().Unix())
}

func TestCreateAlertMonitor_RequiresEntitlement(t *testing.T) {
	// Every case is denied before the monitor is written: the store's CreateAlertMonitor
	// has no expectation, so a gate that let one through would fail the test.
	tests := []struct {
		name string
		sub  *shortsstore.APISubscription
	}{
		{"no subscription", nil},
		{"free tier", activeRow("free")},
		{"canceled", &shortsstore.APISubscription{UserID: "user_1", Status: "canceled", Tier: "premium"}},
		{"period ended", periodEndedRow("premium")},
		// API Access is a paid API tier. It carries no premium web features, and alerts are one.
		{"API Access is paid but carries no premium alerts", activeRow("api_access")},
		{"past due API Access inside the grace carries no premium alerts", pastDueRow("api_access", pgTimestamp(time.Now().Add(-time.Hour)), nil)},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			mockStore := mocks.NewMockShortsStore(ctrl)
			expectSubscriptionRow(mockStore, tc.sub)
			srv := newTestServer(t, mockStore)

			_, err := srv.CreateAlertMonitor(userContext("premium"), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
				Scope:        shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK,
				Target:       "BHP",
				Condition:    shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE,
				Threshold:    5,
				HasThreshold: true,
				Cadence:      shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
			}))

			require.Error(t, err)
			assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
		})
	}
}

func TestCreateAlertMonitor_InternalGrantNeedsNoRow(t *testing.T) {
	// A granted user passes the gate without a store row, so the store is never
	// asked for one (no GetAPISubscription expectation is set).
	t.Setenv(InternalTierUsersEnv, "user_1")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().StockCodeKnown("BHP").Return(true, nil)
	mockStore.EXPECT().
		CreateAlertMonitor(gomock.Any()).
		Return(&shortsstore.AlertMonitor{ID: "alert_1", UserID: "user_1", Status: "active"}, nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.CreateAlertMonitor(userContext(""), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:        shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK,
		Target:       "BHP",
		Condition:    shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE,
		Threshold:    5,
		HasThreshold: true,
		Cadence:      shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
	}))
	require.NoError(t, err)
}

func TestCreateAlertMonitor_UnpaidInternalGrantIsDenied(t *testing.T) {
	// INTERNAL_TIER=free sets a rate-limit tier, not alert entitlement. No monitor is
	// written, and the store is never read for it (no expectations are set).
	t.Setenv(InternalTierUsersEnv, "user_1")
	t.Setenv(InternalTierEnv, "free")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.CreateAlertMonitor(userContext(""), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:        shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK,
		Target:       "BHP",
		Condition:    shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE,
		Threshold:    5,
		HasThreshold: true,
		Cadence:      shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
	}))

	require.Error(t, err)
	assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
}

func TestCreateAlertMonitor_StoreErrorIsNotAGrant(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetAPISubscription("user_1").Return(nil, errors.New("connection refused"))

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
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
}

func TestCreateAlertMonitor_RejectsInvalidStockTopTenMonitor(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	srv := newTestServer(t, mockStore)
	_, err := srv.CreateAlertMonitor(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:     shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK,
		Target:    "BHP",
		Condition: shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_NEW_TOP_TEN_ENTRY,
		Cadence:   shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
	}))

	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestCreateAlertMonitor_MapsDuplicateToAlreadyExists(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	mockStore.EXPECT().CanonicalIndustry("Materials").Return("Materials", true, nil)
	mockStore.EXPECT().
		CreateAlertMonitor(gomock.Any()).
		Return(nil, shortsstore.ErrAlertMonitorExists)

	srv := newTestServer(t, mockStore)
	_, err := srv.CreateAlertMonitor(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:     shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_INDUSTRY,
		Target:    "Materials",
		Condition: shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_NEW_TOP_TEN_ENTRY,
		Cadence:   shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_WEEKLY,
	}))

	require.Error(t, err)
	assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err))
}

func TestListAlertMonitors_DefaultsLimitAndMapsRows(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	now := time.Now().UTC()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().RefreshAlertMonitorEmail("user_1", "ben@shorted.com.au").Return(nil)
	mockStore.EXPECT().
		ListAlertMonitors("user_1", int32(20), int32(0)).
		Return([]*shortsstore.AlertMonitor{
			{
				ID:        "alert_1",
				UserID:    "user_1",
				Scope:     "industry",
				Target:    "Materials",
				Condition: "new_top_ten_entry",
				Cadence:   "daily",
				Status:    "active",
				CreatedAt: now,
				UpdatedAt: now,
			},
		}, int32(1), nil)

	mockStore.EXPECT().AlertCheckedThrough().Return("2026-10-22", nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListAlertMonitors(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.ListAlertMonitorsRequest{}))

	require.NoError(t, err)
	assert.Equal(t, int32(1), resp.Msg.TotalCount)
	assert.Equal(t, "2026-10-22", resp.Msg.CheckedThroughReportDate)
	require.Len(t, resp.Msg.Monitors, 1)
	assert.Equal(t, "Materials", resp.Msg.Monitors[0].Target)
	assert.Equal(t, shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_NEW_TOP_TEN_ENTRY, resp.Msg.Monitors[0].Condition)
}

func premiumUserContext() context.Context {
	return userContext("premium")
}

// userContext is a signed-in user whose address is verified, the normal case.
func userContext(tier string) context.Context {
	return context.WithValue(context.Background(), userKey, &Claims{
		UserID:        "user_1",
		Email:         "ben@shorted.com.au",
		EmailVerified: true,
		Tier:          tier,
	})
}

// unverifiedUserContext is the same user before the address is verified.
func unverifiedUserContext(tier string) context.Context {
	return context.WithValue(context.Background(), userKey, &Claims{
		UserID: "user_1",
		Email:  "ben@shorted.com.au",
		Tier:   tier,
	})
}
