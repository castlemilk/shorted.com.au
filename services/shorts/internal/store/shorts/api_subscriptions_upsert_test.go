package shorts

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The statements behind UpsertAPISubscription run on routine Stripe events, so the
// text guards: the upsert never NULLs a period it was not given, the only DELETE
// names both the customer and the other user, and the other user's row is locked
// before the decision. These assertions run everywhere. The behaviour is checked
// against a real Postgres in postgres_api_subscriptions_pg_test.go, which needs
// SHORTS_TEST_POSTGRES_URL.
func TestAPISubscriptionSQLConfinesDeletionAndKeepsKnownPeriods(t *testing.T) {
	squeeze := func(q string) string { return strings.Join(strings.Fields(q), " ") }

	upsert := squeeze(upsertAPISubscriptionSQL)
	assert.NotContains(t, strings.ToUpper(upsert), "DELETE", "the upsert itself must not delete")
	assert.Contains(t, upsert, "current_period_start = COALESCE(EXCLUDED.current_period_start, api_subscriptions.current_period_start)")
	assert.Contains(t, upsert, "current_period_end = COALESCE(EXCLUDED.current_period_end, api_subscriptions.current_period_end)")
	assert.NotContains(t, upsert, "current_period_end = EXCLUDED.current_period_end", "a NULL period from the checkout write must not overwrite the known one")

	repoint := squeeze(repointSubscriptionSQL)
	assert.Contains(t, strings.ToUpper(repoint), "DELETE FROM API_SUBSCRIPTIONS")
	assert.Contains(t, repoint, "WHERE stripe_customer_id = $1 AND user_id = $2", "the re-point must name the customer and the other user, and nothing else")

	lookup := squeeze(otherUserSubscriptionSQL)
	assert.Contains(t, lookup, "user_id <> $2")
	assert.True(t, strings.HasSuffix(lookup, "FOR UPDATE"), "the other user's row must be locked until the transaction ends")
}
