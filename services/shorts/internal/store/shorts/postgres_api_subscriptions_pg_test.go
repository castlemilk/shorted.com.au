package shorts

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// apiSubscriptionsTestBaseSchema is what migration 000015 needs before it runs:
// the trigger it attaches to api_subscriptions calls a function defined by an
// earlier migration. Only the trigger's effect matters to these tests.
const apiSubscriptionsTestBaseSchema = `
CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW.updated_at = CURRENT_TIMESTAMP;
	RETURN NEW;
END;
$$;
`

// apiSubscriptionsTestStore returns a store on a fresh database holding the real
// api_subscriptions table, created by migration 000015, so its UNIQUE constraints
// are the production ones. SHORTS_TEST_POSTGRES_URL names a disposable server, as
// for the other real-Postgres tests, and the test skips without it.
func apiSubscriptionsTestStore(t *testing.T) *postgresStore {
	t.Helper()
	adminURL := os.Getenv("SHORTS_TEST_POSTGRES_URL")
	if adminURL == "" {
		t.Skip("SHORTS_TEST_POSTGRES_URL not set; skipping the real-Postgres api_subscriptions tests")
	}
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}
	ctx := context.Background()
	pool := fundamentalsTestDatabase(t, ctx, adminURL)
	_, err := pool.Exec(ctx, apiSubscriptionsTestBaseSchema)
	require.NoError(t, err)

	for _, name := range []string{"000015_add_api_subscriptions.up.sql", "000140_add_past_due_since.up.sql"} {
		migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", name))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, string(migration))
		require.NoError(t, err)
	}

	return &postgresStore{db: pool}
}

// periodEpoch reads a period column as epoch seconds, so the assertions compare
// instants and not the session's text rendering. nil means NULL.
func periodEpoch(t *testing.T, s *postgresStore, userID, column string) *int64 {
	t.Helper()
	var epoch *int64
	err := s.db.QueryRow(context.Background(),
		"SELECT EXTRACT(EPOCH FROM "+column+")::bigint FROM api_subscriptions WHERE user_id = $1", userID,
	).Scan(&epoch)
	require.NoError(t, err)
	return epoch
}

func epochOf(t *testing.T, s string) int64 {
	t.Helper()
	parsed, err := time.Parse("2006-01-02 15:04:05-07", s)
	require.NoError(t, err)
	return parsed.Unix()
}

