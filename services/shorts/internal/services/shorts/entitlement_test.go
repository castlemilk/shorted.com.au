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

// storeRow is the row the store returns for user_1. periodEnd is in the text form
// the store hands over, so the tests exercise the same parsing production does.
func storeRow(status, tier string, periodEnd *string) *shortsstore.APISubscription {
	return &shortsstore.APISubscription{
		UserID:               "user_1",
		UserEmail:            "ben@shorted.com.au",
		StripeCustomerID:     "cus_1",
		StripeSubscriptionID: "sub_1",
		Status:               status,
		Tier:                 tier,
		CurrentPeriodEnd:     periodEnd,
	}
}

func activeRow(tier string) *shortsstore.APISubscription {
	return storeRow("active", tier, nil)
}

// periodEndedRow is active by status but three days past its period end, the
// shape a lost cancellation or renewal webhook leaves behind.
func periodEndedRow(tier string) *shortsstore.APISubscription {
	return storeRow("active", tier, pgTimestamp(time.Now().Add(-72*time.Hour)))
}

// pgTimestamp renders t the way PostgreSQL's text form does for a timestamptz.
func pgTimestamp(t time.Time) *string {
	s := t.UTC().Format("2006-01-02 15:04:05-07")
	return &s
}

// expectSubscriptionRow stubs the one store read the entitlement makes for user_1.
func expectSubscriptionRow(mockStore *mocks.MockShortsStore, sub *shortsstore.APISubscription) {
	mockStore.EXPECT().GetAPISubscription("user_1").Return(sub, nil)
}

func TestResolveEntitlement(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "grant_user")
	t.Setenv(InternalTierEnv, "enterprise")
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) *string { return pgTimestamp(now.Add(d)) }
	str := func(s string) *string { return &s }

	entitled := func(tier string) Entitlement {
		return Entitlement{Entitled: true, Tier: tier, Reason: "active", Source: "stripe"}
	}
	denied := func(reason, source string) Entitlement {
		return Entitlement{Tier: "free", Reason: reason, Source: source}
	}

	tests := []struct {
		name   string
		userID string
		sub    *shortsstore.APISubscription
		want   Entitlement
	}{
		{
			name:   "internal grant with no row",
			userID: "grant_user",
			want:   Entitlement{Entitled: true, Tier: "enterprise", Reason: "internal_grant", Source: "internal"},
		},
		{
			name:   "internal grant beats a canceled row",
			userID: "grant_user",
			sub:    storeRow("canceled", "premium", nil),
			want:   Entitlement{Entitled: true, Tier: "enterprise", Reason: "internal_grant", Source: "internal"},
		},
		{
			name:   "no subscription",
			userID: "user_1",
			want:   denied("no_subscription", "none"),
		},
		{
			name:   "active premium, no period end",
			userID: "user_1",
			sub:    activeRow("premium"),
			want:   entitled("premium"),
		},
		{
			name:   "active premium, period in the future",
			userID: "user_1",
			sub:    storeRow("active", "premium", at(30*24*time.Hour)),
			want:   entitled("premium"),
		},
		{
			name:   "trialing pro",
			userID: "user_1",
			sub:    storeRow("trialing", "pro", nil),
			want:   entitled("pro"),
		},
		{
			name:   "active enterprise",
			userID: "user_1",
			sub:    storeRow("active", "enterprise", nil),
			want:   entitled("enterprise"),
		},
		{
			name:   "active api_access",
			userID: "user_1",
			sub:    storeRow("active", "api_access", nil),
			want:   entitled("api_access"),
		},
		{
			name:   "canceled",
			userID: "user_1",
			sub:    storeRow("canceled", "premium", nil),
			want:   denied("status_canceled", "stripe"),
		},
		{
			name:   "past due",
			userID: "user_1",
			sub:    storeRow("past_due", "premium", nil),
			want:   denied("status_past_due", "stripe"),
		},
		{
			name:   "inactive",
			userID: "user_1",
			sub:    storeRow("inactive", "premium", nil),
			want:   denied("status_inactive", "stripe"),
		},
		{
			name:   "canceled and period ended reports the status first",
			userID: "user_1",
			sub:    storeRow("canceled", "premium", at(-72*time.Hour)),
			want:   denied("status_canceled", "stripe"),
		},
		{
			name:   "active on the free tier",
			userID: "user_1",
			sub:    storeRow("active", "free", nil),
			want:   denied("unpaid_tier", "stripe"),
		},
		{
			name:   "active on an unknown tier",
			userID: "user_1",
			sub:    storeRow("active", "basic", nil),
			want:   denied("unpaid_tier", "stripe"),
		},
		{
			name:   "active with no tier",
			userID: "user_1",
			sub:    storeRow("active", "", nil),
			want:   denied("unpaid_tier", "stripe"),
		},
		{
			// The grace is inclusive at its edge: exactly 24 hours past is still entitled.
			name:   "period ended exactly at the grace edge",
			userID: "user_1",
			sub:    storeRow("active", "premium", at(-24*time.Hour)),
			want:   entitled("premium"),
		},
		{
			name:   "period ended 23 hours ago is inside the grace",
			userID: "user_1",
			sub:    storeRow("active", "premium", at(-23*time.Hour)),
			want:   entitled("premium"),
		},
		{
			name:   "period ended 25 hours ago is past the grace",
			userID: "user_1",
			sub:    storeRow("active", "premium", at(-25*time.Hour)),
			want:   denied("period_ended", "stripe"),
		},
		{
			// An unparseable period end is unknown, not expired. See ResolveEntitlement.
			name:   "unparseable period end is unknown",
			userID: "user_1",
			sub:    storeRow("active", "premium", str("not a timestamp")),
			want:   entitled("premium"),
		},
		{
			name:   "empty period end is unknown",
			userID: "user_1",
			sub:    storeRow("active", "premium", str("")),
			want:   entitled("premium"),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveEntitlement(tc.userID, tc.sub, now)
			assert.Equal(t, tc.want, got)
		})
	}
}

