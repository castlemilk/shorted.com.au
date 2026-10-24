package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// recordedCall is one request the account route received.
type recordedCall struct {
	body   map[string]any
	secret string
}

// accountsServer answers the admin-users route with status and body, counting the
// calls and recording the last request, so a test can say whether anything reached
// the web app and what it sent.
func accountsServer(t *testing.T, status int, body string, seen *atomic.Int32, rec *recordedCall) *firebaseUsersClient {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Add(1)
		if rec != nil {
			raw, _ := io.ReadAll(r.Body)
			rec.body = map[string]any{}
			_ = json.Unmarshal(raw, &rec.body)
			rec.secret = r.Header.Get("x-internal-secret")
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return &firebaseUsersClient{url: srv.URL, secret: "internal-secret", client: srv.Client()}
}

func TestLookupUIDSendsTheUidAndReadsTheAccount(t *testing.T) {
	var seen atomic.Int32
	var sent recordedCall
	c := accountsServer(t, http.StatusOK, `{"user":{"uid":"uid_A-9","email":"ben@shorted.com.au","emailVerified":true,"disabled":false}}`, &seen, &sent)
	u, err := c.LookupUID(context.Background(), "uid_A-9")
	require.NoError(t, err)
	require.NotNil(t, u)
	assert.Equal(t, "ben@shorted.com.au", u.Email)
	assert.True(t, u.EmailVerified)
	assert.Equal(t, "lookup", sent.body["action"])
	assert.Equal(t, "uid_A-9", sent.body["uid"])
	assert.NotContains(t, sent.body, "email", "a uid lookup must not send an email key")
	assert.Equal(t, "internal-secret", sent.secret)
}

func TestLookupUIDAnUnknownAccountIsNilNotAnError(t *testing.T) {
	var seen atomic.Int32
	c := accountsServer(t, http.StatusOK, `{"user":null}`, &seen, nil)
	u, err := c.LookupUID(context.Background(), "gone")
	require.NoError(t, err)
	assert.Nil(t, u)
}

// A malformed uid is refused before the web app is asked.
func TestLookupUIDRefusesAMalformedUIDWithoutCalling(t *testing.T) {
	var seen atomic.Int32
	c := accountsServer(t, http.StatusOK, `{"user":null}`, &seen, nil)
	for _, uid := range []string{"", "a b", "a/b", "uid;x", strings.Repeat("u", 129)} {
		_, err := c.LookupUID(context.Background(), uid)
		assert.Error(t, err, uid)
	}
	assert.Zero(t, seen.Load())
}

// The API deploys before Vercel. While the old route is still answering, its 400
// is a clear "not deployed yet", never a failure that looks like a bad account.
func TestLookupUIDOldRouteIsAClearNotDeployedRefusal(t *testing.T) {
	var seen atomic.Int32
	c := accountsServer(t, http.StatusBadRequest, `{"error":"email is required"}`, &seen, nil)
	_, err := c.LookupUID(context.Background(), "uid-admin")
	require.Error(t, err)
	assert.True(t, errors.Is(err, errAccountLookupNotDeployed), "got %v", err)
	assert.Contains(t, err.Error(), "still rolling out")
}

// A server error is not the deploy message: the web app is down, not old.
func TestLookupUIDServerErrorIsReportedAsItsStatus(t *testing.T) {
	var seen atomic.Int32
	c := accountsServer(t, http.StatusServiceUnavailable, `{"error":"lookup failed"}`, &seen, nil)
	_, err := c.LookupUID(context.Background(), "uid-admin")
	require.Error(t, err)
	assert.False(t, errors.Is(err, errAccountLookupNotDeployed))
	assert.Contains(t, err.Error(), "HTTP 503")
}

// stubAccounts is a firebaseUsersReader that answers LookupUID with one account.
type stubAccounts struct {
	account *firebaseUser
	err     error
}

func (s stubAccounts) Summary(context.Context) (*firebaseUserSummary, error) { return nil, nil }
func (s stubAccounts) List(context.Context, string, string, int, int) (*firebaseUserPage, error) {
	return nil, nil
}
func (s stubAccounts) Lookup(context.Context, string) (*firebaseUser, error) { return nil, nil }
func (s stubAccounts) LookupUID(context.Context, string) (*firebaseUser, error) {
	return s.account, s.err
}

// The verified-address rule. It must match the public path's alertEmailFor: an
// address is used only when Firebase says it is verified, on an enabled account.
func TestVerifiedAccountEmailUsesOnlyAVerifiedEnabledAddress(t *testing.T) {
	ok := &firebaseUser{UID: "u", Email: " ben@shorted.com.au ", EmailVerified: true}
	cases := []struct {
		name     string
		accounts firebaseUsersReader
		want     string
		refuse   string
	}{
		{name: "verified and enabled", accounts: stubAccounts{account: ok}, want: "ben@shorted.com.au"},
		{name: "unverified", accounts: stubAccounts{account: &firebaseUser{Email: "a@x.test"}}, refuse: "not verified"},
		{name: "disabled even if verified", accounts: stubAccounts{account: &firebaseUser{Email: "a@x.test", EmailVerified: true, Disabled: true}}, refuse: "disabled"},
		{name: "no address", accounts: stubAccounts{account: &firebaseUser{EmailVerified: true}}, refuse: "no email address"},
		{name: "not an address", accounts: stubAccounts{account: &firebaseUser{Email: "nope", EmailVerified: true}}, refuse: "no email address"},
		{name: "no account", accounts: stubAccounts{}, refuse: "no account exists"},
		{name: "store unreadable", accounts: stubAccounts{err: errors.New("admin users: HTTP 503")}, refuse: "HTTP 503"},
		{name: "not deployed", accounts: stubAccounts{err: errAccountLookupNotDeployed}, refuse: "still rolling out"},
		{name: "no client configured", accounts: nil, refuse: "cannot read your verified address"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := verifiedAccountEmail(context.Background(), tc.accounts, "u")
			if tc.refuse == "" {
				require.NoError(t, err)
				assert.Equal(t, tc.want, got)
				return
			}
			require.Error(t, err)
			assert.Empty(t, got)
			assert.Contains(t, err.Error(), tc.refuse)
		})
	}
}

// The smoke test surfaces the reason and writes nothing when the web route is not
// deployed yet.
func TestRunAlertsSmokeSurfacesTheNotDeployedRefusalAndWritesNothing(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	jobs := &fakeAlertJobs{}
	src := smokeSource(store, jobs, true, "")
	src.verifiedEmail = func(ctx context.Context, uid string) (string, error) {
		return verifiedAccountEmail(ctx, stubAccounts{err: errAccountLookupNotDeployed}, uid)
	}
	_, err := src.RunAlertsSmoke(context.Background(), adminUID, "oauth:"+adminUID, smokeInput())
	require.Error(t, err)
	assert.ErrorContains(t, err, "still rolling out")
	assert.Empty(t, store.created)
	assert.Empty(t, jobs.runs)
}

// And with the account-store reader wired but unverified, the reason names it.
func TestRunAlertsSmokeNamesAnUnverifiedAddress(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	jobs := &fakeAlertJobs{}
	src := smokeSource(store, jobs, true, "")
	src.verifiedEmail = func(ctx context.Context, uid string) (string, error) {
		return verifiedAccountEmail(ctx, stubAccounts{account: &firebaseUser{Email: adminAddress}}, uid)
	}
	_, err := src.RunAlertsSmoke(context.Background(), adminUID, "", smokeInput())
	require.Error(t, err)
	assert.ErrorContains(t, err, "not verified")
	assert.Empty(t, store.created)
}
