package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------- test doubles

type fakeIdentity struct {
	userID string
	err    error
	seen   string
}

func (f *fakeIdentity) VerifyIDToken(_ context.Context, idToken string) (Identity, error) {
	f.seen = idToken
	if f.err != nil {
		return Identity{}, f.err
	}
	return Identity{UserID: f.userID, Email: f.userID + "@example.test"}, nil
}

type fakeStore struct {
	clients map[string]*Client
	codes   []AuthorizationCode
	getErr  error
	putErr  error
}

func (f *fakeStore) GetClient(_ context.Context, clientID string) (*Client, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	c, ok := f.clients[clientID]
	if !ok {
		return nil, nil
	}
	return c, nil
}

func (f *fakeStore) CreateAuthorizationCode(_ context.Context, code AuthorizationCode) error {
	if f.putErr != nil {
		return f.putErr
	}
	f.codes = append(f.codes, code)
	return nil
}

const (
	testAPIBase     = "https://api.example.test"
	testClientID    = "client-abc"
	testRedirectURI = "https://app.example/cb"
	testChallenge   = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
)

func newTestHandler(t *testing.T, ident IdentityVerifier, store Store) http.Handler {
	t.Helper()
	return NewGrantHandler(GrantConfig{
		Endpoints: Endpoints{APIBaseURL: testAPIBase, ConsentURL: "https://example.test/oauth/authorize"},
		Identity:  ident,
		Store:     store,
	})
}

func defaultStore() *fakeStore {
	return &fakeStore{clients: map[string]*Client{
		testClientID: {
			ClientID:     testClientID,
			ClientName:   "Test Client",
			RedirectURIs: []string{"https://app.example/other", testRedirectURI},
			GrantTypes:   []string{"authorization_code", "refresh_token"},
		},
	}}
}

func defaultBody() map[string]any {
	return map[string]any{
		"id_token":              "firebase-id-token",
		"client_id":             testClientID,
		"redirect_uri":          testRedirectURI,
		"code_challenge":        testChallenge,
		"code_challenge_method": "S256",
		"resource":              testAPIBase + "/mcp",
		"scope":                 "shorts:read housing:read",
		"state":                 "opaque-state-value",
	}
}

func post(t *testing.T, h http.Handler, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, GrantPath, strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var e struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("error body is not JSON: %v (%s)", err, rec.Body.String())
	}
	return e.Error
}

// ------------------------------------------------------------- happy path/iss

func TestGrantReturnsRedirectCarryingStateAndIss(t *testing.T) {
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), defaultBody())

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		RedirectTo string `json:"redirect_to"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(resp.RedirectTo)
	if err != nil {
		t.Fatalf("redirect_to is not a URL: %v", err)
	}
	if u.Scheme+"://"+u.Host+u.Path != testRedirectURI {
		t.Errorf("redirect target = %q, want %q", u.Scheme+"://"+u.Host+u.Path, testRedirectURI)
	}
	q := u.Query()
	if q.Get("code") == "" {
		t.Error("no code in redirect")
	}
	if q.Get("state") != "opaque-state-value" {
		t.Errorf("state = %q", q.Get("state"))
	}
	// RFC 9207: without iss a client cannot tell which AS issued the code, which
	// is the mix-up attack.
	if q.Get("iss") != testAPIBase {
		t.Errorf("iss = %q, want %q", q.Get("iss"), testAPIBase)
	}
}

// THE CODE IS NEVER WRITTEN DOWN. What lands in storage is sha256(code); a dump
// of the table cannot be replayed at the token endpoint.
func TestGrantStoresOnlyAHashOfTheCode(t *testing.T) {
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), defaultBody())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var resp struct {
		RedirectTo string `json:"redirect_to"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(resp.RedirectTo)
	code := u.Query().Get("code")

	if len(store.codes) != 1 {
		t.Fatalf("stored %d codes, want 1", len(store.codes))
	}
	stored := store.codes[0]
	sum := sha256.Sum256([]byte(code))
	if stored.CodeHash != hex.EncodeToString(sum[:]) {
		t.Errorf("CodeHash = %q, want sha256(code)", stored.CodeHash)
	}
	if strings.Contains(stored.CodeHash, code) || stored.CodeHash == code {
		t.Error("the raw code reached storage")
	}
	if stored.UserID != "uid-1" {
		t.Errorf("UserID = %q", stored.UserID)
	}
	if stored.ClientID != testClientID || stored.RedirectURI != testRedirectURI {
		t.Errorf("code not bound to client+redirect: %+v", stored)
	}
	if stored.CodeChallenge != testChallenge || stored.CodeChallengeMethod != "S256" {
		t.Errorf("PKCE not bound: %+v", stored)
	}
	if stored.Resource != testAPIBase+"/mcp" {
		t.Errorf("Resource = %q", stored.Resource)
	}
	// 60-second TTL: an authorization code is spent within seconds of being
	// issued, and a longer window is only useful to someone who stole it.
	ttl := time.Until(stored.ExpiresAt)
	if ttl <= 0 || ttl > CodeTTL {
		t.Errorf("TTL = %s, want (0, %s]", ttl, CodeTTL)
	}
	// Task 4 consumes it. Nothing is consumed here.
	if !stored.ConsumedAt.IsZero() {
		t.Error("code was born consumed")
	}
}

