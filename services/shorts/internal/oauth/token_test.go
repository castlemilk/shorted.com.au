package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// ------------------------------------------------------------- test doubles

// fakeTokenStore is an in-memory TokenStore whose consume and rotate paths are
// guarded by a mutex, so the "only one caller wins" property is modelled the
// same way the SQL is: a single critical section that both checks and mutates.
// The real proof of atomicity is the integration test against Postgres; this
// double exists so the handler's DECISIONS can be tested without a database.
type fakeTokenStore struct {
	mu sync.Mutex

	clients map[string]*Client
	codes   map[string]*AuthorizationCode
	refresh map[string]*RefreshToken
	touched []string

	getClientErr  error
	consumeErr    error
	rotateErr     error
	createErr     error
	getRefreshErr error

	consumeCalls int
}

func newFakeTokenStore() *fakeTokenStore {
	return &fakeTokenStore{
		clients: map[string]*Client{testClientID: {
			ClientID:     testClientID,
			RedirectURIs: []string{testRedirectURI},
			GrantTypes:   []string{"authorization_code", "refresh_token"},
		}},
		codes:   map[string]*AuthorizationCode{},
		refresh: map[string]*RefreshToken{},
	}
}

func (f *fakeTokenStore) GetClient(_ context.Context, id string) (*Client, error) {
	if f.getClientErr != nil {
		return nil, f.getClientErr
	}
	c, ok := f.clients[id]
	if !ok {
		return nil, nil
	}
	return c, nil
}

// GetRegisteredClient is the PERSISTED row. The fake reads the same map
// GetClient does, exactly as *PostgresStore runs the same query for both — the
// two only diverge at ResolvingStore, which overrides GetClient alone.
func (f *fakeTokenStore) GetRegisteredClient(_ context.Context, id string) (*Client, error) {
	if f.getClientErr != nil {
		return nil, f.getClientErr
	}
	c, ok := f.clients[id]
	if !ok {
		return nil, nil
	}
	return c, nil
}

func (f *fakeTokenStore) TouchClient(_ context.Context, clientID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touched = append(f.touched, clientID)
	return nil
}

// touchedClients is the single place tests read last_used_at activity from, so
// a token test and a registration test cannot disagree about what "used" means.
func (f *fakeTokenStore) touchedClients() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.touched...)
}

func (f *fakeTokenStore) CreateAuthorizationCode(_ context.Context, code AuthorizationCode) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := code
	f.codes[code.CodeHash] = &cp
	return nil
}

func (f *fakeTokenStore) ConsumeAuthorizationCode(_ context.Context, hash string) (*AuthorizationCode, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.consumeCalls++
	if f.consumeErr != nil {
		return nil, f.consumeErr
	}
	rec, ok := f.codes[hash]
	if !ok || !rec.ConsumedAt.IsZero() {
		return nil, nil
	}
	rec.ConsumedAt = time.Now()
	cp := *rec
	return &cp, nil
}

func (f *fakeTokenStore) CreateRefreshToken(_ context.Context, rt RefreshToken) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return f.createErr
	}
	cp := rt
	f.refresh[rt.TokenHash] = &cp
	return nil
}

func (f *fakeTokenStore) GetRefreshToken(_ context.Context, hash string) (*RefreshToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getRefreshErr != nil {
		return nil, f.getRefreshErr
	}
	rt, ok := f.refresh[hash]
	if !ok {
		return nil, nil
	}
	cp := *rt
	return &cp, nil
}

func (f *fakeTokenStore) RotateRefreshToken(_ context.Context, presented, successor string, expires time.Time) (*RefreshToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.rotateErr != nil {
		return nil, f.rotateErr
	}
	parent, ok := f.refresh[presented]
	if !ok || !parent.RotatedAt.IsZero() || !parent.RevokedAt.IsZero() {
		return nil, nil
	}
	parent.RotatedAt = time.Now()
	f.refresh[successor] = &RefreshToken{
		TokenHash: successor,
		FamilyID:  parent.FamilyID,
		ClientID:  parent.ClientID,
		UserID:    parent.UserID,
		Resource:  parent.Resource,
		Scope:     parent.Scope,
		ExpiresAt: expires,
	}
	cp := *parent
	return &cp, nil
}