// The store can hand the period end over in several renderings, and each one has
// to land on the same side of the grace.
func TestResolveEntitlementReadsEveryStoreTimestampLayout(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "")
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	aest := time.FixedZone("AEST", 10*60*60)

	tests := []struct {
		name   string
		layout string
		loc    *time.Location
	}{
		{"postgres text, fractional seconds", "2006-01-02 15:04:05.999999-07", time.UTC},
		{"postgres text, hour offset", "2006-01-02 15:04:05-07", time.UTC},
		{"postgres text, non-UTC offset", "2006-01-02 15:04:05-07", aest},
		{"postgres text, offset with minutes", "2006-01-02 15:04:05-07:00", aest},
		{"postgres text, no offset", "2006-01-02 15:04:05", time.UTC},
		{"rfc3339", time.RFC3339, time.UTC},
		{"rfc3339 nano", time.RFC3339Nano, time.UTC},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			inside := now.Add(-23 * time.Hour).In(tc.loc).Format(tc.layout)
			past := now.Add(-25 * time.Hour).In(tc.loc).Format(tc.layout)

			got := ResolveEntitlement("user_1", storeRow("active", "premium", &inside), now)
			assert.True(t, got.Entitled, "period ended 23h ago, rendered %q, should be inside the grace", inside)

			got = ResolveEntitlement("user_1", storeRow("active", "premium", &past), now)
			assert.Equal(t, "period_ended", got.Reason, "period ended 25h ago, rendered %q", past)
			assert.False(t, got.Entitled)
		})
	}
}

func TestSubscriptionTierFollowsTheEntitlementRule(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "grant_user")
	t.Setenv(InternalTierEnv, "enterprise")

	tests := []struct {
		name string
		sub  *shortsstore.APISubscription
		want string
	}{
		{"active premium", storeRow("active", "premium", pgTimestamp(time.Now().Add(30*24*time.Hour))), "premium"},
		{"period ended", periodEndedRow("premium"), "free"},
		{"canceled", storeRow("canceled", "premium", nil), "free"},
		{"no subscription", nil, "free"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			mockStore := mocks.NewMockShortsStore(ctrl)
			expectSubscriptionRow(mockStore, tc.sub)
			srv := newTestServer(t, mockStore)

			tier, err := srv.subscriptionTier("user_1")
			require.NoError(t, err)
			assert.Equal(t, tc.want, tier)
		})
	}
}

