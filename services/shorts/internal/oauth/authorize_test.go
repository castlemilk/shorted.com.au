package oauth

import (
	"context"
	"crypto/sha256"
	"fmt"
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
	tickets map[string]*ConsentTicket
	getErr  error
	putErr  error
	// ticketErr makes the consent read fail, which must fail CLOSED.
	ticketErr error
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

// ConsumeConsentTicket mirrors the SQL: a ticket is removed from the map as it
// is read, so a second presentation of the same ticket finds nothing. A fake
// that returned the ticket twice would let a replay test pass against a
// single-use guarantee that does not exist.
func (f *fakeStore) ConsumeConsentTicket(_ context.Context, ticketHash string) (*ConsentTicket, error) {
	if f.ticketErr != nil {
		return nil, f.ticketErr
	}
	t, ok := f.tickets[ticketHash]
	if !ok {
		return nil, nil
	}
	delete(f.tickets, ticketHash)
	return t, nil
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
	testTicket      = "consent-ticket-value"
	testUserID      = "uid-1"
)

func newTestHandler(t *testing.T, ident IdentityVerifier, store *fakeStore) http.Handler {
	t.Helper()
	return NewGrantHandler(GrantConfig{
		Endpoints: Endpoints{APIBaseURL: testAPIBase, ConsentURL: "https://example.test/oauth/authorize"},
		Identity:  ident,
		Store:     store,
		Consent:   store,
	})
}

func defaultStore() *fakeStore {
	return &fakeStore{
		clients: map[string]*Client{
			testClientID: {
				ClientID:     testClientID,
				ClientName:   "Test Client",
				RedirectURIs: []string{"https://app.example/other", testRedirectURI},
				GrantTypes:   []string{"authorization_code", "refresh_token"},
			},
		},
		// The approval a human gave, bound to exactly the request defaultBody
		// makes. Every binding here is re-checked by the grant.
		tickets: map[string]*ConsentTicket{
			HashConsentTicket(testTicket): {
				TicketHash:    HashConsentTicket(testTicket),
				UserID:        testUserID,
				ClientID:      testClientID,
				RedirectURI:   testRedirectURI,
				CodeChallenge: testChallenge,
				Resource:      testAPIBase + "/mcp",
				Scope:         "shorts:read housing:read",
				ExpiresAt:     time.Now().Add(ConsentTicketTTL),
			},
		},
	}
}

// seedTicket adds an approval for a variant of the default request. Tests that
// change what is asked for must change what was approved too — that symmetry is
// the property, not an inconvenience.
func seedTicket(store *fakeStore, ticket string, mutate func(*ConsentTicket)) {
	t := ConsentTicket{
		TicketHash:    HashConsentTicket(ticket),
		UserID:        testUserID,
		ClientID:      testClientID,
		RedirectURI:   testRedirectURI,
		CodeChallenge: testChallenge,
		Resource:      testAPIBase + "/mcp",
		Scope:         "shorts:read housing:read",
		ExpiresAt:     time.Now().Add(ConsentTicketTTL),
	}
	if mutate != nil {
		mutate(&t)
	}
	store.tickets[t.TicketHash] = &t
}

func defaultBody() map[string]any {
	return map[string]any{
		"consent_ticket":        testTicket,
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

// The ticket is the authority, so an ID token is optional. This is the change
// Task 6 made deliberately: the consent screen's server side has already
// established the session, and requiring the browser to also hold a live
// Firebase ID token made the flow fail for a signed-in user whose Firebase
// client session had lapsed — while adding nothing an attacker could not steal.
func TestGrantAcceptsAConsentTicketWithoutAnIDToken(t *testing.T) {
	store := defaultStore()
	body := defaultBody()
	delete(body, "id_token")
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: testUserID}, store), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if len(store.codes) != 1 || store.codes[0].UserID != testUserID {
		t.Fatalf("code was not bound to the approving user: %+v", store.codes)
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
		// One approval buys exactly one code, so each iteration needs its own.
		ticket := fmt.Sprintf("consent-ticket-%d", i)
		seedTicket(store, ticket, nil)
		body := defaultBody()
		body["consent_ticket"] = ticket
		rec := post(t, h, body)
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

// A client that declared a scope set at registration is held to it. Otherwise
// the registered scope is decorative and any client can ask for everything.
func TestGrantRejectsScopeBeyondTheClientsRegisteredSet(t *testing.T) {
	store := defaultStore()
	store.clients[testClientID].Scope = "shorts:read"
	body := defaultBody()
	body["scope"] = "shorts:read politics:read"
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if got := decodeError(t, rec); got != "invalid_scope" {
		t.Errorf("error = %q", got)
	}
	if len(store.codes) != 0 {
		t.Error("a code was minted beyond the client's registered scope")
	}
}

func TestGrantDefaultsToTheClientsRegisteredScope(t *testing.T) {
	store := defaultStore()
	store.clients[testClientID].Scope = "housing:read"
	seedTicket(store, "narrow-ticket", func(tk *ConsentTicket) { tk.Scope = "housing:read" })
	body := defaultBody()
	body["consent_ticket"] = "narrow-ticket"
	delete(body, "scope")
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "uid-1"}, store), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if store.codes[0].Scope != "housing:read" {
		t.Errorf("Scope = %q", store.codes[0].Scope)
	}
}

// The consent screen lives on the WEB origin and this endpoint on the API
// origin, so the approve POST is cross-origin: without a preflight answer the
// flow dead-ends in the browser.
func TestGrantAnswersThePreflightFromTheConsentOrigin(t *testing.T) {
	h := newTestHandler(t, &fakeIdentity{userID: "uid-1"}, defaultStore())
	req := httptest.NewRequest(http.MethodOptions, GrantPath, nil)
	req.Header.Set("Origin", "https://example.test")
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://example.test" {
		t.Errorf("Access-Control-Allow-Origin = %q", got)
	}
	// Never credentialed: identity is a body-borne ID token, not a cookie, so
	// there is no ambient authority for a cross-site page to ride.
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Errorf("Access-Control-Allow-Credentials = %q, want unset", got)
	}
}