func (f *fakeTokenStore) RevokeRefreshTokenFamily(_ context.Context, presented string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	parent, ok := f.refresh[presented]
	if !ok {
		return 0, nil
	}
	n := 0
	for _, rt := range f.refresh {
		if rt.FamilyID == parent.FamilyID && rt.RevokedAt.IsZero() {
			rt.RevokedAt = time.Now()
			n++
		}
	}
	return n, nil
}

// live reports whether a token hash is still usable.
func (f *fakeTokenStore) live(hash string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	rt, ok := f.refresh[hash]
	return ok && rt.RotatedAt.IsZero() && rt.RevokedAt.IsZero()
}

// fakeMinter records what it was asked to mint so tests can assert on the
// audience, TTL and scope rather than on an opaque string.
type fakeMinter struct {
	seen []AccessTokenRequest
	err  error
	n    int
}

func (m *fakeMinter) MintAccessToken(req AccessTokenRequest) (string, error) {
	if m.err != nil {
		return "", m.err
	}
	m.seen = append(m.seen, req)
	m.n++
	return "access-token-" + req.UserID, nil
}

// ------------------------------------------------------------------ helpers

const (
	// A verifier and its S256 challenge, from RFC 7636 appendix B.
	testVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	// testChallenge (authorize_test.go) is the S256 of testVerifier.
	testResource = testAPIBase + "/mcp"
)

func newTokenTestHandler(store TokenStore, minter TokenMinter, tier func(string) (string, error)) http.Handler {
	return NewTokenHandler(TokenConfig{
		Endpoints:   Endpoints{APIBaseURL: testAPIBase},
		Store:       store,
		Minter:      minter,
		ResolveTier: tier,
	})
}

func postForm(t *testing.T, h http.Handler, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, TokenPath, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// seedCode writes a code exactly as the grant handler would, and returns the
// raw code.
func seedCode(t *testing.T, store TokenStore, mutate func(*AuthorizationCode)) string {
	t.Helper()
	code, err := newAuthorizationCode()
	if err != nil {
		t.Fatal(err)
	}
	rec := AuthorizationCode{
		CodeHash:            HashCode(code),
		ClientID:            testClientID,
		UserID:              "uid-1",
		RedirectURI:         testRedirectURI,
		CodeChallenge:       testChallenge,
		CodeChallengeMethod: "S256",
		Resource:            testResource,
		Scope:               "shorts:read housing:read",
		ExpiresAt:           time.Now().Add(CodeTTL),
	}
	if mutate != nil {
		mutate(&rec)
	}
	if err := store.CreateAuthorizationCode(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
	return code
}

func codeForm(code, verifier string) url.Values {
	return url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {testRedirectURI},
		"client_id":     {testClientID},
		"code_verifier": {verifier},
	}
}

func decodeTokenResponse(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decoding %s: %v", rec.Body.String(), err)
	}
	return out
}

// -------------------------------------------------------- the happy baseline

