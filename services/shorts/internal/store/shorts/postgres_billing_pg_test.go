package shorts

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Real-Postgres check of the billing audit reads (postgres_billing.go). The
// schema is the real migrations for api_subscriptions (000015), the chat tables
// (000026) and api_usage_monthly (000112); chat_usage_events is the ledger from
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