// ------------------------------------------------------------------- identity

func TestGrantRejectsMissingFirebaseIDToken(t *testing.T) {
	body := defaultBody()
	delete(body, "id_token")
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, defaultStore()), body)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if got := decodeError(t, rec); got != "invalid_token" {
		t.Errorf("error = %q", got)
	}
}

func TestGrantRejectsInvalidFirebaseIDToken(t *testing.T) {
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{err: errors.New("signature mismatch")}, store), defaultBody())
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if len(store.codes) != 0 {
		t.Error("a code was minted for an unverified identity")
	}
}

// An expired ID token is what Firebase reports as a verification failure; the
// grant must not mint on it, and must not leak why beyond "invalid_token".
func TestGrantRejectsExpiredFirebaseIDToken(t *testing.T) {
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{err: errors.New("ID token has expired")}, store), defaultBody())
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if got := decodeError(t, rec); got != "invalid_token" {
		t.Errorf("error = %q", got)
	}
	if len(store.codes) != 0 {
		t.Error("a code was minted for an expired identity")
	}
}

func TestGrantRejectsAnIdentityWithNoSubject(t *testing.T) {
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: ""}, store), defaultBody())
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if len(store.codes) != 0 {
		t.Error("a code was minted for an empty subject")
	}
}

// --------------------------------------------------------------------- client

func TestGrantRejectsUnknownClient(t *testing.T) {
	body := defaultBody()
	body["client_id"] = "not-registered"
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if got := decodeError(t, rec); got != "invalid_client" {
		t.Errorf("error = %q", got)
	}
	if len(store.codes) != 0 {
		t.Error("a code was minted for an unknown client")
	}
}

// ------------------------------------------------------------- redirect_uri

// THE OPEN-REDIRECT TEST. Every one of these is a prefix, suffix or
// case-variation of a registered URI that a sloppy comparison would accept, and
// each one hands the code to an attacker-controlled origin.
func TestGrantRejectsRedirectURIThatIsNotAnExactRegisteredString(t *testing.T) {
	for _, presented := range []string{
		"https://app.example/cb.attacker.com",     // prefix match would pass
		"https://app.example/cb/../../evil",       // path traversal off a prefix
		"https://app.example/cb?next=//evil.test", // registered value as a prefix
		"https://app.example/cbx",                 // prefix match would pass
		"https://app.example.evil/cb",             // host suffix confusion
		"https://APP.EXAMPLE/cb",                  // case-insensitive match would pass
		"http://app.example/cb",                   // scheme downgrade
		"https://app.example/cb/",                 // trailing slash is a different URI
		"https://evil.test/cb",                    // unrelated
		"https://app.example/cb#x",                // fragment appended
		"https://user@app.example/cb",             // userinfo smuggling
		"https://app.example:443/cb",              // default-port variant
	} {
		t.Run(presented, func(t *testing.T) {
			body := defaultBody()
			body["redirect_uri"] = presented
			store := defaultStore()
			rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			if got := decodeError(t, rec); got != "invalid_request" {
				t.Errorf("error = %q", got)
			}
			if len(store.codes) != 0 {
				t.Fatalf("a code was minted for redirect_uri %q — open redirect", presented)
			}
		})
	}
}

func TestGrantRejectsMissingRedirectURI(t *testing.T) {
	body := defaultBody()
	delete(body, "redirect_uri")
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(store.codes) != 0 {
		t.Error("a code was minted with no redirect URI")
	}
}

// ----------------------------------------------------------------------- PKCE

