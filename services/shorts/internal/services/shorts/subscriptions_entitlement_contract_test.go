package shorts

import (
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

// TestGetMySubscriptionAgreesWithResolveEntitlement pins the alert entitlement
// rule to the subscription RPC.
//
// The shorted alerts evaluator (services/jobs/internal/jobs/alerts/entitlement.go)
// emails an owner only when GetMySubscription reports ACTIVE or TRIALING. This
// test runs every branch of ResolveEntitlement through the RPC and fails if the
// two disagree. Change the mapping on either side and this test breaks next to
// the code that changed.
func TestGetMySubscriptionAgreesWithResolveEntitlement(t *testing.T) {
	now := time.Now()
	ago := func(d time.Duration) *string { return pgTimestamp(now.Add(-d)) }
	unparseable := "not a timestamp"

	tests := []struct {
		name         string
		grantTier    string // when set, user_1 holds an internal grant on this tier
		sub          *shortsstore.APISubscription
		wantEntitled bool
	}{
		{name: "internal paid grant", grantTier: "premium", wantEntitled: true},
		{name: "internal unpaid grant (INTERNAL_TIER=free)", grantTier: "free", wantEntitled: false},
		{name: "no subscription row", sub: nil, wantEntitled: false},
		{name: "active premium", sub: activeRow("premium"), wantEntitled: true},
		{name: "trialing premium", sub: storeRow("trialing", "premium", nil), wantEntitled: true},
		{name: "active on an unpaid tier", sub: activeRow("free"), wantEntitled: false},
		{name: "canceled premium", sub: storeRow("canceled", "premium", nil), wantEntitled: false},
		{name: "past due premium", sub: storeRow("past_due", "premium", nil), wantEntitled: false},
		{name: "active, period ended beyond the grace", sub: periodEndedRow("premium"), wantEntitled: false},
		{name: "active, period ended within the grace", sub: storeRow("active", "premium", ago(24*time.Hour)), wantEntitled: true},
		{name: "active, unparseable period end", sub: storeRow("active", "premium", &unparseable), wantEntitled: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.grantTier != "" {
				t.Setenv(InternalTierUsersEnv, "user_1")
				t.Setenv(InternalTierEnv, tc.grantTier)
			}

			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			mockStore := mocks.NewMockShortsStore(ctrl)
			// A grant reads the row best-effort for the billing portal, so the store
			// may be asked for it on that path too.
			mockStore.EXPECT().GetAPISubscription("user_1").Return(tc.sub, nil).AnyTimes()

			srv := newTestServer(t, mockStore)
			resp, err := srv.GetMySubscription(userContext("premium"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
			require.NoError(t, err)

			ent := ResolveEntitlement("user_1", tc.sub, time.Now())
			active := resp.Msg.Status == shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE ||
				resp.Msg.Status == shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_TRIALING

			assert.Equal(t, tc.wantEntitled, ent.Entitled, "ResolveEntitlement's answer for this branch")
			assert.Equal(t, ent.Entitled, active,
				"alerts entitlement (ResolveEntitlement) and GetMySubscription status %v must agree", resp.Msg.Status)
		})
	}
}