// Not a security property on its own, but every property below is stated
// relative to it, so it has to be pinned.
func TestAuthorizationCodeGrantMintsAnAudienceBoundToken(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, func(string) (string, error) { return "pro", nil })

	rec := postForm(t, h, codeForm(seedCode(t, store, nil), testVerifier))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	body := decodeTokenResponse(t, rec)
	if body["token_type"] != "Bearer" {
		t.Errorf("token_type = %v", body["token_type"])
	}
	if body["expires_in"] != float64(AccessTokenTTL/time.Second) {
		t.Errorf("expires_in = %v, want %v", body["expires_in"], AccessTokenTTL/time.Second)
	}
	if body["refresh_token"] == "" || body["refresh_token"] == nil {
		t.Error("no refresh token issued")
	}
	if body["scope"] != "shorts:read housing:read" {
		t.Errorf("scope = %v", body["scope"])
	}
	if len(minter.seen) != 1 {
		t.Fatalf("minted %d tokens", len(minter.seen))
	}
	got := minter.seen[0]
	if !containsString(got.Audience, testResource) {
		t.Errorf("audience = %v, want it to contain %s", got.Audience, testResource)
	}
	if containsString(got.Audience, testAPIBase) {
		t.Errorf("audience = %v: an MCP grant must NOT be spendable on the Connect API origin", got.Audience)
	}
	if got.TTL != AccessTokenTTL {
		t.Errorf("TTL = %s, want %s", got.TTL, AccessTokenTTL)
	}
	if got.Tier != "pro" {
		t.Errorf("tier = %q, want the tier resolved from api_subscriptions", got.Tier)
	}
	if got.Scope != "shorts:read housing:read" {
		t.Errorf("scope = %q", got.Scope)
	}
}

// ------------------------------------------------------ security properties

// A code is single use. The second presentation must fail, and it must not
// produce a second access token.
func TestReplayedAuthorizationCodeIsRefusedAndMintsNothing(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)
	code := seedCode(t, store, nil)

	if rec := postForm(t, h, codeForm(code, testVerifier)); rec.Code != http.StatusOK {
		t.Fatalf("first redemption failed: %d %s", rec.Code, rec.Body.String())
	}
	rec := postForm(t, h, codeForm(code, testVerifier))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("replay status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
	if got := decodeTokenResponse(t, rec)["error"]; got != "invalid_grant" {
		t.Errorf("error = %v, want invalid_grant", got)
	}
	if minter.n != 1 {
		t.Errorf("minted %d access tokens across a redemption and a replay, want 1", minter.n)
	}
	if len(store.refresh) != 1 {
		t.Errorf("issued %d refresh tokens, want 1", len(store.refresh))
	}
}

// PKCE is the only thing proving the redeemer is the client that started the
// flow, since a public client has no secret.
func TestWrongCodeVerifierIsRefused(t *testing.T) {
	for name, verifier := range map[string]string{
		"unrelated":       "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"empty":           "",
		"prefix":          testVerifier[:len(testVerifier)-1],
		"suffix":          testVerifier[1:],
		"extra suffix":    testVerifier + "x",
		"extra prefix":    "x" + testVerifier,
		"the challenge":   testChallenge,
		"case difference": strings.ToUpper(testVerifier),
	} {
		t.Run(name, func(t *testing.T) {
			store := newFakeTokenStore()
			minter := &fakeMinter{}
			h := newTokenTestHandler(store, minter, nil)
			rec := postForm(t, h, codeForm(seedCode(t, store, nil), verifier))
			if rec.Code == http.StatusOK {
				t.Fatalf("verifier %q was accepted", verifier)
			}
			if minter.n != 0 {
				t.Errorf("minted a token for a bad verifier")
			}
		})
	}
}

// A code minted for one client must not be redeemable by another, or a
// malicious client that intercepts a redirect can spend someone else's grant.
func TestCrossClientCodeRedemptionIsRefused(t *testing.T) {
	store := newFakeTokenStore()
	store.clients["other-client"] = &Client{
		ClientID:     "other-client",
		RedirectURIs: []string{testRedirectURI},
		GrantTypes:   []string{"authorization_code"},
	}
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)

	form := codeForm(seedCode(t, store, nil), testVerifier)
	form.Set("client_id", "other-client")
	rec := postForm(t, h, form)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
	if minter.n != 0 {
		t.Error("a token was minted for the wrong client")
	}
}

