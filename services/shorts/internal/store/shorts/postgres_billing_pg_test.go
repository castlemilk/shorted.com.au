package shorts

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Real-Postgres check of the billing audit reads (postgres_billing.go). The
// schema is the real migrations for api_subscriptions (000015 and 000149), the chat
// tables (000026) and api_usage_monthly (000112); chat_usage_events is the ledger from
// the chat-limits branch (migration 000145), which this branch does not carry.
//
// Env-gated: it needs an admin DSN to a DISPOSABLE server, creates an isolated
// database and drops it afterwards.
//
//	SHORTS_TEST_POSTGRES_URL='postgres://postgres:postgres@127.0.0.1:55439/postgres?sslmode=disable' \
//	  GOWORK=off go test ./shorts/internal/store/shorts/ -run TestBillingReadsAgainstPostgres -v
func TestBillingReadsAgainstPostgres(t *testing.T) {
	adminURL := os.Getenv("SHORTS_TEST_POSTGRES_URL")
	if adminURL == "" {
		t.Skip("SHORTS_TEST_POSTGRES_URL not set; skipping the real-Postgres billing reads test")
	}
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}
	ctx := context.Background()
	pool := fundamentalsTestDatabase(t, ctx, adminURL)
	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err)
	}
	migration := func(name string) {
		t.Helper()
		sql, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", name))
		require.NoError(t, err)
		exec(string(sql))
	}

	// 000015 calls update_updated_at_column, which an earlier migration defines.
	exec(`CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN NEW.updated_at = now(); RETURN NEW; END $$`)
	migration("000015_add_api_subscriptions.up.sql")
	migration("000026_add_chat_tables.up.sql")
	migration("000112_add_api_usage_monthly.up.sql")
	// The store reads past_due_since with every subscription row (migration 000149).
	migration("000149_add_past_due_since.up.sql")

	now := time.Now().UTC()
	// Rows are seeded by hand so every flag the audit reads is set on purpose.
	exec(`INSERT INTO api_subscriptions (user_id, user_email, stripe_customer_id, stripe_subscription_id, status, tier,
		current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) VALUES
	  ('uid-a', 'Ada@Example.com', 'cus_A', 'sub_A', 'active', 'premium', now() - interval '5 days', now() + interval '20 days', false, now() - interval '30 days', now() - interval '2 hours'),
	  ('uid-b', 'bob@example.com', 'cus_B', 'sub_B', 'past_due', 'premium', NULL, now() + interval '3 days', true, now() - interval '60 days', now() - interval '1 day')`)
	// 51 rows on one email, past the per-subject cap of 50.
	exec(`INSERT INTO api_subscriptions (user_id, user_email, status, tier, created_at, updated_at)
	  SELECT 'bulk-' || lpad(g::text, 2, '0'), 'many@example.com', 'canceled', 'premium', now(), now() - (g || ' minutes')::interval
	  FROM generate_series(1, 51) g`)

	store := &postgresStore{db: pool}

	t.Run("mirror rows by user id and by email", func(t *testing.T) {
		rows, truncated, err := store.BillingSubscriptionsFor(ctx, "uid-a", "")
		require.NoError(t, err)
		require.False(t, truncated)
		require.Len(t, rows, 1)
		require.Equal(t, "cus_A", rows[0].StripeCustomerID)
		require.Equal(t, "sub_A", rows[0].StripeSubscriptionID)
		require.NotNil(t, rows[0].CurrentPeriodEnd, "the period end must read as text for ResolveEntitlement")
		require.NotNil(t, rows[0].UpdatedAt)

		// Email match is case-insensitive, and the email is not the user id.
		rows, _, err = store.BillingSubscriptionsFor(ctx, "", "ADA@example.com")
		require.NoError(t, err)
		require.Len(t, rows, 1)
		require.Equal(t, "uid-a", rows[0].UserID)

		// Both keys: a row matched by either is returned once per row.
		rows, _, err = store.BillingSubscriptionsFor(ctx, "uid-b", "ada@example.com")
		require.NoError(t, err)
		require.Len(t, rows, 2)

		rows, _, err = store.BillingSubscriptionsFor(ctx, "", "")
		require.NoError(t, err)
		require.Empty(t, rows, "no key reads nothing, rather than every row")
	})

	t.Run("the per-subject cap reports truncation", func(t *testing.T) {
		rows, truncated, err := store.BillingSubscriptionsFor(ctx, "", "many@example.com")
		require.NoError(t, err)
		require.True(t, truncated)
		require.Len(t, rows, BillingRowsPerSubject)
		// Newest update first: bulk-01 was updated 1 minute ago, the rest older.
		require.Equal(t, "bulk-01", rows[0].UserID)
	})

	t.Run("all rows, bounded, with truncation", func(t *testing.T) {
		rows, truncated, err := store.BillingSubscriptionsAll(ctx, 2)
		require.NoError(t, err)
		require.True(t, truncated)
		require.Len(t, rows, 2)

		rows, truncated, err = store.BillingSubscriptionsAll(ctx, 1000)
		require.NoError(t, err)
		require.False(t, truncated)
		require.Len(t, rows, 53)
	})

	// Chat: two conversations for uid-a. One user message inside 30 days, one
	// outside it, and an assistant reply that is not the user's activity.
	exec(`INSERT INTO chat_conversations (id, user_id, created_at, updated_at) VALUES
	  ('00000000-0000-0000-0000-00000000000a', 'uid-a', now(), now()),
	  ('00000000-0000-0000-0000-00000000000b', 'uid-a', now(), now())`)
	exec(`INSERT INTO chat_messages (conversation_id, role, content, created_at) VALUES
	  ('00000000-0000-0000-0000-00000000000a', 'user', 'old question', now() - interval '40 days'),
	  ('00000000-0000-0000-0000-00000000000a', 'user', 'a question', now() - interval '3 days'),
	  ('00000000-0000-0000-0000-00000000000a', 'assistant', 'an answer', now() - interval '2 days'),
	  ('00000000-0000-0000-0000-00000000000b', 'user', 'latest question', now() - interval '1 hour')`)

	t.Run("chat usage counts the user's own messages", func(t *testing.T) {
		u, err := store.ChatUsage(ctx, []string{"uid-a"})
		require.NoError(t, err)
		require.Equal(t, 2, u.Conversations)
		require.Equal(t, 2, u.UserMessagesLast30Days, "the 40-day-old and the assistant messages are not counted")
		require.NotNil(t, u.LastUserMessageAt)
		require.WithinDuration(t, now.Add(-time.Hour), *u.LastUserMessageAt, 5*time.Minute)

		empty, err := store.ChatUsage(ctx, []string{"nobody"})
		require.NoError(t, err)
		require.Equal(t, 0, empty.Conversations)
		require.Nil(t, empty.LastUserMessageAt)
	})

	t.Run("chat_usage_events absent is reported, not read as zero", func(t *testing.T) {
		_, err := store.ChatUsageEvents(ctx, []string{"uid-a"})
		require.True(t, errors.Is(err, ErrRelationMissing), "a missing ledger must be ErrRelationMissing, got %v", err)
	})

	// The ledger as the chat-limits branch creates it (migration 000145).
	exec(`CREATE TABLE chat_usage_events (
		id BIGSERIAL PRIMARY KEY,
		user_id TEXT NOT NULL,
		conversation_id UUID,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'ok', 'error', 'limited', 'canceled')),
		input_tokens INT,
		output_tokens INT,
		tool_calls INT NOT NULL DEFAULT 0,
		model TEXT)`)
	exec(`INSERT INTO chat_usage_events (user_id, outcome, input_tokens, output_tokens, created_at) VALUES
	  ('uid-a', 'ok', 10, 20, now() - interval '1 day'),
	  ('uid-a', 'ok', 5, NULL, now() - interval '2 days'),
	  ('uid-a', 'error', NULL, NULL, now() - interval '3 days'),
	  ('uid-a', 'limited', NULL, NULL, now() - interval '4 days'),
	  ('uid-a', 'ok', 999, 999, now() - interval '40 days'),
	  ('uid-b', 'ok', 999, 999, now() - interval '1 day')`)

	t.Run("chat_usage_events counts sends by outcome and sums tokens", func(t *testing.T) {
		ev, err := store.ChatUsageEvents(ctx, []string{"uid-a"})
		require.NoError(t, err)
		require.Equal(t, map[string]int{"ok": 2, "error": 1, "limited": 1}, ev.SendsByOutcome)
		require.Equal(t, int64(15), ev.InputTokensLast30)
		require.Equal(t, int64(20), ev.OutputTokensLast30)
	})

	// Metered requests: the current and previous UTC months count; older months
	// and anonymous identifiers do not.
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	prev := monthStart.AddDate(0, -1, 0)
	older := monthStart.AddDate(0, -3, 0)
	exec(`INSERT INTO api_usage_monthly (identifier, period_month, request_count) VALUES
	  ('user:uid-a', '` + monthStart.Format("2006-01-02") + `', 7),
	  ('user:uid-a', '` + prev.Format("2006-01-02") + `', 3),
	  ('user:uid-a', '` + older.Format("2006-01-02") + `', 99),
	  ('ip:203.0.113.9', '` + monthStart.Format("2006-01-02") + `', 500)`)

	t.Run("api usage by month for the user's identifier", func(t *testing.T) {
		months, err := store.APIUsageByMonth(ctx, []string{"uid-a"})
		require.NoError(t, err)
		require.Len(t, months, 2)
		require.Equal(t, monthStart.Format("2006-01"), months[0].Month.Format("2006-01"))
		require.Equal(t, int64(7), months[0].Requests)
		require.Equal(t, prev.Format("2006-01"), months[1].Month.Format("2006-01"))
		require.Equal(t, int64(3), months[1].Requests)

		none, err := store.APIUsageByMonth(ctx, nil)
		require.NoError(t, err)
		require.Empty(t, none)
	})
}

