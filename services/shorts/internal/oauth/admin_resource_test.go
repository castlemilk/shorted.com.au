package oauth

// Tests for the second grantable resource: the admin MCP server at /mcp/admin
// with the news:publish scope. See resources.go for the rules these pin.

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

const testAdminResource = testAPIBase + "/mcp/admin"

// adminAllowlist is an Entitlement that approves exactly the listed users and
// records every user id it was asked about.
type adminAllowlist struct {
	allowed map[string]bool
	err     error
	asked   []string
}

func (a *adminAllowlist) check(_ context.Context, userID string) (bool, error) {
	a.asked = append(a.asked, userID)
	if a.err != nil {
		return false, a.err
	}
	return a.allowed[userID], nil
}

func allow(ids ...string) *adminAllowlist {
	a := &adminAllowlist{allowed: map[string]bool{}}
	for _, id := range ids {
		a.allowed[id] = true
	}
	return a
}

// ------------------------------------------------------------ resolution

func TestAbsentResourceStillDefaultsToThePublicServer(t *testing.T) {
	resources := grantableResources(testAPIBase, allow(testUserID).check)
	got, ok := resolveResource(resources, "")
	if !ok || got.uri != testResource {
		t.Fatalf("empty resource resolved to %+v, want %s — nothing may ever default to the admin resource", got, testResource)
	}
}

func TestAdminResourceIsNotGrantableWithoutAnEntitlement(t *testing.T) {
	if _, ok := resolveResource(grantableResources(testAPIBase, nil), testAdminResource); ok {
		t.Fatal("with no admin entitlement configured the admin resource must not exist")
	}
}

func TestScopesDoNotCrossResources(t *testing.T) {
	resources := grantableResources(testAPIBase, allow(testUserID).check)
	public, _ := resolveResource(resources, testResource)
	admin, _ := resolveResource(resources, testAdminResource)

	if _, ok := normaliseScope(public, "news:publish", ""); ok {
		t.Error("news:publish was grantable against the public /mcp resource")
	}
	if _, ok := normaliseScope(admin, "shorts:read", ""); ok {
		t.Error("shorts:read was grantable against the admin resource")
	}
	// An empty request gets the RESOURCE's own vocabulary — the public default
	// must not have grown to include the admin scope.
	if got, _ := normaliseScope(public, "", ""); strings.Contains(got, "news:publish") {
		t.Errorf("default public grant %q includes news:publish", got)
	}
	if got, ok := normaliseScope(admin, "", ""); !ok || got != "news:publish" {
		t.Errorf("default admin grant = %q, %v; want news:publish", got, ok)
	}
}

// ------------------------------------------------------------ consent ticket

func newAdminConsentHandlers(store *fakeConsentStore, ent Entitlement) (describe, ticket http.Handler) {
	cfg := ConsentConfig{
		Endpoints:        Endpoints{APIBaseURL: testAPIBase, ConsentURL: "https://example.test/oauth/authorize"},
		Store:            store,
		Tickets:          store,
		Authorize:        InternalSecretAuthorizer(testInternalSecret, "production"),
		AdminEntitlement: ent,
	}
	return NewConsentDescribeHandler(cfg), NewConsentTicketHandler(cfg)
}

func adminConsentBody() map[string]any {
	body := consentBody()
	body["resource"] = testAdminResource
	body["scope"] = "news:publish"
	return body
}

func TestAdminConsentTicketIsMintedOnlyForAnAdmin(t *testing.T) {
	store := newConsentStore()
	_, ticket := newAdminConsentHandlers(store, allow("someone-else").check)
	rec := postConsent(t, ticket, ConsentTicketPath, testInternalSecret, adminConsentBody())
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin ticket: status = %d, want 403 (%s)", rec.Code, rec.Body.String())
	}
	if len(store.tickets) != 0 {
		t.Fatal("a ticket was stored for a non-admin")
	}

	store = newConsentStore()
	_, ticket = newAdminConsentHandlers(store, allow(testUserID).check)
	rec = postConsent(t, ticket, ConsentTicketPath, testInternalSecret, adminConsentBody())
	if rec.Code != http.StatusOK {
		t.Fatalf("admin ticket: status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	if len(store.tickets) != 1 || store.tickets[0].Resource != testAdminResource || store.tickets[0].Scope != "news:publish" {
		t.Fatalf("stored ticket = %+v", store.tickets)
	}
}

