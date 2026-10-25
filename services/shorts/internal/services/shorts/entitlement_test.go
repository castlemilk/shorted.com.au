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

// periodEndedRow is active by status but four days past its period end, beyond
// the grace, the shape a lost cancellation or renewal webhook leaves behind.
func periodEndedRow(tier string) *shortsstore.APISubscription {
	return storeRow("active", tier, pgTimestamp(time.Now().Add(-96*time.Hour)))
}

// pgTimestamp renders t the way PostgreSQL's text form does for a timestamptz.
func pgTimestamp(t time.Time) *string {
	s := t.UTC().Format("2006-01-02 15:04:05-07")
	return &s
}

// pastDueRow is a past_due row whose first failed charge was at since. periodEnd
// is the row's period end, which Stripe moves forward at every failed renewal, so
// the grace must not read it.
func pastDueRow(tier string, since, periodEnd *string) *shortsstore.APISubscription {
	r := storeRow("past_due", tier, periodEnd)
	r.PastDueSince = since
	return r
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
			name:   "past due with no period end cannot be bounded, so it grants nothing",
			userID: "user_1",
			sub:    storeRow("past_due", "premium", nil),
			want:   denied("status_past_due", "stripe"),
		},
		{
			name:   "past due inside the 14 day grace from the failed charge keeps paid access",
			userID: "user_1",
			sub:    pastDueRow("premium", at(-13*24*time.Hour), at(20*24*time.Hour)),
			want:   Entitlement{Entitled: true, Tier: "premium", Reason: "past_due_grace", Source: "stripe"},
		},
		{
			name:   "past due inside the grace on the API Access tier keeps its API access",
			userID: "user_1",
			sub:    pastDueRow("api_access", at(-1*time.Hour), at(20*24*time.Hour)),
			want:   Entitlement{Entitled: true, Tier: "api_access", Reason: "past_due_grace", Source: "stripe"},
		},
		{
			name:   "past due past 14 days from the failed charge ends, even with a future period end",
			userID: "user_1",
			sub:    pastDueRow("premium", at(-15*24*time.Hour), at(20*24*time.Hour)),
			want:   denied("past_due_grace_ended", "stripe"),
		},
		{
			name:   "past due with no failure time has no grace, however far the period end runs",
			userID: "user_1",
			sub:    storeRow("past_due", "premium", at(20*24*time.Hour)),
			want:   denied("status_past_due", "stripe"),
		},
		{
			name:   "past due on an unpaid tier grants nothing even inside the grace",
			userID: "user_1",
			sub:    storeRow("past_due", "free", at(-1*time.Hour)),
			want:   denied("unpaid_tier", "stripe"),
		},
		{
			name:   "unpaid grants nothing, even with a period end in the future",
			userID: "user_1",
			sub:    storeRow("unpaid", "premium", at(24*time.Hour)),
			want:   denied("status_unpaid", "stripe"),
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
			// The grace is inclusive at its edge: exactly 72 hours past is still entitled.
			name:   "period ended exactly at the grace edge",
			userID: "user_1",
			sub:    storeRow("active", "premium", at(-72*time.Hour)),
			want:   entitled("premium"),
		},
		{
			// A one-to-three day webhook outage must not revoke a paying customer.
			name:   "period ended 71 hours ago is inside the grace",
			userID: "user_1",
			sub:    storeRow("active", "premium", at(-71*time.Hour)),
			want:   entitled("premium"),
		},
		{
			name:   "period ended 73 hours ago is past the grace",
			userID: "user_1",
			sub:    storeRow("active", "premium", at(-73*time.Hour)),
			want:   denied("period_ended", "stripe"),
		},
		{
			name:   "status and tier are matched case and padding insensitively",
			userID: "user_1",
			sub:    storeRow(" Trialing ", "  PRO ", nil),
			want:   entitled("pro"),
		},
		{
			name:   "hand-written Premium tier is paid and reported lowercase",
			userID: "user_1",
			sub:    storeRow("Active", "Premium", nil),
			want:   entitled("premium"),
		},
		{
			name:   "canceled in capitals is still reported as the status",
			userID: "user_1",
			sub:    storeRow("CANCELED", "premium", nil),
			want:   denied("status_canceled", "stripe"),
		},
		{
			name:   "Free in capitals is an unpaid tier",
			userID: "user_1",
			sub:    storeRow("active", "FREE", nil),
			want:   denied("unpaid_tier", "stripe"),
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
// A past_due row's period end moves forward at every failed renewal, so a card that
// keeps failing keeps a future period end. The grace must end at 14 days from the
// first failed charge however far that period end runs.
func TestPastDueGraceEndsWithTheFailedChargeNotTheRenewal(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	periodEnd := pgTimestamp(now.Add(11 * 24 * time.Hour))
	cases := []struct {
		name         string
		firstFailure time.Duration
	}{
		{"one failed renewal, 20 days ago", -20 * 24 * time.Hour},
		{"card failing for 50 days", -50 * 24 * time.Hour},
		{"seven failed renewals", -210 * 24 * time.Hour},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			since := pgTimestamp(now.Add(tc.firstFailure))
			ent := ResolveEntitlement("user_1", pastDueRow("premium", since, periodEnd), now)
			assert.False(t, ent.Entitled, "entitled (%s) past 14 days from the first failed charge", ent.Reason)
		})
	}
}

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
			inside := now.Add(-71 * time.Hour).In(tc.loc).Format(tc.layout)
			past := now.Add(-73 * time.Hour).In(tc.loc).Format(tc.layout)

			got := ResolveEntitlement("user_1", storeRow("active", "premium", &inside), now)
			assert.True(t, got.Entitled, "period ended 71h ago, rendered %q, should be inside the grace", inside)

			got = ResolveEntitlement("user_1", storeRow("active", "premium", &past), now)
			assert.Equal(t, "period_ended", got.Reason, "period ended 73h ago, rendered %q", past)
			assert.False(t, got.Entitled)
		})
	}
}