func TestGrantRejectsPlainCodeChallengeMethod(t *testing.T) {
	body := defaultBody()
	body["code_challenge_method"] = "plain"
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if got := decodeError(t, rec); got != "invalid_request" {
		t.Errorf("error = %q", got)
	}
	if len(store.codes) != 0 {
		t.Error("a plain-PKCE code was minted")
	}
}

// Absent method defaults to "plain" under RFC 7636, so treating absent as OK is
// a silent downgrade. It must be explicit.
func TestGrantRejectsMissingCodeChallengeMethod(t *testing.T) {
	body := defaultBody()
	delete(body, "code_challenge_method")
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if len(store.codes) != 0 {
		t.Error("a code with no PKCE method was minted")
	}
}

func TestGrantRejectsMissingCodeChallenge(t *testing.T) {
	body := defaultBody()
	delete(body, "code_challenge")
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if len(store.codes) != 0 {
		t.Error("a code with no PKCE challenge was minted")
	}
}

// ------------------------------------------------------------------- resource

func TestGrantRejectsUnknownResource(t *testing.T) {
	for _, resource := range []string{
		"https://api.shorted.com.au/mcp", // another deployment
		testAPIBase + "/mcp/../admin",    // traversal
		testAPIBase,                      // the Connect API is not grantable here
		"https://evil.test/mcp",
	} {
		t.Run(resource, func(t *testing.T) {
			body := defaultBody()
			body["resource"] = resource
			store := defaultStore()
			rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", rec.Code)
			}
			if got := decodeError(t, rec); got != "invalid_target" {
				t.Errorf("error = %q, want invalid_target (RFC 8707 §2)", got)
			}
			if len(store.codes) != 0 {
				t.Fatalf("a code was minted for resource %q", resource)
			}
		})
	}
}

// Exactly one resource is grantable, so an absent one is unambiguous and
// defaulting it is provably not a widening. (NewGrantHandler asserts that
// equivalence: the default only applies while len(resources) == 1.)
func TestGrantDefaultsAnAbsentResourceToTheOnlyGrantableOne(t *testing.T) {
	body := defaultBody()
	delete(body, "resource")
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if store.codes[0].Resource != testAPIBase+"/mcp" {
		t.Errorf("Resource = %q", store.codes[0].Resource)
	}
}

// ---------------------------------------------------------------------- scope

func TestGrantRejectsUnknownScope(t *testing.T) {
	body := defaultBody()
	body["scope"] = "shorts:read admin:write"
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := decodeError(t, rec); got != "invalid_scope" {
		t.Errorf("error = %q", got)
	}
	if len(store.codes) != 0 {
		t.Error("a code was minted carrying an unknown scope")
	}
}

func TestGrantRecordsTheRequestedScope(t *testing.T) {
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), defaultBody())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if store.codes[0].Scope != "shorts:read housing:read" {
		t.Errorf("Scope = %q", store.codes[0].Scope)
	}
}

// ------------------------------------------------------------------- plumbing

func TestGrantRejectsNonPOST(t *testing.T) {
	h := newTestHandler(t, &fakeIdentity{userID: "uid-1"}, defaultStore())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, GrantPath, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", rec.Code)
	}
}

// A storage failure must not be reported as success, and must not look like a
// client error the consent screen would retry differently.
func TestGrantFailsClosedWhenStorageFails(t *testing.T) {
	store := defaultStore()
	store.putErr = errors.New("connection refused")
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), defaultBody())
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if got := decodeError(t, rec); got != "server_error" {
		t.Errorf("error = %q", got)
	}
}

func TestGrantWithoutAStoreIsUnavailableRatherThanPanicking(t *testing.T) {
	h := NewGrantHandler(GrantConfig{Endpoints: Endpoints{APIBaseURL: testAPIBase}, Identity: &fakeIdentity{userID: "uid-1"}})
	rec := post(t, h, defaultBody())
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestGrantCodesAreUnpredictableAndDistinct(t *testing.T) {
	store := defaultStore()
	h := newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store)
	seen := map[string]bool{}
	for i := 0; i < 16; i++ {
		rec := post(t, h, defaultBody())
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		var resp struct {
			RedirectTo string `json:"redirect_to"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		u, _ := url.Parse(resp.RedirectTo)
		code := u.Query().Get("code")
		if len(code) < 32 {
			t.Fatalf("code %q is too short to be unguessable", code)
		}
		if seen[code] {
			t.Fatalf("duplicate code %q", code)
		}
		seen[code] = true
	}
}
