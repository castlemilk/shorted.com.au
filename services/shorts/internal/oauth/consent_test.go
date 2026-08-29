package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
)

// ---------------------------------------------------------------- test doubles

type fakeConsentStore struct {
	clients   map[string]*Client
	tickets   []ConsentTicket
	getErr    error
	createErr error
}

func (f *fakeConsentStore) GetClient(_ context.Context, clientID string) (*Client, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	c, ok := f.clients[clientID]
	if !ok {
		return nil, nil
	}
	return c, nil
}

func (f *fakeConsentStore) CreateConsentTicket(_ context.Context, ticket ConsentTicket) error {
	if f.createErr != nil {
		return f.createErr
	}
	f.tickets = append(f.tickets, ticket)
	return nil
}

func (f *fakeConsentStore) ConsumeConsentTicket(_ context.Context, _ string) (*ConsentTicket, error) {
	return nil, nil
}

func newConsentStore() *fakeConsentStore {
	return &fakeConsentStore{clients: map[string]*Client{
		testClientID: {
			ClientID:     testClientID,
			ClientName:   "Test Client",
			RedirectURIs: []string{"https://app.example/other", testRedirectURI},
			GrantTypes:   []string{"authorization_code", "refresh_token"},
		},
	}}
}

const testInternalSecret = "internal-service-secret"

func newConsentHandlers(store *fakeConsentStore) (describe, ticket http.Handler) {
	cfg := ConsentConfig{
		Endpoints: Endpoints{APIBaseURL: testAPIBase, ConsentURL: "https://example.test/oauth/authorize"},
		Store:     store,
		Tickets:   store,
		Authorize: InternalSecretAuthorizer(testInternalSecret, "production"),
	}
	return NewConsentDescribeHandler(cfg), NewConsentTicketHandler(cfg)
}

func consentBody() map[string]any {
	return map[string]any{
		"user_id":               testUserID,
		"client_id":             testClientID,
		"redirect_uri":          testRedirectURI,
		"code_challenge":        testChallenge,
		"code_challenge_method": "S256",
		"resource":              testAPIBase + "/mcp",
		"scope":                 "shorts:read housing:read",
	}
}