func TestGrantDoesNotAllowAnUnknownBrowserOrigin(t *testing.T) {
	h := newTestHandler(t, &fakeIdentity{userID: "uid-1"}, defaultStore())
	for _, origin := range []string{"https://evil.test", "null", "https://example.test.evil"} {
		req := httptest.NewRequest(http.MethodOptions, GrantPath, nil)
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("origin %q got Access-Control-Allow-Origin %q, want unset", origin, got)
		}
	}
}

// ------------------------------------------------------------ consent tickets
//
// These are the tests for the property Task 6 exists to create: an
// authorization code is issued only when a human approved THIS request. Each
// one asserts a way the check could be absent while everything else still
// worked.

func TestGrantWithoutAConsentTicketIssuesNothing(t *testing.T) {
	store := defaultStore()
	body := defaultBody()
	delete(body, "consent_ticket")
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: testUserID}, store), body)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if got := decodeError(t, rec); got != "access_denied" {
		t.Errorf("error = %q, want access_denied", got)
	}
	if len(store.codes) != 0 {
		t.Fatal("a code was minted without any human approving it")
	}
}

// The exact attack the ticket exists to stop: a valid Firebase ID token, a
// client the attacker registered themselves, and no human anywhere.
func TestAStolenIDTokenAloneCannotProduceACode(t *testing.T) {
	store := defaultStore()
	store.tickets = map[string]*ConsentTicket{} // nobody has approved anything
	body := defaultBody()
	delete(body, "consent_ticket")

	rec := post(t, newTestHandler(t, &fakeIdentity{userID: testUserID}, store), body)
	if rec.Code == http.StatusOK {
		t.Fatal("a stolen ID token bought an authorization code")
	}
	if len(store.codes) != 0 {
		t.Fatal("a code exists for a grant nobody approved")
	}
}

func TestGrantRejectsAnUnknownConsentTicket(t *testing.T) {
	store := defaultStore()
	body := defaultBody()
	body["consent_ticket"] = "not-a-ticket-we-issued"
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: testUserID}, store), body)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if len(store.codes) != 0 {
		t.Error("a code was minted for a forged ticket")
	}
}

// One approval buys one code. Without this, observing a ticket once would let
// an attacker mint codes until it expired.
func TestAConsentTicketIsSpentExactlyOnce(t *testing.T) {
	store := defaultStore()
	h := newTestHandler(t, &fakeIdentity{userID: testUserID}, store)

	if rec := post(t, h, defaultBody()); rec.Code != http.StatusOK {
		t.Fatalf("first grant: status = %d, body %s", rec.Code, rec.Body.String())
	}
	rec := post(t, h, defaultBody())
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("replay: status = %d, want 401", rec.Code)
	}
	if len(store.codes) != 1 {
		t.Fatalf("codes minted = %d, want 1 — a replayed ticket minted a second", len(store.codes))
	}
}

func TestGrantRejectsAnExpiredConsentTicket(t *testing.T) {
	store := defaultStore()
	seedTicket(store, "stale", func(tk *ConsentTicket) {
		tk.ExpiresAt = time.Now().Add(-time.Second)
	})
	body := defaultBody()
	body["consent_ticket"] = "stale"

	rec := post(t, newTestHandler(t, &fakeIdentity{userID: testUserID}, store), body)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if len(store.codes) != 0 {
		t.Error("an expired approval was honoured")
	}
}