// The redirect_uri is re-presented at the token endpoint precisely so it can be
// compared (RFC 6749 §4.1.3).
func TestRedirectURIMismatchIsRefused(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)
	form := codeForm(seedCode(t, store, nil), testVerifier)
	form.Set("redirect_uri", testRedirectURI+"/../cb")
	if rec := postForm(t, h, form); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if minter.n != 0 {
		t.Error("a token was minted despite a redirect_uri mismatch")
	}
}

func TestExpiredCodeIsRefused(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)
	code := seedCode(t, store, func(c *AuthorizationCode) {
		c.ExpiresAt = time.Now().Add(-time.Second)
	})
	rec := postForm(t, h, codeForm(code, testVerifier))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
	if minter.n != 0 {
		t.Error("a token was minted from an expired code")
	}
}

// The resource the client asks for at the token endpoint must be the resource
// the code was bound to — otherwise the audience the grant authorised is not
// the audience the token carries.
func TestResourceMismatchIsRefused(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)
	form := codeForm(seedCode(t, store, nil), testVerifier)
	form.Set("resource", "https://api.evil.test/mcp")
	rec := postForm(t, h, form)
	if rec.Code == http.StatusOK {
		t.Fatal("a mismatched resource was accepted")
	}
	if got := decodeTokenResponse(t, rec)["error"]; got != "invalid_target" {
		t.Errorf("error = %v, want invalid_target", got)
	}
	if minter.n != 0 {
		t.Error("a token was minted for the wrong resource")
	}
}

// A storage failure must not be readable as "no such code" and must never mint.
func TestStorageFailureFailsClosed(t *testing.T) {
	store := newFakeTokenStore()
	code := seedCode(t, store, nil)
	store.consumeErr = errors.New("connection refused")
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)

	rec := postForm(t, h, codeForm(code, testVerifier))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body %s", rec.Code, rec.Body.String())
	}
	if minter.n != 0 {
		t.Error("a token was minted despite a storage failure")
	}
}

// A tier lookup that fails must not fail the exchange — tier is re-resolved on
// every request anyway, so the token's tier is a hint. But it must degrade to
// the LEAST privilege, never to a paid tier.
func TestTierLookupFailureDegradesToFree(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, func(string) (string, error) {
		return "", errors.New("subscription store down")
	})
	if rec := postForm(t, h, codeForm(seedCode(t, store, nil), testVerifier)); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if got := minter.seen[0].Tier; got != "free" {
		t.Errorf("tier = %q, want free when the lookup fails", got)
	}
}

func TestUnsupportedGrantTypeIsRefused(t *testing.T) {
	h := newTokenTestHandler(newFakeTokenStore(), &fakeMinter{}, nil)
	for _, gt := range []string{"", "password", "client_credentials", "implicit"} {
		rec := postForm(t, h, url.Values{"grant_type": {gt}})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("grant_type=%q status = %d, want 400", gt, rec.Code)
		}
		if got := decodeTokenResponse(t, rec)["error"]; got != "unsupported_grant_type" && got != "invalid_request" {
			t.Errorf("grant_type=%q error = %v", gt, got)
		}
	}
}

// -------------------------------------------------- refresh token properties

// redeem runs a full authorization_code exchange and returns the refresh token.
func redeem(t *testing.T, h http.Handler, store TokenStore) string {
	t.Helper()
	rec := postForm(t, h, codeForm(seedCode(t, store, nil), testVerifier))
	if rec.Code != http.StatusOK {
		t.Fatalf("redemption failed: %d %s", rec.Code, rec.Body.String())
	}
	rt, _ := decodeTokenResponse(t, rec)["refresh_token"].(string)
	if rt == "" {
		t.Fatal("no refresh token in the response")
	}
	return rt
}

func refreshForm(token string) url.Values {
	return url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {token},
		"client_id":     {testClientID},
	}
}