func TestSubscriptionTierGrantSkipsTheStore(t *testing.T) {
	// No expectation is set, so a read of the store fails the test. A grant must not
	// depend on the database.
	t.Setenv(InternalTierUsersEnv, "grant_user")
	t.Setenv(InternalTierEnv, "enterprise")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	tier, err := srv.subscriptionTier("grant_user")
	require.NoError(t, err)
	assert.Equal(t, "enterprise", tier)
}

func TestSubscriptionTierStoreErrorGrantsNothing(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "grant_user")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetAPISubscription("user_1").Return(nil, errors.New("connection refused"))
	srv := newTestServer(t, mockStore)

	tier, err := srv.subscriptionTier("user_1")
	require.Error(t, err)
	assert.Empty(t, tier)
}

func subscriptionContext(userID string) context.Context {
	return context.WithValue(context.Background(), userKey, &Claims{
		UserID: userID,
		Email:  "ben@shorted.com.au",
	})
}

func TestGetMySubscription_InternalGrantReportsActiveOnGrantedTier(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "user_1")
	t.Setenv(InternalTierEnv, "enterprise")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	// No row and no store read: the grant is the whole answer.
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.HasSubscription)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE, resp.Msg.Status)
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_ENTERPRISE, resp.Msg.Tier)
	assert.Empty(t, resp.Msg.StripeCustomerId)
	assert.Nil(t, resp.Msg.CurrentPeriodEnd)
	assert.False(t, resp.Msg.CancelAtPeriodEnd)
}

func TestGetMySubscription_PeriodEndedActiveRowDoesNotReportActive(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	periodEnd := time.Now().Add(-72 * time.Hour).Truncate(time.Second)
	row := storeRow("active", "premium", pgTimestamp(periodEnd))
	row.CancelAtPeriodEnd = true

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, row)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.HasSubscription)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_INACTIVE, resp.Msg.Status)
	// The real Stripe fields survive, so the customer can still reach the portal.
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_PREMIUM, resp.Msg.Tier)
	assert.Equal(t, "cus_1", resp.Msg.StripeCustomerId)
	assert.True(t, resp.Msg.CancelAtPeriodEnd)
	require.NotNil(t, resp.Msg.CurrentPeriodEnd)
	assert.True(t, periodEnd.Equal(resp.Msg.CurrentPeriodEnd.AsTime()))
}

func TestGetMySubscription_ActiveRowInsideGraceKeepsRealFields(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	periodEnd := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, storeRow("active", "premium", pgTimestamp(periodEnd)))
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.HasSubscription)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE, resp.Msg.Status)
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_PREMIUM, resp.Msg.Tier)
	assert.Equal(t, "cus_1", resp.Msg.StripeCustomerId)
	require.NotNil(t, resp.Msg.CurrentPeriodEnd)
	assert.True(t, periodEnd.Equal(resp.Msg.CurrentPeriodEnd.AsTime()))
}

func TestGetMySubscription_ActiveRowOnUnpaidTierDoesNotReportActive(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, storeRow("active", "free", nil))
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.HasSubscription)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_INACTIVE, resp.Msg.Status)
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_FREE, resp.Msg.Tier)
}

func TestGetMySubscription_CanceledRowKeepsItsStatus(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, storeRow("canceled", "premium", nil))
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.HasSubscription)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_CANCELED, resp.Msg.Status)
}

func TestGetMySubscription_NoRowIsFree(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, nil)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.False(t, resp.Msg.HasSubscription)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_INACTIVE, resp.Msg.Status)
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_FREE, resp.Msg.Tier)
}

func TestGetMySubscription_StoreErrorIsInternalNotAGrant(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetAPISubscription("user_1").Return(nil, errors.New("connection refused"))
	srv := newTestServer(t, mockStore)

	_, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInternal, connect.CodeOf(err))
}