func TestUpsertAPISubscriptionAgainstPostgres(t *testing.T) {
	s := apiSubscriptionsTestStore(t)
	const periodStart = "2026-10-01 00:00:00+00"
	const periodEnd = "2026-11-01 00:00:00+00"

	t.Run("a write with no periods keeps the known periods", func(t *testing.T) {
		// The first write carries the periods, as a full read of Stripe does.
		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_keep", UserEmail: "keep@example.com", StripeCustomerID: "cus_keep", StripeSubscriptionID: "sub_keep",
			Status: "active", Tier: "premium", CurrentPeriodStart: new(periodStart), CurrentPeriodEnd: new(periodEnd),
		}))

		// The checkout write carries no periods. It must not null them out, and the
		// rest of the row must still take the new values.
		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_keep", UserEmail: "keep@example.com", StripeCustomerID: "cus_keep", StripeSubscriptionID: "sub_keep",
			Status: "active", Tier: "enterprise",
		}))

		start := periodEpoch(t, s, "uid_keep", "current_period_start")
		end := periodEpoch(t, s, "uid_keep", "current_period_end")
		require.NotNil(t, start)
		require.NotNil(t, end)
		assert.Equal(t, epochOf(t, periodStart), *start)
		assert.Equal(t, epochOf(t, periodEnd), *end)

		got, err := s.GetAPISubscription("uid_keep")
		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Equal(t, "enterprise", got.Tier)
	})

	t.Run("a write with a period replaces that period and keeps the other", func(t *testing.T) {
		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_replace", UserEmail: "replace@example.com", StripeCustomerID: "cus_replace", StripeSubscriptionID: "sub_replace",
			Status: "active", Tier: "premium", CurrentPeriodStart: new(periodStart), CurrentPeriodEnd: new(periodEnd),
		}))

		const renewedEnd = "2026-12-01 00:00:00+00"
		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_replace", UserEmail: "replace@example.com", StripeCustomerID: "cus_replace", StripeSubscriptionID: "sub_replace",
			Status: "active", Tier: "premium", CurrentPeriodEnd: new(renewedEnd),
		}))

		start := periodEpoch(t, s, "uid_replace", "current_period_start")
		end := periodEpoch(t, s, "uid_replace", "current_period_end")
		require.NotNil(t, start)
		require.NotNil(t, end)
		assert.Equal(t, epochOf(t, periodStart), *start, "the start was not sent, so it is kept")
		assert.Equal(t, epochOf(t, renewedEnd), *end, "the end was sent, so it is replaced")
	})

	t.Run("a first write with no periods leaves them unknown", func(t *testing.T) {
		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_fresh", UserEmail: "fresh@example.com", StripeCustomerID: "cus_fresh", StripeSubscriptionID: "sub_fresh",
			Status: "active", Tier: "premium",
		}))

		assert.Nil(t, periodEpoch(t, s, "uid_fresh", "current_period_start"))
		assert.Nil(t, periodEpoch(t, s, "uid_fresh", "current_period_end"))
	})

	t.Run("a new subscription from a second user replaces the stale row", func(t *testing.T) {
		// The first subscription has ended, and the customer checks out again under a
		// new uid. The new subscription id is what makes this a re-point.
		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_first", UserEmail: "first@example.com", StripeCustomerID: "cus_shared", StripeSubscriptionID: "sub_first",
			Status: "active", Tier: "premium", CurrentPeriodStart: new(periodStart), CurrentPeriodEnd: new(periodEnd),
		}))

		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_second", UserEmail: "second@example.com", StripeCustomerID: "cus_shared", StripeSubscriptionID: "sub_second",
			Status: "active", Tier: "enterprise",
		}))

		first, err := s.GetAPISubscription("uid_first")
		require.NoError(t, err)
		assert.Nil(t, first, "the row of the ended subscription is removed")

		second, err := s.GetAPISubscription("uid_second")
		require.NoError(t, err)
		require.NotNil(t, second)
		assert.Equal(t, "cus_shared", second.StripeCustomerID)
		assert.Equal(t, "sub_second", second.StripeSubscriptionID)
		assert.Equal(t, "enterprise", second.Tier)
		assert.Nil(t, periodEpoch(t, s, "uid_second", "current_period_end"), "the old subscription's period is not carried over")
	})

	t.Run("a write with no subscription id cannot re-point another user's row", func(t *testing.T) {
		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_holder", UserEmail: "holder@example.com", StripeCustomerID: "cus_nosub", StripeSubscriptionID: "sub_holder",
			Status: "active", Tier: "premium",
		}))

		err := s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_other", UserEmail: "other@example.com", StripeCustomerID: "cus_nosub",
			Status: "active", Tier: "premium",
		})
		require.Error(t, err)

		holder, err := s.GetAPISubscription("uid_holder")
		require.NoError(t, err)
		require.NotNil(t, holder, "a write that names no subscription must not remove the holder's row")

		other, err := s.GetAPISubscription("uid_other")
		require.NoError(t, err)
		assert.Nil(t, other)
	})

	t.Run("a row with no subscription id is re-pointed by a real subscription", func(t *testing.T) {
		// A row written before subscription ids were recorded. Only one row can hold
		// an empty id, because the column is unique.
		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_legacy", UserEmail: "legacy@example.com", StripeCustomerID: "cus_legacy",
			Status: "active", Tier: "premium",
		}))

		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_real", UserEmail: "real@example.com", StripeCustomerID: "cus_legacy", StripeSubscriptionID: "sub_real",
			Status: "active", Tier: "premium",
		}))

		legacy, err := s.GetAPISubscription("uid_legacy")
		require.NoError(t, err)
		assert.Nil(t, legacy)

		replacement, err := s.GetAPISubscription("uid_real")
		require.NoError(t, err)
		require.NotNil(t, replacement)
	})

	t.Run("a routine event for the same subscription from a stale user id changes nothing", func(t *testing.T) {
		// The subscription's row is under uid_new. A renewal for that same
		// subscription still carries the old uid.
		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_new", UserEmail: "new@example.com", StripeCustomerID: "cus_repoint", StripeSubscriptionID: "sub_repoint",
			Status: "active", Tier: "premium", CurrentPeriodStart: new(periodStart), CurrentPeriodEnd: new(periodEnd),
		}))

		require.NoError(t, s.UpsertAPISubscription(&APISubscription{
			UserID: "uid_old", UserEmail: "old@example.com", StripeCustomerID: "cus_repoint", StripeSubscriptionID: "sub_repoint",
			Status: "active", Tier: "premium",
		}))

		stale, err := s.GetAPISubscription("uid_old")
		require.NoError(t, err)
		assert.Nil(t, stale, "the stale uid gets no row")

		current, err := s.GetAPISubscription("uid_new")
		require.NoError(t, err)
		require.NotNil(t, current, "the row the subscription belongs to must survive")
		assert.Equal(t, "sub_repoint", current.StripeSubscriptionID)
		assert.Equal(t, epochOf(t, periodEnd), *periodEpoch(t, s, "uid_new", "current_period_end"))

		// The step that follows a renewal lands the true period on that row.
		const renewedEnd = "2026-12-01 00:00:00+00"
		renewed := "active"
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_repoint", &APISubscriptionUpdate{
			Status: &renewed, CurrentPeriodEnd: new(renewedEnd),
		}))
		assert.Equal(t, epochOf(t, renewedEnd), *periodEpoch(t, s, "uid_new", "current_period_end"))
	})
}