// Each binding is a separate way the approval could be diverted, so each is
// asserted separately: a single "mismatch" test would pass with only one of
// the five checks implemented.
func TestGrantRejectsAConsentTicketApprovedForADifferentRequest(t *testing.T) {
	other := "https://app.example/other"
	cases := []struct {
		name    string
		mutate  func(*ConsentTicket)
		bodyKey string
		bodyVal any
	}{
		{
			name:   "another client",
			mutate: func(tk *ConsentTicket) { tk.ClientID = "someone-elses-client" },
		},
		{
			// The human approved a callback to one place; the request asks for
			// another the client also registered. Both are legitimate URIs, and
			// sending the code to the wrong one is still a diversion.
			name:   "another registered redirect URI",
			mutate: func(tk *ConsentTicket) { tk.RedirectURI = other },
		},
		{
			// Substituting the PKCE challenge is how an attacker who observes a
			// ticket redeems the resulting code with their own verifier.
			name:   "another PKCE challenge",
			mutate: func(tk *ConsentTicket) { tk.CodeChallenge = "a-different-challenge-value" },
		},
		{
			name:   "another resource",
			mutate: func(tk *ConsentTicket) { tk.Resource = "https://elsewhere.example/mcp" },
		},
		{
			// Widening the scope past what was shown is consent for one thing
			// spent on another.
			name:   "a narrower approved scope than the request",
			mutate: func(tk *ConsentTicket) { tk.Scope = "shorts:read" },
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := defaultStore()
			seedTicket(store, "mismatched", tc.mutate)
			body := defaultBody()
			body["consent_ticket"] = "mismatched"

			rec := post(t, newTestHandler(t, &fakeIdentity{userID: testUserID}, store), body)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (body %s)", rec.Code, rec.Body.String())
			}
			if got := decodeError(t, rec); got != "access_denied" {
				t.Errorf("error = %q, want access_denied", got)
			}
			if len(store.codes) != 0 {
				t.Error("a code was minted against an approval for a different request")
			}
			// The response must not name the field that differed: that would
			// turn this into an oracle for probing what a ticket approved.
			if strings.Contains(rec.Body.String(), "client_id") ||
				strings.Contains(rec.Body.String(), "code_challenge") {
				t.Errorf("the refusal names the mismatched binding: %s", rec.Body.String())
			}
		})
	}
}

// Scope is compared as a set, so the same grant in a different order is the
// same grant. Otherwise a legitimate approval fails for a reason no operator
// could ever diagnose.
func TestGrantAcceptsTheApprovedScopeInAnyOrder(t *testing.T) {
	store := defaultStore()
	seedTicket(store, "reordered", func(tk *ConsentTicket) { tk.Scope = "housing:read shorts:read" })
	body := defaultBody()
	body["consent_ticket"] = "reordered"

	rec := post(t, newTestHandler(t, &fakeIdentity{userID: testUserID}, store), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
}

// The ticket names who approved. An ID token naming someone else means the
// approval and the credential came from two different people.
func TestGrantRejectsAnIDTokenForADifferentUserThanApproved(t *testing.T) {
	store := defaultStore()
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: "someone-else"}, store), defaultBody())
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if got := decodeError(t, rec); got != "invalid_token" {
		t.Errorf("error = %q", got)
	}
	if len(store.codes) != 0 {
		t.Error("a code was minted for a user who did not approve")
	}
}

// The code must be bound to the human who approved, not to whoever asked.
func TestTheCodeIsBoundToTheApprovingUser(t *testing.T) {
	store := defaultStore()
	seedTicket(store, "someone-elses-approval", func(tk *ConsentTicket) { tk.UserID = "uid-approver" })
	body := defaultBody()
	body["consent_ticket"] = "someone-elses-approval"
	delete(body, "id_token")

	rec := post(t, newTestHandler(t, &fakeIdentity{userID: testUserID}, store), body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	if store.codes[0].UserID != "uid-approver" {
		t.Errorf("code UserID = %q, want the approving user", store.codes[0].UserID)
	}
}

// A consent store that is unreachable must refuse, never fall through to
// issuing a code. This is the one place in the OAuth surface where failing
// open would be failing open on consent itself.
func TestGrantFailsClosedWhenConsentCannotBeVerified(t *testing.T) {
	store := defaultStore()
	store.ticketErr = errors.New("connection refused")
	rec := post(t, newTestHandler(t, &fakeIdentity{userID: testUserID}, store), defaultBody())
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if len(store.codes) != 0 {
		t.Error("a degraded consent store let a code through")
	}
}

func TestGrantWithoutAConsentStoreIsUnavailableRatherThanUnguarded(t *testing.T) {
	h := NewGrantHandler(GrantConfig{
		Endpoints: Endpoints{APIBaseURL: testAPIBase},
		Identity:  &fakeIdentity{userID: testUserID},
		Store:     defaultStore(),
		// Consent deliberately nil — a wiring mistake must not silently
		// disable the consent requirement.
	})
	rec := post(t, h, defaultBody())
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