// A Stripe event names the subscription the web resolved as the customer's best
// one, and the row must follow it. Before this write existed the id stayed at
// whatever the first checkout recorded, so a row could keep naming an ended
// subscription while its state came from the customer's current one.
func TestUpdateAPISubscriptionByCustomerWritesTheSubscriptionID(t *testing.T) {
	s := apiSubscriptionsTestStore(t)
	require.NoError(t, s.UpsertAPISubscription(&APISubscription{
		UserID: "uid_a", UserEmail: "a@example.com", StripeCustomerID: "cus_a", StripeSubscriptionID: "sub_old",
		Status: "canceled", Tier: "premium",
	}))
	require.NoError(t, s.UpsertAPISubscription(&APISubscription{
		UserID: "uid_b", UserEmail: "b@example.com", StripeCustomerID: "cus_b", StripeSubscriptionID: "sub_b",
		Status: "active", Tier: "premium",
	}))

	subscriptionIDOf := func(customer string) string {
		t.Helper()
		sub, err := s.GetAPISubscriptionByCustomer(customer)
		require.NoError(t, err)
		require.NotNil(t, sub)
		return sub.StripeSubscriptionID
	}

	t.Run("a given id replaces the stale one, and the state comes with it", func(t *testing.T) {
		active := "active"
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_a", &APISubscriptionUpdate{
			Status: &active, StripeSubscriptionID: new("sub_new"),
		}))
		assert.Equal(t, "sub_new", subscriptionIDOf("cus_a"))
		a, err := s.GetAPISubscriptionByCustomer("cus_a")
		require.NoError(t, err)
		assert.Equal(t, "active", a.Status)
	})

	t.Run("nil and blank leave the id alone", func(t *testing.T) {
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_a", &APISubscriptionUpdate{StripeSubscriptionID: nil}))
		assert.Equal(t, "sub_new", subscriptionIDOf("cus_a"))
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_a", &APISubscriptionUpdate{StripeSubscriptionID: new("")}))
		assert.Equal(t, "sub_new", subscriptionIDOf("cus_a"), "a blank id must never replace a real one")
	})

	t.Run("it reaches the customer's row and no other", func(t *testing.T) {
		require.NoError(t, s.UpdateAPISubscriptionByCustomer("cus_a", &APISubscriptionUpdate{StripeSubscriptionID: new("sub_newer")}))
		assert.Equal(t, "sub_newer", subscriptionIDOf("cus_a"))
		assert.Equal(t, "sub_b", subscriptionIDOf("cus_b"))
	})
}

