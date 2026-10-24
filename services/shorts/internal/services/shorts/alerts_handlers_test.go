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
	"github.com/castlemilk/shorted.com.au/services/pkg/unsubscribe"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"google.golang.org/protobuf/reflect/protoreflect"
)

const (
	alertTestMonitorID = "11111111-1111-1111-1111-111111111111"
	alertTestSecret    = "test-unsubscribe-secret"
)

// --- create: target validation ---------------------------------------------

func TestCreateAlertMonitor_CanonicalisesIndustryTarget(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	mockStore.EXPECT().CanonicalIndustry("materials").Return("Materials", true, nil)
	mockStore.EXPECT().
		CreateAlertMonitor(gomock.Any()).
		DoAndReturn(func(input shortsstore.CreateAlertMonitorInput) (*shortsstore.AlertMonitor, error) {
			require.Equal(t, "Materials", input.Target, "an industry is stored under its canonical spelling")
			return &shortsstore.AlertMonitor{ID: "alert_1", UserID: "user_1", Scope: input.Scope, Target: input.Target, Condition: input.Condition, Cadence: input.Cadence, Status: "active"}, nil
		})

	srv := newTestServer(t, mockStore)
	resp, err := srv.CreateAlertMonitor(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:     shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_INDUSTRY,
		Target:    "materials",
		Condition: shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_NEW_TOP_TEN_ENTRY,
		Cadence:   shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
	}))
	require.NoError(t, err)
	assert.Equal(t, "Materials", resp.Msg.Monitor.Target)
}