func TestUpdateAPISubscriptionByCustomerAgainstPostgres(t *testing.T) {
	s := apiSubscriptionsTestStore(t)
	require.NoError(t, s.UpsertAPISubscription(&APISubscription{
		UserID: "uid_a", UserEmail: "a@example.com", StripeCustomerID: "cus_a", StripeSubscriptionID: "sub_a",
		Status: "active", Tier: "premium",
	}))
	require.NoError(t, s.UpsertAPISubscription(&APISubscription{
		UserID: "uid_b", UserEmail: "b@example.com", StripeCustomerID: "cus_b", StripeSubscriptionID: "sub_b",
		Status: "active", Tier: "premium",
	}))

	t.Run("reaches the customer's row and no other", func(t *testing.T) {
		canceled := "canceled"
		cancel := true
		const end = "2026-11-01 00:00:00+00"
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_a", &APISubscriptionUpdate{
			Status: &canceled, CancelAtPeriodEnd: &cancel, CurrentPeriodEnd: new(end),
		}))

		a, err := s.GetAPISubscriptionByCustomer("cus_a")
		require.NoError(t, err)
		require.NotNil(t, a)
		assert.Equal(t, "canceled", a.Status)
		assert.True(t, a.CancelAtPeriodEnd)
		assert.Equal(t, epochOf(t, end), *periodEpoch(t, s, "uid_a", "current_period_end"))

		b, err := s.GetAPISubscriptionByCustomer("cus_b")
		require.NoError(t, err)
		require.NotNil(t, b)
		assert.Equal(t, "active", b.Status)
		assert.False(t, b.CancelAtPeriodEnd)
		assert.Nil(t, periodEpoch(t, s, "uid_b", "current_period_end"))
	})

	t.Run("a customer with no row is a no-op", func(t *testing.T) {
		active := "active"
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_none", &APISubscriptionUpdate{Status: &active}))

		none, err := s.GetAPISubscriptionByCustomer("cus_none")
		require.NoError(t, err)
		assert.Nil(t, none)
	})
}
