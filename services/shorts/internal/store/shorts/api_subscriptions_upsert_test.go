package shorts

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The checkout write runs on routine Stripe events, so its SQL must neither delete
// a row nor null out a period it was not given. These assertions run everywhere.
// The behaviour itself is checked against a real Postgres in
// postgres_api_subscriptions_pg_test.go, which needs SHORTS_TEST_POSTGRES_URL.
func TestUpsertAPISubscriptionSQLNeverDeletesOrNullsAKnownPeriod(t *testing.T) {
	sql := strings.Join(strings.Fields(upsertAPISubscriptionSQL), " ")

	assert.NotContains(t, strings.ToUpper(sql), "DELETE", "the upsert must not delete another user's row")
	assert.Contains(t, sql, "current_period_start = COALESCE(EXCLUDED.current_period_start, api_subscriptions.current_period_start)")
	assert.Contains(t, sql, "current_period_end = COALESCE(EXCLUDED.current_period_end, api_subscriptions.current_period_end)")
	assert.NotContains(t, sql, "current_period_end = EXCLUDED.current_period_end", "a NULL period from the checkout write must not overwrite the known one")
}
