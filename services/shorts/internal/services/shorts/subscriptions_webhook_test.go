package shorts

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/types/known/timestamppb"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// webhookTestServer is newTestServer with the info log the webhook writes, which
// newTestServer's logger does not expect.
func webhookTestServer(t *testing.T, store ShortsStore) *ShortsServer {
	t.Helper()
	s := newTestServer(t, store)
	logger := mocks.NewMockLogger(gomock.NewController(t))
	logger.EXPECT().Infof(gomock.Any(), gomock.Any()).AnyTimes()
	logger.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
	s.logger = logger
	return s
}

// A subscription-updated event carries the subscription the web resolved as the
// customer's best one. The store write must receive it, or the row keeps naming
// whichever subscription created it.
func TestHandleStripeSubscriptionUpdatedPassesTheResolvedSubscriptionID(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	var got *shortsstore.APISubscriptionUpdate
	store.EXPECT().UpdateAPISubscriptionByCustomer("cus_1", gomock.Any()).DoAndReturn(
		func(_ string, update *shortsstore.APISubscriptionUpdate) error {
			got = update
			return nil
		})

	s := webhookTestServer(t, store)
	_, err := s.HandleStripeSubscriptionUpdated(context.Background(), connect.NewRequest(&shortsv1alpha1.HandleStripeSubscriptionUpdatedRequest{
		StripeCustomerId:     "cus_1",
		StripeSubscriptionId: "sub_best",
		Status:               shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.StripeSubscriptionID == nil || *got.StripeSubscriptionID != "sub_best" {
		t.Fatalf("update = %+v, want the resolved subscription id written", got)
	}
	if got.Status == nil || *got.Status != "active" {
		t.Fatalf("status = %v, want active", got.Status)
	}
}

// A deleted subscription that the web still names as the customer's best one is
// written as canceled under its own id, not dropped.
func TestHandleStripeSubscriptionUpdatedWritesTheIdOnDeletion(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	var got *shortsstore.APISubscriptionUpdate
	store.EXPECT().UpdateAPISubscriptionByCustomer("cus_1", gomock.Any()).DoAndReturn(
		func(_ string, update *shortsstore.APISubscriptionUpdate) error {
			got = update
			return nil
		})

	s := webhookTestServer(t, store)
	if _, err := s.HandleStripeSubscriptionUpdated(context.Background(), connect.NewRequest(&shortsv1alpha1.HandleStripeSubscriptionUpdatedRequest{
		StripeCustomerId:     "cus_1",
		StripeSubscriptionId: "sub_gone",
		IsDeleted:            true,
	})); err != nil {
		t.Fatal(err)
	}
	if got == nil || got.StripeSubscriptionID == nil || *got.StripeSubscriptionID != "sub_gone" || *got.Status != "canceled" {
		t.Fatalf("update = %+v, want canceled under sub_gone", got)
	}
}

// With no id on the event the update does not invent one.
func TestHandleStripeSubscriptionUpdatedLeavesTheIdAloneWhenBlank(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	var got *shortsstore.APISubscriptionUpdate
	store.EXPECT().UpdateAPISubscriptionByCustomer("cus_1", gomock.Any()).DoAndReturn(
		func(_ string, update *shortsstore.APISubscriptionUpdate) error {
			got = update
			return nil
		})

	s := webhookTestServer(t, store)
	if _, err := s.HandleStripeSubscriptionUpdated(context.Background(), connect.NewRequest(&shortsv1alpha1.HandleStripeSubscriptionUpdatedRequest{
		StripeCustomerId: "cus_1",
		Status:           shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE,
	})); err != nil {
		t.Fatal(err)
	}
	if got == nil || got.StripeSubscriptionID != nil {
		t.Fatalf("update = %+v, want no subscription id", got)
	}
}

// The failure time of a past-due run reaches the store only as the event carries it,
// and only the store decides from it. A status write without one sends nothing.
func TestHandleStripeSubscriptionUpdatedCarriesTheFailureTime(t *testing.T) {
	failed := time.Date(2026, 10, 3, 9, 0, 0, 0, time.UTC)
	cases := []struct {
		name      string
		status    shortsv1alpha1.SubscriptionStatus
		failedAt  *timestamppb.Timestamp
		wantSince string
	}{
		{"a past_due write carries the failed charge", shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_PAST_DUE, timestamppb.New(failed), failed.Format(time.RFC3339)},
		{"an active write carries no failure time", shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE, nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mocks.NewMockShortsStore(ctrl)
			var got *shortsstore.APISubscriptionUpdate
			store.EXPECT().UpdateAPISubscriptionByCustomer("cus_1", gomock.Any()).DoAndReturn(
				func(_ string, update *shortsstore.APISubscriptionUpdate) error {
					got = update
					return nil
				})
			s := webhookTestServer(t, store)
			_, err := s.HandleStripeSubscriptionUpdated(context.Background(), connect.NewRequest(&shortsv1alpha1.HandleStripeSubscriptionUpdatedRequest{
				StripeCustomerId:     "cus_1",
				StripeSubscriptionId: "sub_1",
				Status:               tc.status,
				PastDueSince:         tc.failedAt,
			}))
			if err != nil {
				t.Fatal(err)
			}
			if tc.wantSince == "" {
				if got.PastDueSince != nil {
					t.Fatalf("PastDueSince = %q, want none", *got.PastDueSince)
				}
				return
			}
			if got.PastDueSince == nil || *got.PastDueSince != tc.wantSince {
				t.Fatalf("PastDueSince = %v, want %s", got.PastDueSince, tc.wantSince)
			}
		})
	}
}

// The status response carries the failure time the web and the alerts job grace from.
func TestGetMySubscription_PastDueCarriesTheFailureTime(t *testing.T) {
	failed := time.Now().Add(-2 * 24 * time.Hour).UTC().Truncate(time.Second)
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	row := pastDueRow("premium", pgTimestamp(failed), pgTimestamp(time.Now().Add(20*24*time.Hour)))
	expectSubscriptionRow(mockStore, row)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetMySubscription(subscriptionContext("user_1"), connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{}))
	require.NoError(t, err)
	require.NotNil(t, resp.Msg.PastDueSince)
	assert.True(t, resp.Msg.PastDueSince.AsTime().Equal(failed), "past_due_since = %v, want %v", resp.Msg.PastDueSince.AsTime(), failed)
}