func postConsent(t *testing.T, h http.Handler, path, secret string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// ------------------------------------------------------------------- the gate

// The whole security value of the ticket rests on this: an attacker holding a
// stolen user credential must not be able to mint one.
func TestConsentTicketRequiresTheInternalSecret(t *testing.T) {
	store := newConsentStore()
	_, ticket := newConsentHandlers(store)

	for _, secret := range []string{"", "wrong-secret", testInternalSecret + "x"} {
		rec := postConsent(t, ticket, ConsentTicketPath, secret, consentBody())
		if rec.Code != http.StatusForbidden {
			t.Fatalf("secret %q: status = %d, want 403", secret, rec.Code)
		}
	}
	if len(store.tickets) != 0 {
		t.Fatal("a consent ticket was minted without the internal secret")
	}
}

func TestConsentDescribeRequiresTheInternalSecret(t *testing.T) {
	store := newConsentStore()
	describe, _ := newConsentHandlers(store)
	if rec := postConsent(t, describe, ConsentDescribePath, "", consentBody()); rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

// A nil gate is a wiring mistake. On the endpoint that mints proof of consent,
// the safe reading of a wiring mistake is "no".
func TestConsentEndpointsFailClosedWithoutAnAuthorizer(t *testing.T) {
	store := newConsentStore()
	h := NewConsentTicketHandler(ConsentConfig{
		Endpoints: Endpoints{APIBaseURL: testAPIBase},
		Store:     store,
		Tickets:   store,
	})
	if rec := postConsent(t, h, ConsentTicketPath, testInternalSecret, consentBody()); rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if len(store.tickets) != 0 {
		t.Fatal("an unguarded handler minted a ticket")
	}
}

// A production deployment that lost its secret must refuse rather than open the
// endpoint to the internet, which is the failure mode the dev fallback creates
// if it is not bounded by environment.
func TestAnUnsetSecretInProductionRefuses(t *testing.T) {
	store := newConsentStore()
	h := NewConsentTicketHandler(ConsentConfig{
		Endpoints: Endpoints{APIBaseURL: testAPIBase},
		Store:     store,
		Tickets:   store,
		Authorize: InternalSecretAuthorizer("", "production"),
	})
	if rec := postConsent(t, h, ConsentTicketPath, "", consentBody()); rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestAnUnsetSecretOutsideProductionAllowsLocalDevelopment(t *testing.T) {
	store := newConsentStore()
	h := NewConsentTicketHandler(ConsentConfig{
		Endpoints: Endpoints{APIBaseURL: testAPIBase},
		Store:     store,
		Tickets:   store,
		Authorize: InternalSecretAuthorizer("", "development"),
	})
	if rec := postConsent(t, h, ConsentTicketPath, "", consentBody()); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
}

func TestConsentEndpointsAcceptTheInternalSecretHeaderToo(t *testing.T) {
	store := newConsentStore()
	_, ticket := newConsentHandlers(store)
	raw, _ := json.Marshal(consentBody())
	req := httptest.NewRequest(http.MethodPost, ConsentTicketPath, strings.NewReader(string(raw)))
	req.Header.Set("x-internal-secret", testInternalSecret)
	rec := httptest.NewRecorder()
	ticket.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
}

// These endpoints are server-to-server. A browser reaching them would defeat
// the point of the secret, and the absence of CORS headers is what enforces it.
func TestConsentEndpointsAreNotBrowserReachable(t *testing.T) {
	store := newConsentStore()
	_, ticket := newConsentHandlers(store)
	raw, _ := json.Marshal(consentBody())
	req := httptest.NewRequest(http.MethodPost, ConsentTicketPath, strings.NewReader(string(raw)))
	req.Header.Set("Authorization", "Bearer "+testInternalSecret)
	req.Header.Set("Origin", "https://example.test")
	rec := httptest.NewRecorder()
	ticket.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Access-Control-Allow-Origin = %q — this endpoint must not be callable from a browser", got)
	}
}

// -------------------------------------------------------------------- minting

func TestConsentTicketIsMintedHashedAndBoundToTheRequest(t *testing.T) {
	store := newConsentStore()
	_, ticket := newConsentHandlers(store)
	rec := postConsent(t, ticket, ConsentTicketPath, testInternalSecret, consentBody())

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Ticket    string `json:"consent_ticket"`
		ExpiresIn int    `json:"expires_in"`
		Scope     string `json:"scope"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Ticket) < 32 {
		t.Fatalf("ticket %q is too short to be unguessable", resp.Ticket)
	}
	if resp.ExpiresIn != int(ConsentTicketTTL.Seconds()) {
		t.Errorf("expires_in = %d", resp.ExpiresIn)
	}

	if len(store.tickets) != 1 {
		t.Fatalf("tickets stored = %d", len(store.tickets))
	}
	stored := store.tickets[0]

	// The raw ticket must never be written down — only its hash, exactly as
	// authorization codes and refresh tokens are.
	if stored.TicketHash == resp.Ticket {
		t.Fatal("the raw ticket was stored")
	}
	if stored.TicketHash != HashConsentTicket(resp.Ticket) {
		t.Fatal("stored hash is not sha256 of the issued ticket")
	}
	if stored.UserID != testUserID ||
		stored.ClientID != testClientID ||
		stored.RedirectURI != testRedirectURI ||
		stored.CodeChallenge != testChallenge ||
		stored.Resource != testAPIBase+"/mcp" {
		t.Errorf("bindings not recorded: %+v", stored)
	}
	if !stored.ConsumedAt.IsZero() {
		t.Error("a ticket was born consumed")
	}
	if d := time.Until(stored.ExpiresAt); d > ConsentTicketTTL+time.Second || d < time.Minute {
		t.Errorf("ExpiresAt is %v away, want about %v", d, ConsentTicketTTL)
	}
}

// A ticket with no subject would authorise a code for nobody.
func TestConsentTicketRequiresAUser(t *testing.T) {
	store := newConsentStore()
	_, ticket := newConsentHandlers(store)
	body := consentBody()
	delete(body, "user_id")
	if rec := postConsent(t, ticket, ConsentTicketPath, testInternalSecret, body); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if len(store.tickets) != 0 {
		t.Fatal("a ticket was minted with no approving user")
	}
}

// The consent endpoints apply the SAME validation the grant does. If they did
// not, the screen could describe and approve a request the grant then refuses —
// or worse, approve one it accepts on different terms.
func TestConsentRefusesWhatTheGrantWouldRefuse(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{"unknown client", func(b map[string]any) { b["client_id"] = "nope" }, "invalid_client"},
		{"unregistered redirect URI", func(b map[string]any) { b["redirect_uri"] = "https://evil.example/cb" }, "invalid_request"},
		{
			// The prefix a sloppy startswith check would accept.
			"a redirect URI that only prefixes a registered one",
			func(b map[string]any) { b["redirect_uri"] = testRedirectURI + ".evil.example" },
			"invalid_request",
		},
		{"plain PKCE", func(b map[string]any) { b["code_challenge_method"] = "plain" }, "invalid_request"},
		{"absent PKCE method", func(b map[string]any) { delete(b, "code_challenge_method") }, "invalid_request"},
		{"absent PKCE challenge", func(b map[string]any) { delete(b, "code_challenge") }, "invalid_request"},
		{"unknown resource", func(b map[string]any) { b["resource"] = "https://elsewhere.example/mcp" }, "invalid_target"},
		{"unknown scope", func(b map[string]any) { b["scope"] = "shorts:write" }, "invalid_scope"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newConsentStore()
			_, ticket := newConsentHandlers(store)
			body := consentBody()
			tc.mutate(body)

			rec := postConsent(t, ticket, ConsentTicketPath, testInternalSecret, body)
			if rec.Code == http.StatusOK {
				t.Fatalf("accepted: %s", rec.Body.String())
			}
			var e struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal(rec.Body.Bytes(), &e)
			if e.Error != tc.want {
				t.Errorf("error = %q, want %q", e.Error, tc.want)
			}
			if len(store.tickets) != 0 {
				t.Error("a ticket was minted for a request the grant would refuse")
			}
		})
	}
}

func TestConsentTicketFailsClosedWhenStorageFails(t *testing.T) {
	store := newConsentStore()
	store.createErr = errors.New("connection refused")
	_, ticket := newConsentHandlers(store)
	rec := postConsent(t, ticket, ConsentTicketPath, testInternalSecret, consentBody())
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	// A ticket returned to the caller but not stored would be spendable
	// nowhere; worse, a caller could not tell that from success.
	if strings.Contains(rec.Body.String(), "consent_ticket") {
		t.Error("a ticket was handed out that was never stored")
	}
}

// ------------------------------------------------------------------- describe

func TestConsentDescribeReturnsWhatTheHumanMustSee(t *testing.T) {
	store := newConsentStore()
	describe, _ := newConsentHandlers(store)
	rec := postConsent(t, describe, ConsentDescribePath, testInternalSecret, consentBody())

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		ClientID    string             `json:"client_id"`
		ClientName  string             `json:"client_name"`
		RedirectURI string             `json:"redirect_uri"`
		Scope       string             `json:"scope"`
		Scopes      []ScopeDescription `json:"scopes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.ClientName != "Test Client" || resp.ClientID != testClientID {
		t.Errorf("client not identified: %+v", resp)
	}
	// The redirect URI is on the screen because it is where the credential
	// goes. A consent screen that hides it asks the human to approve a
	// destination they were never shown.
	if resp.RedirectURI != testRedirectURI {
		t.Errorf("redirect_uri = %q", resp.RedirectURI)
	}
	if len(resp.Scopes) != 2 {
		t.Fatalf("scopes = %+v", resp.Scopes)
	}
	for _, s := range resp.Scopes {
		if s.Description == "" {
			t.Errorf("scope %q has no plain-language description", s.Scope)
		}
	}
}

// Describe must not write. A read that mints is a way to obtain a ticket
// without anyone approving.
func TestConsentDescribeMintsNothing(t *testing.T) {
	store := newConsentStore()
	describe, _ := newConsentHandlers(store)
	rec := postConsent(t, describe, ConsentDescribePath, testInternalSecret, consentBody())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(store.tickets) != 0 {
		t.Fatal("describe minted a consent ticket")
	}
	if strings.Contains(rec.Body.String(), "consent_ticket") {
		t.Fatal("describe returned a consent ticket")
	}
}

// Every scope this server grants must have copy, or the screen renders a bare
// machine string and the human cannot know what they are approving.
func TestEveryPublishedScopeHasPlainLanguageCopy(t *testing.T) {
	for _, s := range mcp.Scopes {
		got := DescribeScopes(s)
		if len(got) != 1 || got[0].Description == "" {
			t.Errorf("scope %q has no description", s)
		}
	}
}

func TestConsentEndpointsRejectNonPOST(t *testing.T) {
	store := newConsentStore()
	describe, ticket := newConsentHandlers(store)
	for _, h := range []http.Handler{describe, ticket} {
		req := httptest.NewRequest(http.MethodGet, ConsentTicketPath, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("status = %d, want 405", rec.Code)
		}
	}
}