func TestRefreshRotationInvalidatesTheOldToken(t *testing.T) {
	store := newFakeTokenStore()
	h := newTokenTestHandler(store, &fakeMinter{}, nil)
	first := redeem(t, h, store)

	rec := postForm(t, h, refreshForm(first))
	if rec.Code != http.StatusOK {
		t.Fatalf("rotation failed: %d %s", rec.Code, rec.Body.String())
	}
	second, _ := decodeTokenResponse(t, rec)["refresh_token"].(string)
	if second == "" || second == first {
		t.Fatalf("rotation returned %q for %q — a new token is the point", second, first)
	}
	if store.live(HashCode(first)) {
		t.Error("the presented refresh token is still live after rotation")
	}
}

// THE property of this task. A stolen refresh token must be useful once, not
// forever: presenting an already-rotated token means two parties hold it, so
// every descendant of that grant dies.
func TestRefreshReuseRevokesTheWholeFamily(t *testing.T) {
	store := newFakeTokenStore()
	h := newTokenTestHandler(store, &fakeMinter{}, nil)

	first := redeem(t, h, store)
	rec := postForm(t, h, refreshForm(first))
	second, _ := decodeTokenResponse(t, rec)["refresh_token"].(string)
	rec = postForm(t, h, refreshForm(second))
	if rec.Code != http.StatusOK {
		t.Fatalf("second rotation failed: %d %s", rec.Code, rec.Body.String())
	}
	third, _ := decodeTokenResponse(t, rec)["refresh_token"].(string)
	if !store.live(HashCode(third)) {
		t.Fatal("the newest token is not live before the reuse")
	}

	// The attacker presents the FIRST token, two rotations old.
	reuse := postForm(t, h, refreshForm(first))
	if reuse.Code != http.StatusBadRequest {
		t.Fatalf("reuse status = %d, want 400; body %s", reuse.Code, reuse.Body.String())
	}

	// The newest token — held by the legitimate client — must now be dead too.
	if store.live(HashCode(third)) {
		t.Error("the newest refresh token survived a reuse of its ancestor")
	}
	if store.live(HashCode(second)) {
		t.Error("an intermediate refresh token survived a family revocation")
	}
	if rec := postForm(t, h, refreshForm(third)); rec.Code == http.StatusOK {
		t.Error("the newest refresh token still works after the family was revoked")
	}
}

// A refresh token belonging to one client must not be redeemable by another,
// and the attempt is a compromise signal, not a typo.
func TestCrossClientRefreshIsRefusedAndRevokesTheFamily(t *testing.T) {
	store := newFakeTokenStore()
	store.clients["other-client"] = &Client{
		ClientID:   "other-client",
		GrantTypes: []string{"refresh_token"},
	}
	h := newTokenTestHandler(store, &fakeMinter{}, nil)
	first := redeem(t, h, store)

	form := refreshForm(first)
	form.Set("client_id", "other-client")
	if rec := postForm(t, h, form); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if rec := postForm(t, h, refreshForm(first)); rec.Code == http.StatusOK {
		t.Error("the refresh token survived a cross-client redemption attempt")
	}
}