// The rows that hold a Stripe customer are found by that customer, whatever user
// id or email they are keyed under, and a NULL status reaches the audit as a NULL
// (never as the 'inactive' a COALESCE would make it look like).
func TestBillingRowsByCustomerAndNullStatusAgainstPostgres(t *testing.T) {
	s := apiSubscriptionsTestStore(t)
	ctx := context.Background()
	require.NoError(t, s.UpsertAPISubscription(&APISubscription{
		UserID: "uid_a", UserEmail: "a@example.com", StripeCustomerID: "cus_a", StripeSubscriptionID: "sub_a",
		Status: "active", Tier: "premium",
	}))
	// A row keyed under another email and uid than the customer's Stripe email.
	require.NoError(t, s.UpsertAPISubscription(&APISubscription{
		UserID: "uid_moved", UserEmail: "old-address@example.com", StripeCustomerID: "cus_moved", StripeSubscriptionID: "sub_moved",
		Status: "active", Tier: "premium",
	}))
	// A row with no status: NULL is the value the store really holds.
	_, err := s.db.Exec(ctx, `INSERT INTO api_subscriptions (user_id, user_email, stripe_customer_id, status, tier)
		VALUES ('uid_null', 'null@example.com', 'cus_null', NULL, 'premium')`)
	require.NoError(t, err)

	t.Run("a customer is found under any user id or email", func(t *testing.T) {
		rows, err := s.BillingSubscriptionsByCustomers(ctx, []string{"cus_moved", "cus_missing"})
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, "uid_moved", rows[0].UserID)
		assert.Equal(t, "old-address@example.com", rows[0].UserEmail)
		assert.Equal(t, "active", rows[0].Status)
		assert.False(t, rows[0].StatusNull)
	})

	t.Run("no customers asked for reads nothing", func(t *testing.T) {
		rows, err := s.BillingSubscriptionsByCustomers(ctx, nil)
		require.NoError(t, err)
		assert.Empty(t, rows)
	})

	t.Run("a NULL status is reported as NULL, not as inactive", func(t *testing.T) {
		rows, err := s.BillingSubscriptionsByCustomers(ctx, []string{"cus_null"})
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.True(t, rows[0].StatusNull)
		assert.Empty(t, rows[0].Status)

		byUser, _, err := s.BillingSubscriptionsFor(ctx, "uid_null", "")
		require.NoError(t, err)
		require.Len(t, byUser, 1)
		assert.True(t, byUser[0].StatusNull, "the same row read by user id is NULL too")
	})

	// The audit grants nothing on a NULL status because the product cannot read the
	// row: its own read scans the status into a plain string, which a NULL fails.
	t.Run("the product's own read fails on a NULL status, so it grants nothing", func(t *testing.T) {
		sub, err := s.GetAPISubscription("uid_null")
		assert.Error(t, err, "a NULL status must not read as a valid subscription")
		assert.Nil(t, sub)
	})
}