func TestResolveEntitlementUnpaidGrantIsNotEntitlement(t *testing.T) {
	// INTERNAL_TIER=free is a documented option. A grant on an unpaid tier sets the
	// rate-limit tier and nothing more, so paid features stay off.
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	unpaid := Entitlement{Tier: "free", Reason: "internal_grant_unpaid_tier", Source: "internal"}

	tests := []struct {
		name string
		tier string
		sub  *shortsstore.APISubscription
		want Entitlement
	}{
		{"no row", "free", nil, unpaid},
		{"over a paid row, which the grant decides", "free", activeRow("premium"), unpaid},
		{"padded and capitalised", " Free ", nil, unpaid},
		{"paid grant, padded and capitalised", " Premium ", nil,
			Entitlement{Entitled: true, Tier: "premium", Reason: "internal_grant", Source: "internal"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(InternalTierUsersEnv, "grant_user")
			t.Setenv(InternalTierEnv, tc.tier)

			got := ResolveEntitlement("grant_user", tc.sub, now)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestSubscriptionTierUnpaidGrantSkipsTheStore(t *testing.T) {
	// The rate-limit tier of an unpaid grant is the granted tier, and it needs no row.
	t.Setenv(InternalTierUsersEnv, "grant_user")
	t.Setenv(InternalTierEnv, "free")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	tier, err := srv.subscriptionTier("grant_user")
	require.NoError(t, err)
	assert.Equal(t, "free", tier)
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

	// The grant is the whole answer for entitlement. The store is read best-effort for
	// the portal ids, and this user has none.
	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, nil)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.HasSubscription)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE, resp.Msg.Status)
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_ENTERPRISE, resp.Msg.Tier)
	assert.Empty(t, resp.Msg.StripeCustomerId)
	assert.Nil(t, resp.Msg.CurrentPeriodEnd)
	assert.False(t, resp.Msg.CancelAtPeriodEnd)
}

func TestGetMySubscription_InternalGrantKeepsThePortalIds(t *testing.T) {
	// A grant user who also pays through Stripe must still reach the billing portal,
	// which is keyed on the Stripe ids of the row.
	t.Setenv(InternalTierUsersEnv, "user_1")
	t.Setenv(InternalTierEnv, "enterprise")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	periodEnd := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	row := storeRow("active", "premium", pgTimestamp(periodEnd))
	row.CancelAtPeriodEnd = true

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, row)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.HasSubscription)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE, resp.Msg.Status)
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_ENTERPRISE, resp.Msg.Tier)
	assert.Equal(t, "cus_1", resp.Msg.StripeCustomerId)
	assert.True(t, resp.Msg.CancelAtPeriodEnd)
	require.NotNil(t, resp.Msg.CurrentPeriodEnd)
	assert.True(t, periodEnd.Equal(resp.Msg.CurrentPeriodEnd.AsTime()))
}

func TestGetMySubscription_InternalGrantSurvivesStoreError(t *testing.T) {
	// The grant decides entitlement, so a failed row read costs only the portal ids.
	// It must not fail the RPC.
	t.Setenv(InternalTierUsersEnv, "user_1")
	t.Setenv(InternalTierEnv, "enterprise")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetAPISubscription("user_1").Return(nil, errors.New("connection refused"))
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE, resp.Msg.Status)
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_ENTERPRISE, resp.Msg.Tier)
	assert.Empty(t, resp.Msg.StripeCustomerId)
}

func TestGetMySubscription_UnpaidGrantIsInactiveOnItsTier(t *testing.T) {
	// INTERNAL_TIER=free is a documented option. It must not read as an active
	// subscription, but the portal ids of a paying row still come through.
	t.Setenv(InternalTierUsersEnv, "user_1")
	t.Setenv(InternalTierEnv, "free")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, storeRow("active", "premium", nil))
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.True(t, resp.Msg.HasSubscription)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_INACTIVE, resp.Msg.Status)
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_FREE, resp.Msg.Tier)
	assert.Equal(t, "cus_1", resp.Msg.StripeCustomerId)
}

func TestGetMySubscription_NormalisesARowWrittenByHand(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	mockStore := mocks.NewMockShortsStore(ctrl)
	expectSubscriptionRow(mockStore, storeRow(" Active ", "Premium", nil))
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	assert.Equal(t, shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE, resp.Msg.Status)
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_PREMIUM, resp.Msg.Tier)
}

func TestGetMySubscription_PeriodEndedActiveRowDoesNotReportActive(t *testing.T) {
	t.Setenv(InternalTierUsersEnv, "")
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	periodEnd := time.Now().Add(-96 * time.Hour).Truncate(time.Second)
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

// The API Access plan has its own tier on the wire and in the row. A mapping that
// dropped it would write the plan as an unknown tier, which grants nothing.
func TestAPIAccessTierRoundTrips(t *testing.T) {
	tier := mapStringToTier("api_access")
	assert.Equal(t, shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_API_ACCESS, tier)
	assert.Equal(t, "api_access", mapTierToString(tier))
}