func TestAdminConsentFailsClosedWhenTheCheckFails(t *testing.T) {
	store := newConsentStore()
	a := allow(testUserID)
	a.err = errors.New("firebase unavailable")
	_, ticket := newAdminConsentHandlers(store, a.check)
	rec := postConsent(t, ticket, ConsentTicketPath, testInternalSecret, adminConsentBody())
	if rec.Code != http.StatusServiceUnavailable || len(store.tickets) != 0 {
		t.Fatalf("status = %d, tickets = %d; want 503 and none", rec.Code, len(store.tickets))
	}
}

func TestPublicConsentNeverConsultsTheAdminCheck(t *testing.T) {
	store := newConsentStore()
	a := allow() // nobody is an admin
	_, ticket := newAdminConsentHandlers(store, a.check)
	rec := postConsent(t, ticket, ConsentTicketPath, testInternalSecret, consentBody())
	if rec.Code != http.StatusOK {
		t.Fatalf("public ticket: status = %d (%s)", rec.Code, rec.Body.String())
	}
	if len(a.asked) != 0 {
		t.Fatalf("the admin check was consulted for the public resource: %v", a.asked)
	}
}

func TestDescribeShowsTheAdminScopeInPlainLanguage(t *testing.T) {
	store := newConsentStore()
	describe, _ := newAdminConsentHandlers(store, allow(testUserID).check)
	rec := postConsent(t, describe, ConsentDescribePath, testInternalSecret, adminConsentBody())
	if rec.Code != http.StatusOK {
		t.Fatalf("describe: status = %d (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Publish merged articles") {
		t.Fatalf("describe body lacks the news:publish description: %s", rec.Body.String())
	}
}

// ------------------------------------------------------------ grant

func TestAdminGrantRechecksEntitlement(t *testing.T) {
	store := defaultStore()
	seedTicket(store, "admin-ticket", func(ct *ConsentTicket) {
		ct.Resource = testAdminResource
		ct.Scope = "news:publish"
	})
	body := defaultBody()
	body["consent_ticket"] = "admin-ticket"
	body["resource"] = testAdminResource
	body["scope"] = "news:publish"
	delete(body, "id_token")

	// Removed from the allowlist between approval and grant.
	h := NewGrantHandler(GrantConfig{
		Endpoints:        Endpoints{APIBaseURL: testAPIBase, ConsentURL: "https://example.test/oauth/authorize"},
		Store:            store,
		Consent:          store,
		AdminEntitlement: allow().check,
	})
	rec := post(t, h, body)
	if rec.Code != http.StatusForbidden || len(store.codes) != 0 {
		t.Fatalf("status = %d, codes = %d; want 403 and none (%s)", rec.Code, len(store.codes), rec.Body.String())
	}

	store = defaultStore()
	seedTicket(store, "admin-ticket", func(ct *ConsentTicket) {
		ct.Resource = testAdminResource
		ct.Scope = "news:publish"
	})
	h = NewGrantHandler(GrantConfig{
		Endpoints:        Endpoints{APIBaseURL: testAPIBase, ConsentURL: "https://example.test/oauth/authorize"},
		Store:            store,
		Consent:          store,
		AdminEntitlement: allow(testUserID).check,
	})
	rec = post(t, h, body)
	if rec.Code != http.StatusOK || len(store.codes) != 1 || store.codes[0].Resource != testAdminResource {
		t.Fatalf("status = %d, codes = %+v (%s)", rec.Code, store.codes, rec.Body.String())
	}
}

// ------------------------------------------------------------ token + refresh

func newAdminTokenHandler(store TokenStore, minter TokenMinter, ent Entitlement) http.Handler {
	return NewTokenHandler(TokenConfig{
		Endpoints:        Endpoints{APIBaseURL: testAPIBase},
		Store:            store,
		Minter:           minter,
		AdminEntitlement: ent,
	})
}

func seedAdminCode(t *testing.T, store TokenStore) string {
	return seedCode(t, store, func(c *AuthorizationCode) {
		c.Resource = testAdminResource
		c.Scope = "news:publish"
	})
}

func TestAdminTokenIsAudienceBoundToTheAdminResource(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newAdminTokenHandler(store, minter, allow("uid-1").check)
	rec := postForm(t, h, codeForm(seedAdminCode(t, store), testVerifier))
	if rec.Code != http.StatusOK {
		t.Fatalf("exchange: %d %s", rec.Code, rec.Body.String())
	}
	if len(minter.seen) != 1 {
		t.Fatalf("minted %d tokens", len(minter.seen))
	}
	got := minter.seen[0]
	if len(got.Audience) != 1 || got.Audience[0] != testAdminResource || got.Scope != "news:publish" {
		t.Fatalf("minted %+v; want audience [%s] and scope news:publish only", got, testAdminResource)
	}
}

func TestAdminCodeExchangeRefusesARevokedAdmin(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	h := newAdminTokenHandler(store, minter, allow().check)
	rec := postForm(t, h, codeForm(seedAdminCode(t, store), testVerifier))
	if rec.Code != http.StatusBadRequest || len(minter.seen) != 0 {
		t.Fatalf("status = %d, minted = %d; want 400 and nothing", rec.Code, len(minter.seen))
	}
	if got := decodeTokenResponse(t, rec)["error"]; got != "invalid_grant" {
		t.Fatalf("error = %v, want invalid_grant", got)
	}
}

// The property that matters most: a refresh family is not a standing grant.
// Removing someone from the admin list must stop their NEXT refresh.
func TestAdminRefreshStopsWhenTheUserIsNoLongerAnAdmin(t *testing.T) {
	store := newFakeTokenStore()
	minter := &fakeMinter{}
	a := allow("uid-1")
	h := newAdminTokenHandler(store, minter, a.check)

	rec := postForm(t, h, codeForm(seedAdminCode(t, store), testVerifier))
	if rec.Code != http.StatusOK {
		t.Fatalf("exchange: %d %s", rec.Code, rec.Body.String())
	}
	rt, _ := decodeTokenResponse(t, rec)["refresh_token"].(string)

	// Still an admin: refresh works.
	rec = postForm(t, h, refreshForm(rt))
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh while admin: %d %s", rec.Code, rec.Body.String())
	}
	rt, _ = decodeTokenResponse(t, rec)["refresh_token"].(string)

	// Revoked.
	delete(a.allowed, "uid-1")
	minted := len(minter.seen)
	rec = postForm(t, h, refreshForm(rt))
	if rec.Code != http.StatusBadRequest || len(minter.seen) != minted {
		t.Fatalf("refresh after revocation: status = %d, minted %d more; want 400 and none", rec.Code, len(minter.seen)-minted)
	}
}

// A public-resource refresh never consults the admin check, so an outage of
// the admin lookup cannot take ordinary MCP sessions down with it.
func TestPublicRefreshIgnoresTheAdminCheck(t *testing.T) {
	store := newFakeTokenStore()
	a := allow()
	a.err = errors.New("firebase unavailable")
	h := newAdminTokenHandler(store, &fakeMinter{}, a.check)
	first := redeem(t, h, store)
	rec := postForm(t, h, refreshForm(first))
	if rec.Code != http.StatusOK {
		t.Fatalf("public refresh: %d %s", rec.Code, rec.Body.String())
	}
	if len(a.asked) != 0 {
		t.Fatalf("admin check consulted for the public resource: %v", a.asked)
	}
}

// Registration keeps news:publish (a client for the admin server declares it),
// and still drops scopes this AS has never heard of.
func TestRegistrationKeepsTheAdminScope(t *testing.T) {
	if got := filterScope("openid news:publish shorts:read made:up"); got != "news:publish shorts:read" {
		t.Fatalf("filterScope = %q", got)
	}
}