// An unknown refresh token is refused without a family to revoke, and without
// a 500 that would tell an attacker the difference.
func TestUnknownRefreshTokenIsRefused(t *testing.T) {
	store := newFakeTokenStore()
	h := newTokenTestHandler(store, &fakeMinter{}, nil)
	rec := postForm(t, h, refreshForm("not-a-real-token"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if got := decodeTokenResponse(t, rec)["error"]; got != "invalid_grant" {
		t.Errorf("error = %v, want invalid_grant", got)
	}
}

// Refresh may narrow the grant but never widen it.
func TestRefreshCannotWidenScope(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)
	first := redeem(t, h, store) // scope: shorts:read housing:read

	form := refreshForm(first)
	form.Set("scope", "shorts:read economy:read")
	rec := postForm(t, h, form)
	if rec.Code == http.StatusOK {
		t.Fatal("a widened scope was accepted")
	}
	if got := decodeTokenResponse(t, rec)["error"]; got != "invalid_scope" {
		t.Errorf("error = %v, want invalid_scope", got)
	}
}

// A client bug is not theft, and must not be answered as though it were.
//
// Scope widening and resource mismatch used to be checked AFTER the rotation,
// so a successor already existed and the only safe response left was to kill
// the family. Validating first means the token stays live and the client can
// retry with a correct request — and it keeps family revocation meaning
// "somebody is holding a token they should not", which is the only reason to
// have the signal at all.
func TestOrdinaryClientMistakesDoNotRevokeTheFamily(t *testing.T) {
	for name, mutate := range map[string]func(url.Values){
		"a scope wider than the grant": func(f url.Values) { f.Set("scope", "shorts:read economy:read") },
		"an unknown scope":             func(f url.Values) { f.Set("scope", "not:a:scope") },
		"the wrong resource":           func(f url.Values) { f.Set("resource", "https://api.evil.test/mcp") },
	} {
		t.Run(name, func(t *testing.T) {
			store := newFakeTokenStore()
			minter := &fakeMinter{}
			h := newTokenTestHandler(store, minter, nil)
			first := redeem(t, h, store)

			form := refreshForm(first)
			mutate(form)
			if rec := postForm(t, h, form); rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", rec.Code)
			}
			if minter.n != 1 {
				t.Errorf("minted %d access tokens, want only the original redemption's", minter.n)
			}
			// The token is untouched: not rotated, not revoked, still usable.
			if !store.live(HashCode(first)) {
				t.Fatal("a refused pre-check spent or revoked the token; the client cannot recover")
			}
			if len(store.refresh) != 1 {
				t.Errorf("%d refresh tokens exist, want 1 — a refused refresh must not mint a successor", len(store.refresh))
			}
			// And the corrected request works, which is the property that matters
			// to a client that simply had a bug.
			if rec := postForm(t, h, refreshForm(first)); rec.Code != http.StatusOK {
				t.Fatalf("the corrected retry failed: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

// An expired refresh token is a clock, not a compromise. It is already useless;
// revoking its family as well logs a user out of every session for being slow.
func TestExpiredRefreshTokenIsRefusedWithoutKillingTheFamily(t *testing.T) {
	store := newFakeTokenStore()
	h := newTokenTestHandler(store, &fakeMinter{}, nil)
	first := redeem(t, h, store)

	// Age the token past its expiry without touching anything else.
	store.mu.Lock()
	store.refresh[HashCode(first)].ExpiresAt = time.Now().Add(-time.Second)
	store.mu.Unlock()

	rec := postForm(t, h, refreshForm(first))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
	if got := decodeTokenResponse(t, rec)["error"]; got != "invalid_grant" {
		t.Errorf("error = %v, want invalid_grant", got)
	}
	store.mu.Lock()
	revoked := !store.refresh[HashCode(first)].RevokedAt.IsZero()
	store.mu.Unlock()
	if revoked {
		t.Error("an expired refresh token revoked its family; expiry is not evidence of theft")
	}
}

// `scope=` with nothing but whitespace in it is an absent narrowing request, not
// a request for the empty scope set. strings.Fields("   ") is empty, narrowScope
// refuses an empty set, and that refusal used to kill the family — so a client
// that sent a blank parameter lost every session it had.
func TestWhitespaceOnlyScopeIsNoNarrowingRequest(t *testing.T) {
	for _, blank := range []string{" ", "   ", "\t", "\n", " \t\n "} {
		store := newFakeTokenStore()
		minter := &fakeMinter{}
		h := newTokenTestHandler(store, minter, nil)
		first := redeem(t, h, store)

		form := refreshForm(first)
		form.Set("scope", blank)
		rec := postForm(t, h, form)
		if rec.Code != http.StatusOK {
			t.Fatalf("scope=%q status = %d, want 200; body %s", blank, rec.Code, rec.Body.String())
		}
		// The full granted scope survives — a blank request narrows nothing.
		if got := minter.seen[len(minter.seen)-1].Scope; got != "shorts:read housing:read" {
			t.Errorf("scope=%q minted scope %q, want the whole grant", blank, got)
		}
	}
}

// grant_types was enforced at /authorize and nowhere else, so a client
// registered for authorization_code alone could still refresh indefinitely.
func TestRefreshRequiresTheClientToBeRegisteredForIt(t *testing.T) {
	store := newFakeTokenStore()
	h := newTokenTestHandler(store, &fakeMinter{}, nil)
	first := redeem(t, h, store)

	store.mu.Lock()
	store.clients[testClientID].GrantTypes = []string{"authorization_code"}
	store.mu.Unlock()

	rec := postForm(t, h, refreshForm(first))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body %s", rec.Code, rec.Body.String())
	}
	if got := decodeTokenResponse(t, rec)["error"]; got != "unauthorized_client" {
		t.Errorf("error = %v, want unauthorized_client", got)
	}
	// Refused, not punished: the client's registration is wrong, not stolen.
	if !store.live(HashCode(first)) {
		t.Error("an unregistered grant type spent or revoked the token")
	}
}

// THE reason the refresh path reads the PERSISTED row instead of resolving the
// client: a refresh is a live-session operation, and it must not depend on a
// third party's web server being up.
//
// The client here is a Client ID Metadata Document whose document is
// unreachable — the server is closed before the refresh, so any fetch fails.
// Resolving the client at this point would answer "unknown client_id" and log
// the user out mid-session, and it would not be a rare edge: the CIMD success
// cache and the access token both last an hour, so refreshes routinely miss the
// cache and would routinely re-fetch.
//
// /authorize is different and deliberately keeps the resolving fetch — it runs
// once, at connect time, when a fresh read of the declared metadata is exactly
// what is wanted, and a failure there is a visible "could not connect" rather
// than a silent logout.
func TestRefreshSurvivesAnUnreachableClientMetadataDocument(t *testing.T) {
	// A well-formed CIMD client_id pointing at a server that is already gone.
	srv := newCIMDServer(t, func(w http.ResponseWriter, _ *http.Request) {})
	cimdClientID := srv.URL + "/client.json"
	srv.Close()

	inner := newFakeClientStore()
	// The row the resolving store persisted when the grant ran, back when the
	// document WAS reachable. This is what the refresh must be able to rely on.
	inner.clients[cimdClientID] = &Client{
		ClientID:     cimdClientID,
		RedirectURIs: []string{testRedirectURI},
		GrantTypes:   []string{"authorization_code", "refresh_token"},
	}
	store := NewResolvingStore(inner, testFetcher(MetadataFetcherConfig{}))

	// Sanity: resolving this client_id really does fail now. Without this the
	// test could pass because nothing was ever unreachable.
	if c, err := store.GetClient(context.Background(), cimdClientID); err != nil || c != nil {
		t.Fatalf("GetClient on a dead document = %v, %v; want nil, nil — the premise of this test", c, err)
	}

	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)

	code := seedCode(t, store, func(c *AuthorizationCode) { c.ClientID = cimdClientID })
	form := codeForm(code, testVerifier)
	form.Set("client_id", cimdClientID)
	rec := postForm(t, h, form)
	if rec.Code != http.StatusOK {
		t.Fatalf("redemption: %d %s", rec.Code, rec.Body.String())
	}
	first, _ := decodeTokenResponse(t, rec)["refresh_token"].(string)

	refresh := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {first},
		"client_id":     {cimdClientID},
	}
	if rec := postForm(t, h, refresh); rec.Code != http.StatusOK {
		t.Fatalf("refresh with an unreachable metadata document: %d %s — "+
			"somebody else's outage just logged our user out", rec.Code, rec.Body.String())
	}
	// And it stayed a real rotation, not a degraded pass-through that skipped the
	// single-use gate.
	if inner.live(HashCode(first)) {
		t.Error("the presented token is still live: the refresh succeeded without rotating")
	}
	if minter.n != 2 {
		t.Errorf("minted %d access tokens, want 2 (redemption + refresh)", minter.n)
	}
}

// last_used_at is what stands between a long-lived client and the unused-client
// sweep, which cascade-deletes the codes and refresh tokens of anything it
// removes. Nothing on the refresh path resolves the client, so without an
// explicit touch a client that refreshes hourly for a month looks permanently
// idle — the exact case the sweep must not collect.
func TestRefreshRecordsThatTheClientWasUsed(t *testing.T) {
	store := newFakeTokenStore()
	h := newTokenTestHandler(store, &fakeMinter{}, nil)
	first := redeem(t, h, store)

	if touched := store.touchedClients(); len(touched) != 0 {
		t.Fatalf("touched = %v before any refresh", touched)
	}
	if rec := postForm(t, h, refreshForm(first)); rec.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", rec.Code, rec.Body.String())
	}
	touched := store.touchedClients()
	if len(touched) != 1 || touched[0] != testClientID {
		t.Fatalf("touched = %v, want [%s] — the sweep will treat this client as idle", touched, testClientID)
	}
}

// A legacy row with no grant_types at all must not be read as "deny everything"
// — that would log out every client registered before normalisation landed.
func TestRefreshAllowsAClientWithNoRecordedGrantTypes(t *testing.T) {
	store := newFakeTokenStore()
	h := newTokenTestHandler(store, &fakeMinter{}, nil)
	first := redeem(t, h, store)

	store.mu.Lock()
	store.clients[testClientID].GrantTypes = nil
	store.mu.Unlock()

	if rec := postForm(t, h, refreshForm(first)); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
}

// A storage failure on the pre-read must not be readable as "no such token",
// and must never mint.
func TestRefreshReadFailureFailsClosed(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)
	first := redeem(t, h, store)
	store.getRefreshErr = errors.New("connection refused")

	rec := postForm(t, h, refreshForm(first))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body %s", rec.Code, rec.Body.String())
	}
	if minter.n != 1 {
		t.Error("a token was minted despite a storage failure")
	}
}