func TestCreateAlertMonitor_RejectsUnknownIndustryAndSavesNothing(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	// Placeholders and misspellings both come back as not found from the store.
	mockStore.EXPECT().CanonicalIndustry("Mterials").Return("", false, nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.CreateAlertMonitor(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:     shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_INDUSTRY,
		Target:    "Mterials",
		Condition: shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_NEW_TOP_TEN_ENTRY,
		Cadence:   shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	assert.ErrorContains(t, err, "Unknown industry: choose one listed on Industry Intelligence")
}

func TestCreateAlertMonitor_IndustryLookupErrorIsInternal(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	mockStore.EXPECT().CanonicalIndustry("Materials").Return("", false, errors.New("connection refused"))

	srv := newTestServer(t, mockStore)
	_, err := srv.CreateAlertMonitor(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:     shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_INDUSTRY,
		Target:    "Materials",
		Condition: shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_NEW_TOP_TEN_ENTRY,
		Cadence:   shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
}

func TestCreateAlertMonitor_RejectsUnknownASXCodeAndSavesNothing(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	mockStore.EXPECT().StockCodeKnown("NOPE").Return(false, nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.CreateAlertMonitor(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.CreateAlertMonitorRequest{
		Scope:        shortsv1alpha1.AlertMonitorScope_ALERT_MONITOR_SCOPE_STOCK,
		Target:       "nope",
		Condition:    shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE,
		Threshold:    5,
		HasThreshold: true,
		Cadence:      shortsv1alpha1.AlertMonitorCadence_ALERT_MONITOR_CADENCE_DAILY,
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

// --- list events -----------------------------------------------------------

func TestListAlertEvents_MapsPayloadAndDeliveryStatus(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	payload := []byte(`{"companies":[` +
		`{"code":"AAA","name":"Aaa Resources Ltd","latest":5.2,"previous":4.8,"change":0.4,"rank":0,"previous_rank":0},` +
		`{"code":"NEW","name":"New Listing Ltd","latest":7,"previous":null,"change":null,"rank":2,"previous_rank":0}],` +
		`"companies_total":2}`)
	created := time.Date(2026, 10, 16, 1, 0, 0, 0, time.UTC)

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListAlertEvents("user_1", "", int32(20), int32(0)).Return([]*shortsstore.AlertEvent{
		{
			ID: 7, MonitorID: alertTestMonitorID, Scope: "industry", Target: "Materials",
			Condition: "new_top_ten_entry", Cadence: "daily",
			ReportDate: "2026-10-16", ComparedToDate: "2026-10-15",
			Payload: payload, EmailStatus: "sending", CreatedAt: created,
		},
	}, int32(1), nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListAlertEvents(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.ListAlertEventsRequest{}))
	require.NoError(t, err)
	require.Equal(t, int32(1), resp.Msg.TotalCount)
	require.Len(t, resp.Msg.Events, 1)

	event := resp.Msg.Events[0]
	assert.Equal(t, "7", event.Id)
	assert.Equal(t, "2026-10-16", event.ReportDate)
	assert.Equal(t, "2026-10-15", event.ComparedToDate)
	assert.Equal(t, shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_PENDING, event.DeliveryStatus, "a send in flight reads as pending")
	assert.Equal(t, int32(2), event.CompaniesTotal)
	require.Len(t, event.Companies, 2)

	aaa := event.Companies[0]
	assert.Equal(t, "AAA", aaa.ProductCode)
	assert.InDelta(t, 4.8, aaa.PreviousPercent, 0.0001)
	assert.True(t, aaa.HasPrevious)
	assert.InDelta(t, 0.4, aaa.ChangePoints, 0.0001)
	assert.True(t, aaa.HasChange)

	newcomer := event.Companies[1]
	assert.False(t, newcomer.HasPrevious, "a company with no earlier reading has no previous")
	assert.False(t, newcomer.HasChange)
	assert.Equal(t, int32(2), newcomer.Rank)
	assert.Equal(t, int32(0), newcomer.PreviousRank, "0 means not ranked")

	// The API never returns the delivery internals, so none of them can leak.
	fields := (&shortsv1alpha1.AlertEvent{}).ProtoReflect().Descriptor().Fields()
	for _, name := range []string{"last_error", "resend_id", "user_email", "email_attempts"} {
		assert.Nil(t, fields.ByName(protoreflect.Name(name)), "AlertEvent must not expose %s", name)
	}
}

func TestListAlertEvents_EveryStatusMapsToOneDeliveryState(t *testing.T) {
	cases := map[string]shortsv1alpha1.AlertDeliveryStatus{
		"pending":            shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_PENDING,
		"sending":            shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_PENDING,
		"sent":               shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SENT,
		"failed":             shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_FAILED,
		"skipped_unentitled": shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SKIPPED_UNENTITLED,
		"skipped_no_email":   shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SKIPPED_NO_EMAIL,
		"skipped_paused":     shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SKIPPED_PAUSED,
		"not_a_status":       shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_UNSPECIFIED,
	}
	for in, want := range cases {
		assert.Equal(t, want, alertDeliveryStatusFromStore(in), in)
	}
}

func TestListAlertEvents_RejectsBadMonitorIDWithoutReadingStore(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.ListAlertEvents(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.ListAlertEventsRequest{MonitorId: "not-a-uuid"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestListAlertEvents_PassesMonitorFilterAndClampsLimit(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListAlertEvents("user_1", alertTestMonitorID, int32(100), int32(0)).Return(nil, int32(0), nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListAlertEvents(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.ListAlertEventsRequest{
		MonitorId: alertTestMonitorID,
		Limit:     500,
	}))
	require.NoError(t, err)
	assert.Empty(t, resp.Msg.Events)
}

func TestListAlertEvents_MalformedPayloadDoesNotBlankTheList(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListAlertEvents("user_1", "", int32(20), int32(0)).Return([]*shortsstore.AlertEvent{
		{ID: 9, MonitorID: alertTestMonitorID, Scope: "stock", Target: "BHP", Condition: "short_interest_above",
			Cadence: "daily", ReportDate: "2026-10-16", ComparedToDate: "2026-10-15",
			Payload: []byte("not json"), EmailStatus: "sent", CreatedAt: time.Now()},
	}, int32(1), nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListAlertEvents(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.ListAlertEventsRequest{}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Events, 1)
	assert.Empty(t, resp.Msg.Events[0].Companies)
	assert.Equal(t, shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SENT, resp.Msg.Events[0].DeliveryStatus)
}

// --- update status ---------------------------------------------------------

func TestUpdateAlertMonitorStatus_PauseNeedsNoSubscription(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// No GetAPISubscription expectation: a pause that read entitlement would fail
	// the test, which is the point. A lapsed customer must always be able to stop.
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		UpdateAlertMonitorStatus("user_1", alertTestMonitorID, "paused", "ben@shorted.com.au").
		Return(&shortsstore.AlertMonitor{ID: alertTestMonitorID, UserID: "user_1", Status: "paused", Scope: "stock", Target: "BHP", Condition: "short_interest_above", Cadence: "daily"}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.UpdateAlertMonitorStatus(userContext(""), connect.NewRequest(&shortsv1alpha1.UpdateAlertMonitorStatusRequest{
		Id:     alertTestMonitorID,
		Status: shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_PAUSED,
	}))
	require.NoError(t, err)
	assert.Equal(t, shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_PAUSED, resp.Msg.Monitor.Status)
}

func TestUpdateAlertMonitorStatus_ResumeRequiresPremium(t *testing.T) {
	tests := []struct {
		name string
		sub  *shortsstore.APISubscription
	}{
		{"no subscription", nil},
		{"free tier", activeRow("free")},
		{"canceled", &shortsstore.APISubscription{UserID: "user_1", Status: "canceled", Tier: "premium"}},
		{"period ended", periodEndedRow("premium")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			// No UpdateAlertMonitorStatus expectation: a denied resume must not write.
			mockStore := mocks.NewMockShortsStore(ctrl)
			expectSubscriptionRow(mockStore, tc.sub)

			srv := newTestServer(t, mockStore)
			_, err := srv.UpdateAlertMonitorStatus(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.UpdateAlertMonitorStatusRequest{
				Id:     alertTestMonitorID,
				Status: shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_ACTIVE,
			}))
			require.Error(t, err)
			assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
			assert.ErrorContains(t, err, alertsNeedPremium)
		})
	}
}

func TestUpdateAlertMonitorStatus_ResumeWhenEntitled(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	mockStore.EXPECT().
		UpdateAlertMonitorStatus("user_1", alertTestMonitorID, "active", "ben@shorted.com.au").
		Return(&shortsstore.AlertMonitor{ID: alertTestMonitorID, UserID: "user_1", Status: "active"}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.UpdateAlertMonitorStatus(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.UpdateAlertMonitorStatusRequest{
		Id:     alertTestMonitorID,
		Status: shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_ACTIVE,
	}))
	require.NoError(t, err)
	assert.Equal(t, shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_ACTIVE, resp.Msg.Monitor.Status)
}

func TestUpdateAlertMonitorStatus_ResumeConflictIsAlreadyExists(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, activeRow("premium"))
	mockStore.EXPECT().
		UpdateAlertMonitorStatus(gomock.Any(), gomock.Any(), gomock.Any(), gomock.Any()).
		Return(nil, shortsstore.ErrAlertMonitorExists)

	srv := newTestServer(t, mockStore)
	_, err := srv.UpdateAlertMonitorStatus(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.UpdateAlertMonitorStatusRequest{
		Id:     alertTestMonitorID,
		Status: shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_ACTIVE,
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeAlreadyExists, connect.CodeOf(err))
}

func TestUpdateAlertMonitorStatus_AnotherUsersMonitorIsNotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		UpdateAlertMonitorStatus("user_1", alertTestMonitorID, "paused", gomock.Any()).
		Return(nil, shortsstore.ErrAlertMonitorNotFound)

	srv := newTestServer(t, mockStore)
	_, err := srv.UpdateAlertMonitorStatus(userContext(""), connect.NewRequest(&shortsv1alpha1.UpdateAlertMonitorStatusRequest{
		Id:     alertTestMonitorID,
		Status: shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_PAUSED,
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}

func TestUpdateAlertMonitorStatus_RejectsBadIDAndUnspecifiedStatus(t *testing.T) {
	tests := []struct {
		name   string
		id     string
		status shortsv1alpha1.AlertMonitorStatus
	}{
		{"not a uuid", "mon-1", shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_PAUSED},
		{"unspecified status", alertTestMonitorID, shortsv1alpha1.AlertMonitorStatus_ALERT_MONITOR_STATUS_UNSPECIFIED},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
			_, err := srv.UpdateAlertMonitorStatus(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.UpdateAlertMonitorStatusRequest{
				Id:     tc.id,
				Status: tc.status,
			}))
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		})
	}
}

// --- delete ----------------------------------------------------------------

func TestDeleteAlertMonitor_OwnMonitorIsDeleted(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().DeleteAlertMonitor("user_1", alertTestMonitorID).Return(nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.DeleteAlertMonitor(userContext(""), connect.NewRequest(&shortsv1alpha1.DeleteAlertMonitorRequest{Id: alertTestMonitorID}))
	require.NoError(t, err)
}

func TestDeleteAlertMonitor_AnotherUsersMonitorIsNotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().DeleteAlertMonitor("user_1", alertTestMonitorID).Return(shortsstore.ErrAlertMonitorNotFound)

	srv := newTestServer(t, mockStore)
	_, err := srv.DeleteAlertMonitor(userContext(""), connect.NewRequest(&shortsv1alpha1.DeleteAlertMonitorRequest{Id: alertTestMonitorID}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}

func TestDeleteAlertMonitor_RejectsBadIDWithoutTouchingStore(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.DeleteAlertMonitor(userContext(""), connect.NewRequest(&shortsv1alpha1.DeleteAlertMonitorRequest{Id: "x"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

// --- pause by token --------------------------------------------------------

func tokenServer(t *testing.T, store ShortsStore, secret string) *ShortsServer {
	t.Helper()
	srv := newTestServer(t, store)
	srv.unsubscribeSecret = secret
	return srv
}

func TestPauseAlertMonitorByToken_PausesWithoutASession(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().PauseAlertMonitorByID(alertTestMonitorID).Return(&shortsstore.AlertMonitor{
		ID: alertTestMonitorID, Scope: "stock", Target: "BHP", Condition: "short_interest_above",
		Threshold: new(float64(5)), Cadence: "daily", Status: "paused",
	}, false, nil)

	srv := tokenServer(t, mockStore, alertTestSecret)
	resp, err := srv.PauseAlertMonitorByToken(context.Background(), connect.NewRequest(&shortsv1alpha1.PauseAlertMonitorByTokenRequest{
		Token: unsubscribe.AlertMonitorToken(alertTestMonitorID, alertTestSecret),
	}))
	require.NoError(t, err)
	assert.False(t, resp.Msg.AlreadyPaused)
	assert.Equal(t, "BHP", resp.Msg.Target)
	assert.True(t, resp.Msg.HasThreshold)
	assert.InDelta(t, 5, resp.Msg.Threshold, 0.0001)
	assert.Equal(t, shortsv1alpha1.AlertMonitorCondition_ALERT_MONITOR_CONDITION_SHORT_INTEREST_ABOVE, resp.Msg.Condition)
}

func TestPauseAlertMonitorByToken_AlreadyPausedSaysSo(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().PauseAlertMonitorByID(alertTestMonitorID).Return(&shortsstore.AlertMonitor{
		ID: alertTestMonitorID, Scope: "industry", Target: "Materials", Condition: "new_top_ten_entry", Cadence: "weekly", Status: "paused",
	}, true, nil)

	srv := tokenServer(t, mockStore, alertTestSecret)
	resp, err := srv.PauseAlertMonitorByToken(context.Background(), connect.NewRequest(&shortsv1alpha1.PauseAlertMonitorByTokenRequest{
		Token: unsubscribe.AlertMonitorToken(alertTestMonitorID, alertTestSecret),
	}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.AlreadyPaused)
	assert.False(t, resp.Msg.HasThreshold, "a top-ten monitor has no threshold")
}

func TestPauseAlertMonitorByToken_RefusesTokensItMustNotAccept(t *testing.T) {
	tests := map[string]string{
		"garbage":          "garbage",
		"empty":            "",
		"newsletter token": tokenNewsletter(alertTestSecret),
		"unprefixed id":    tokenUnprefixed(alertTestSecret),
		"wrong secret":     unsubscribe.AlertMonitorToken(alertTestMonitorID, "some-other-secret"),
	}
	for name, token := range tests {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			// No PauseAlertMonitorByID expectation: a refused token never reaches the store.
			srv := tokenServer(t, mocks.NewMockShortsStore(ctrl), alertTestSecret)
			_, err := srv.PauseAlertMonitorByToken(context.Background(), connect.NewRequest(&shortsv1alpha1.PauseAlertMonitorByTokenRequest{Token: token}))
			require.Error(t, err)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		})
	}
}

func TestPauseAlertMonitorByToken_SecretUnsetIsInternal(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	srv := tokenServer(t, mocks.NewMockShortsStore(ctrl), "")
	_, err := srv.PauseAlertMonitorByToken(context.Background(), connect.NewRequest(&shortsv1alpha1.PauseAlertMonitorByTokenRequest{
		Token: unsubscribe.AlertMonitorToken(alertTestMonitorID, alertTestSecret),
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
}

func TestPauseAlertMonitorByToken_DeletedMonitorIsNotFound(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().PauseAlertMonitorByID(alertTestMonitorID).Return(nil, false, shortsstore.ErrAlertMonitorNotFound)

	srv := tokenServer(t, mockStore, alertTestSecret)
	_, err := srv.PauseAlertMonitorByToken(context.Background(), connect.NewRequest(&shortsv1alpha1.PauseAlertMonitorByTokenRequest{
		Token: unsubscribe.AlertMonitorToken(alertTestMonitorID, alertTestSecret),
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}

// --- list monitors: last event --------------------------------------------

func TestListAlertMonitors_ReportsLastEventAndCheckedThrough(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	lastReport := "2026-10-16"
	lastStatus := "skipped_unentitled"
	lastAt := time.Date(2026, 10, 16, 1, 0, 0, 0, time.UTC)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().RefreshAlertMonitorEmail("user_1", "ben@shorted.com.au").Return(nil)
	mockStore.EXPECT().ListAlertMonitors("user_1", int32(20), int32(0)).Return([]*shortsstore.AlertMonitor{
		{ID: alertTestMonitorID, UserID: "user_1", Scope: "stock", Target: "BHP", Condition: "short_interest_above",
			Threshold: new(float64(5)), Cadence: "daily", Status: "active", CreatedAt: lastAt, UpdatedAt: lastAt,
			LastEventReportDate: &lastReport, LastEventEmailStatus: &lastStatus, LastEventAt: &lastAt},
	}, int32(1), nil)
	mockStore.EXPECT().AlertCheckedThrough().Return("2026-10-16", nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListAlertMonitors(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.ListAlertMonitorsRequest{}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Monitors, 1)
	monitor := resp.Msg.Monitors[0]
	assert.Equal(t, "2026-10-16", monitor.LastEventReportDate)
	assert.Equal(t, shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_SKIPPED_UNENTITLED, monitor.LastDeliveryStatus)
	require.NotNil(t, monitor.LastEventAt)
	assert.Equal(t, lastAt.Unix(), monitor.LastEventAt.AsTime().Unix())
	assert.Equal(t, "2026-10-16", resp.Msg.CheckedThroughReportDate)
}

func TestListAlertMonitors_NeverFiredHasNoEventFields(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().RefreshAlertMonitorEmail("user_1", "ben@shorted.com.au").Return(nil)
	mockStore.EXPECT().ListAlertMonitors("user_1", int32(20), int32(0)).Return([]*shortsstore.AlertMonitor{
		{ID: alertTestMonitorID, UserID: "user_1", Scope: "stock", Target: "BHP", Condition: "short_interest_above",
			Threshold: new(float64(5)), Cadence: "daily", Status: "active", CreatedAt: time.Now(), UpdatedAt: time.Now()},
	}, int32(1), nil)
	mockStore.EXPECT().AlertCheckedThrough().Return("", nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListAlertMonitors(premiumUserContext(), connect.NewRequest(&shortsv1alpha1.ListAlertMonitorsRequest{}))
	require.NoError(t, err)
	monitor := resp.Msg.Monitors[0]
	assert.Empty(t, monitor.LastEventReportDate)
	assert.Equal(t, shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_UNSPECIFIED, monitor.LastDeliveryStatus)
	assert.Nil(t, monitor.LastEventAt)
	assert.Empty(t, resp.Msg.CheckedThroughReportDate, "before the first evaluator run there is no checked date")
}

// --- helpers ---------------------------------------------------------------

// tokenNewsletter is a valid newsletter token: the right secret, no alert prefix.
func tokenNewsletter(secret string) string {
	return unsubscribe.Sign("sub-123", secret)
}

// tokenUnprefixed is signed under the right secret but lacks the alert-monitor
// prefix, so it must not parse as an alert token.
func tokenUnprefixed(secret string) string {
	return unsubscribe.Sign(alertTestMonitorID, secret)
}
