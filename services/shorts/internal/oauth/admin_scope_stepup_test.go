package oauth

// A client registered before crawl:authorize existed holds the older admin
// vocabulary. These tests pin the step-up rule in normaliseScope: a named scope
// of an entitlement-gated resource is granted without being in the client's
// registration, and nothing else crosses resources. See authorize.go step 6.

import (
	"net/http"
	"testing"
)

// registeredBeforeCrawl is the admin scope set a connector registered before
// crawl:authorize was published.
const registeredBeforeCrawl = "news:publish jobs:run jobs:read users:read"

const allFiveAdminScopes = "news:publish jobs:run jobs:read users:read crawl:authorize"

func TestStaleAdminRegistrationCanStepUpToEveryAdminScope(t *testing.T) {
	// Consent ticket mint: the screen is built from the same normaliseScope.
	cstore := newConsentStore()
	cstore.clients[testClientID].Scope = registeredBeforeCrawl
	_, ticket := newAdminConsentHandlers(cstore, allow(testUserID).check)
	body := adminConsentBody()
	body["scope"] = allFiveAdminScopes
	rec := postConsent(t, ticket, ConsentTicketPath, testInternalSecret, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("consent ticket: status %d %s; a stale registration must not lock the client out", rec.Code, rec.Body.String())
	}
	if got := decodeTokenResponse(t, rec)["scope"]; got != allFiveAdminScopes {
		t.Fatalf("consent scope = %v, want %q", got, allFiveAdminScopes)
	}

	// Grant: the ticket the human approved for those five scopes is redeemed.
	store := defaultStore()
	store.clients[testClientID].Scope = registeredBeforeCrawl
	seedTicket(store, "admin-ticket", func(ct *ConsentTicket) {
		ct.Resource = testAdminResource
		ct.Scope = allFiveAdminScopes
	})
	gbody := defaultBody()
	gbody["consent_ticket"] = "admin-ticket"
	gbody["resource"] = testAdminResource
	gbody["scope"] = allFiveAdminScopes
	delete(gbody, "id_token")
	h := NewGrantHandler(GrantConfig{
		Endpoints:        Endpoints{APIBaseURL: testAPIBase, ConsentURL: "https://example.test/oauth/authorize"},
		Store:            store,
		Consent:          store,
		AdminEntitlement: allow(testUserID).check,
	})
	rec = post(t, h, gbody)
	if rec.Code != http.StatusOK || len(store.codes) != 1 {
		t.Fatalf("grant: status %d, codes %d (%s)", rec.Code, len(store.codes), rec.Body.String())
	}
	if got := store.codes[0].Scope; got != allFiveAdminScopes {
		t.Fatalf("granted scope = %q, want %q", got, allFiveAdminScopes)
	}
}

func TestStepUpDoesNotReachThePublicResource(t *testing.T) {
	resources := grantableResources(testAPIBase, allow(testUserID).check)
	public, _ := resolveResource(resources, testResource)

	// The same client, registered for admin scopes, asks the PUBLIC resource for
	// a read scope it did not register. Still refused.
	if _, ok := normaliseScope(public, "politics:read", registeredBeforeCrawl); ok {
		t.Fatal("an unregistered public scope was granted to an admin-registered client")
	}
	// And the public resource's own alerts:write exemption is still the only one.
	if got, ok := normaliseScope(public, "alerts:write", registeredBeforeCrawl); !ok || got != "alerts:write" {
		t.Fatalf("alerts:write on public = %q, %v; want the existing exemption", got, ok)
	}
}

func TestAdminScopeIsNotGrantableOnThePublicResource(t *testing.T) {
	resources := grantableResources(testAPIBase, allow(testUserID).check)
	public, _ := resolveResource(resources, testResource)
	for _, s := range []string{"crawl:authorize", "news:publish", "jobs:run"} {
		if _, ok := normaliseScope(public, s, "shorts:read alerts:write "+allFiveAdminScopes); ok {
			t.Errorf("admin scope %q was granted against the public resource", s)
		}
	}
}

func TestUnknownScopeIsRefusedEvenOnTheAdminResource(t *testing.T) {
	resources := grantableResources(testAPIBase, allow(testUserID).check)
	admin, _ := resolveResource(resources, testAdminResource)
	for _, requested := range []string{"crawl:delete", "shorts:read", "admin", "crawl:authorize crawl:delete"} {
		if got, ok := normaliseScope(admin, requested, registeredBeforeCrawl); ok {
			t.Errorf("admin resource granted %q as %q", requested, got)
		}
	}
}

// A refresh narrows the stored grant and can never widen it, whatever the
// registration says. The step-up rule does not reach refresh at all.
func TestAdminRefreshCannotWidenToAStepUpScope(t *testing.T) {
	store := newFakeTokenStore()
	h := newAdminTokenHandler(store, &fakeMinter{}, allow("uid-1").check)
	rec := postForm(t, h, codeForm(seedAdminCode(t, store), testVerifier))
	if rec.Code != http.StatusOK {
		t.Fatalf("exchange: %d %s", rec.Code, rec.Body.String())
	}
	rt, _ := decodeTokenResponse(t, rec)["refresh_token"].(string)

	form := refreshForm(rt)
	form.Set("scope", "news:publish crawl:authorize")
	rec = postForm(t, h, form)
	if rec.Code == http.StatusOK {
		t.Fatal("a refresh widened the admin grant to crawl:authorize")
	}
	if got := decodeTokenResponse(t, rec)["error"]; got != "invalid_scope" {
		t.Fatalf("error = %v, want invalid_scope", got)
	}
}