// The quota table keeps the API-token and signed-in browser identity (user:<uid>)
// and the MCP connector identity (oauth:<uid>) as separate rows. Both come back for
// a user, each under its own identifier, and nobody else's rows do.
func TestAPIUsageSplitsUserAndOAuthAgainstPostgres(t *testing.T) {
	s := apiSubscriptionsTestStore(t)
	ctx := context.Background()
	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", "000112_add_api_usage_monthly.up.sql"))
	require.NoError(t, err)
	_, err = s.db.Exec(ctx, string(migration))
	require.NoError(t, err)

	now := time.Now().UTC()
	thisMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
	_, err = s.db.Exec(ctx, `INSERT INTO api_usage_monthly (identifier, period_month, request_count) VALUES
		('user:uid_a', $1::date, 7),
		('oauth:uid_a', $1::date, 11),
		('oauth:uid_a', (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date, 4),
		('oauth:uid_other', $1::date, 500)`, thisMonth)
	require.NoError(t, err)

	months, err := s.APIUsageByMonth(ctx, []string{"uid_a"})
	require.NoError(t, err)
	got := map[string]int64{}
	for _, m := range months {
		got[m.Identifier+"@"+m.Month.Format("2006-01")] += m.Requests
	}
	assert.Equal(t, int64(7), got["user:uid_a@"+now.Format("2006-01")])
	assert.Equal(t, int64(11), got["oauth:uid_a@"+now.Format("2006-01")])
	assert.Equal(t, int64(4), got["oauth:uid_a@"+now.AddDate(0, -1, 0).Format("2006-01")])
	assert.Len(t, got, 3, "another user's identifier must not come back: %v", got)
}