func TestRefreshCanNarrowScope(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newTokenTestHandler(store, minter, nil)
	first := redeem(t, h, store)

	form := refreshForm(first)
	form.Set("scope", "shorts:read")
	rec := postForm(t, h, form)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	last := minter.seen[len(minter.seen)-1]
	if last.Scope != "shorts:read" {
		t.Errorf("scope = %q, want the narrowed set", last.Scope)
	}
}

// ------------------------------------------------------------ plumbing rules

func TestTokenEndpointRefusesNonPOST(t *testing.T) {
	h := newTokenTestHandler(newFakeTokenStore(), &fakeMinter{}, nil)
	req := httptest.NewRequest(http.MethodGet, TokenPath, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rec.Code)
	}
}

// An unconfigured deployment must say so rather than pretend.
func TestTokenEndpointWithoutAStoreIsUnavailable(t *testing.T) {
	h := NewTokenHandler(TokenConfig{Endpoints: Endpoints{APIBaseURL: testAPIBase}, Minter: &fakeMinter{}})
	rec := postForm(t, h, url.Values{"grant_type": {"authorization_code"}})
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

// The verifier is compared as a digest, so the challenge stored by the grant
// must be the one this endpoint recomputes. Pin the vector so a change of
// encoding (padded base64, hex) is caught here rather than in production.
func TestChallengeForVerifierMatchesRFC7636(t *testing.T) {
	if got := challengeFor(testVerifier); got != testChallenge {
		t.Errorf("challengeFor(%q) = %q, want %q", testVerifier, got, testChallenge)
	}
	sum := sha256.Sum256([]byte(testVerifier))
	if base64.RawURLEncoding.EncodeToString(sum[:]) != testChallenge {
		t.Fatal("the test vector itself is wrong")
	}
}
