package shorts

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
)

// countingAddress is a verified-address resolver that counts its calls, so a test can say
// whether the account lookup ran at all.
type countingAddress struct {
	calls int
	email string
	err   error
}

func (c *countingAddress) resolve(context.Context, string) (string, error) {
	c.calls++
	return c.email, c.err
}

// Finding 5: a non-Premium caller never triggers the account lookup. The check order is
// entitlement first, the address second, as the web order is.
func TestNonPremiumCreateNeverLooksUpTheAddress(t *testing.T) {
	store := &publicFakeStore{}
	lookup := &countingAddress{email: "ben@example.test"}
	src := publicSource(store, false, "", nil)
	src.verifiedEmail = lookup.resolve
	_, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.Error(t, err)
	assert.Zero(t, lookup.calls, "a non-Premium caller must not reach the account lookup")
	assert.Empty(t, store.created)
}

func TestNonPremiumResumeNeverLooksUpTheAddress(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, true, "ben@example.test", nil)
	created, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.NoError(t, err)
	_, err = src.SetAlertPaused(context.Background(), "uid-a", created.ID, true)
	require.NoError(t, err)

	lookup := &countingAddress{email: "ben@example.test"}
	lapsed := publicSource(store, false, "", nil)
	lapsed.verifiedEmail = lookup.resolve
	_, err = lapsed.SetAlertPaused(context.Background(), "uid-a", created.ID, false)
	require.Error(t, err)
	assert.Zero(t, lookup.calls, "a non-Premium resume must not reach the account lookup")
}

// A Premium caller does reach the lookup, exactly once.
func TestPremiumCreateLooksUpTheAddressOnce(t *testing.T) {
	store := &publicFakeStore{}
	lookup := &countingAddress{email: "ben@example.test"}
	src := publicSource(store, true, "", nil)
	src.verifiedEmail = lookup.resolve
	_, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.NoError(t, err)
	assert.Equal(t, 1, lookup.calls)
}

// The Premium refusal names the upgrade URL, the configured one.
func TestPremiumRefusalNamesTheUpgradeURL(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, false, "", nil)
	src.upgradeURL = "https://shorted.com.au/pricing"
	_, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	assert.EqualError(t, err, alertsNeedPremium+". Upgrade at https://shorted.com.au/pricing")
}

// The default is the pricing page when the config is empty, and a configured value wins.
func TestUpgradeURLDefaultsToPricingAndHonoursConfig(t *testing.T) {
	assert.Equal(t, "https://shorted.com.au/pricing", upgradeURLOrDefault(""))
	assert.Equal(t, "https://shorted.com.au/pricing", upgradeURLOrDefault("   "))
	assert.Equal(t, "https://example.test/upgrade", upgradeURLOrDefault("https://example.test/upgrade"))
}

// Finding 6: every public failure reads as public wording. The internal words never reach a
// caller, whatever the lookup failed with.
func TestPublicAlertErrorsNeverNameTheInternals(t *testing.T) {
	internals := []error{
		errAdminAlertsEmail,
		errors.New("no account exists for this administrator, so no alert can be sent to it"),
		errors.New(`admin users: Post "https://shorted-com-au-document-analyser.vercel.app/api/internal/admin-users": dial tcp: lookup failed`),
		errors.New("admin users: HTTP 503"),
		errAccountLookupNotDeployed,
		errors.New("the address on this account is not verified, so no alert can be sent to it. Verify it, then retry"),
	}
	forbidden := []string{"INTERNAL_", "admin", "vercel", "http", "https", "smoke test", "Shorted admin connector"}
	for _, in := range internals {
		mapped := publicAddressError(in).Error()
		for _, word := range forbidden {
			assert.NotContains(t, strings.ToLower(mapped), strings.ToLower(word), "public message %q leaks %q", mapped, word)
		}
		assert.True(t, mapped == publicAddressUnverified || mapped == publicAccountService, "unexpected public message %q", mapped)
	}
}

// The unverified refusal is the one place a public caller is stuck until they act, so it
// says the alert was not created and walks them through verifying, on the public page.
func TestUnverifiedRefusalGuidesTheCallerToVerify(t *testing.T) {
	for _, step := range []string{"was not created", "shorted.com.au/alerts?verify=1", "Send verification email", "click the link", "ask again"} {
		assert.Contains(t, publicAddressUnverified, step)
	}
}

// The infrastructure failures read as the account-service message; the account's own
// refusals read as the verify message.
func TestPublicAddressErrorsChooseTheRightCalmMessage(t *testing.T) {
	assert.Equal(t, publicAccountService, publicAddressError(errors.New(`admin users: Post "https://x": EOF`)).Error())
	assert.Equal(t, publicAccountService, publicAddressError(errAccountLookupNotDeployed).Error())
	assert.Equal(t, publicAddressUnverified, publicAddressError(errors.New("the address on this account is not verified")).Error())
}

// A full public create with an unreadable address returns the public account-service message,
// and writes nothing.
func TestPublicCreateReturnsOnlyPublicWording(t *testing.T) {
	store := &publicFakeStore{}
	src := publicSource(store, true, "", errors.New(`admin users: Post "https://x": dial tcp`))
	_, err := src.CreateAlert(context.Background(), "uid-a", bhpAbove)
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "admin users")
	assert.NotContains(t, err.Error(), "https://")
	assert.Equal(t, publicAccountService, strings.TrimPrefix(err.Error(), "an alert is emailed to your verified address, so none was created: "))
	assert.Empty(t, store.created)
}

var _ mcp.AlertsWriteOperator = (*publicAlertsSource)(nil)
