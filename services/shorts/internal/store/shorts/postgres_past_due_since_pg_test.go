package shorts

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestPastDueSinceAgainstPostgres pins how the store starts, keeps and clears the
// past-due run's failure time. The grace is anchored on that column, so a wrong
// write here is a wrong grace for every customer whose card fails.
func TestPastDueSinceAgainstPostgres(t *testing.T) {
	s := apiSubscriptionsTestStore(t)
	require.NoError(t, s.UpsertAPISubscription(&APISubscription{
		UserID: "uid_pd", UserEmail: "pd@example.com", StripeCustomerID: "cus_pd", StripeSubscriptionID: "sub_pd",
		Status: "active", Tier: "premium",
	}))
	pastDue := "past_due"
	active := "active"
	const firstFailure = "2026-10-03 09:00:00+00"
	const secondFailure = "2026-11-03 09:00:00+00"

	t.Run("the first past_due write starts the run at the failed charge", func(t *testing.T) {
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_pd", &APISubscriptionUpdate{
			Status: &pastDue, PastDueSince: new(firstFailure),
		}))
		assert.Equal(t, epochOf(t, firstFailure), *periodEpoch(t, s, "uid_pd", "past_due_since"))
	})

	t.Run("a later failed renewal keeps the run's original start", func(t *testing.T) {
		// Stripe moves the period on at each failed renewal, and each sync offers a
		// new failure time. The run started at the first one and must keep it.
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_pd", &APISubscriptionUpdate{
			Status: &pastDue, PastDueSince: new(secondFailure),
		}))
		assert.Equal(t, epochOf(t, firstFailure), *periodEpoch(t, s, "uid_pd", "past_due_since"))
	})

	t.Run("a write with no status leaves the run alone", func(t *testing.T) {
		const end = "2026-12-03 00:00:00+00"
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_pd", &APISubscriptionUpdate{
			CurrentPeriodEnd: new(end), PastDueSince: new(secondFailure),
		}))
		assert.Equal(t, epochOf(t, firstFailure), *periodEpoch(t, s, "uid_pd", "past_due_since"))
	})

	t.Run("returning to active clears the run", func(t *testing.T) {
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_pd", &APISubscriptionUpdate{Status: &active}))
		assert.Nil(t, periodEpoch(t, s, "uid_pd", "past_due_since"))
	})

	t.Run("a new run after recovery starts from its own failure", func(t *testing.T) {
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_pd", &APISubscriptionUpdate{
			Status: &pastDue, PastDueSince: new(secondFailure),
		}))
		assert.Equal(t, epochOf(t, secondFailure), *periodEpoch(t, s, "uid_pd", "past_due_since"))
	})

	t.Run("a past_due write with no failure time starts the run from now", func(t *testing.T) {
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_pd", &APISubscriptionUpdate{Status: &active}))
		before := time.Now().Unix()
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_pd", &APISubscriptionUpdate{Status: &pastDue}))
		got := *periodEpoch(t, s, "uid_pd", "past_due_since")
		assert.GreaterOrEqual(t, got, before-1)
		assert.LessOrEqual(t, got, time.Now().Unix()+1)
	})

	t.Run("a legacy past_due row with no start takes the failure time it is given", func(t *testing.T) {
		// Rows past_due before migration 000140 have no start. The next sync of such a
		// row must start it from the invoice, not from now.
		_, err := s.db.Exec(t.Context(), "UPDATE api_subscriptions SET past_due_since = NULL WHERE user_id = 'uid_pd'")
		require.NoError(t, err)
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_pd", &APISubscriptionUpdate{
			Status: &pastDue, PastDueSince: new(firstFailure),
		}))
		assert.Equal(t, epochOf(t, firstFailure), *periodEpoch(t, s, "uid_pd", "past_due_since"))
	})

	t.Run("the start is read back on the subscription lookups", func(t *testing.T) {
		got, err := s.GetAPISubscriptionByCustomer("cus_pd")
		require.NoError(t, err)
		require.NotNil(t, got)
		require.NotNil(t, got.PastDueSince)
		assert.Equal(t, epochOf(t, firstFailure), epochOf(t, *got.PastDueSince))
	})
}
