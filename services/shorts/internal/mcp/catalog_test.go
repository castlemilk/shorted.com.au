package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

func fetchCatalog(t *testing.T, src DataSource) (*httptest.ResponseRecorder, Catalog) {
	t.Helper()

	rec := httptest.NewRecorder()
	CatalogHandler(src, CatalogOptions{APIBaseURL: testCatalogOrigin}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/mcp/catalog.json", nil))

	var got Catalog
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("catalog is not valid JSON: %v\n%s", err, rec.Body.String())
	}
	return rec, got
}

// The catalog exists so the published server card stops being hand-written.
// If it can drift from Registry(), it has failed at the one job it has.
func TestCatalogListsExactlyWhatTheRegistryHolds(t *testing.T) {
	rec, got := fetchCatalog(t, &fakeDataSource{})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	registered := Registry()
	if got.ToolCount != len(registered) {
		t.Errorf("catalog toolCount = %d, Registry() holds %d", got.ToolCount, len(registered))
	}
	if len(got.Tools) != len(registered) {
		t.Fatalf("catalog lists %d tools, Registry() holds %d", len(got.Tools), len(registered))
	}

	served := map[string]CatalogTool{}
	for _, tool := range got.Tools {
		served[tool.Name] = tool
	}
	for _, want := range registered {
		tool, ok := served[want.Name]
		if !ok {
			t.Errorf("tool %q is in the registry but not in the catalog", want.Name)
			continue
		}
		if tool.Title != want.Title {
			t.Errorf("tool %q: catalog title %q, registry says %q", want.Name, tool.Title, want.Title)
		}
		if tool.Description != want.Description {
			t.Errorf("tool %q: catalog description differs from the registry's", want.Name)
		}
		if tool.Domain != want.Domain {
			t.Errorf("tool %q: catalog domain %q, registry says %q", want.Name, tool.Domain, want.Domain)
		}
		if tool.RPC != want.RPC {
			t.Errorf("tool %q: catalog rpc %q, registry says %q", want.Name, tool.RPC, want.RPC)
		}
		if len(tool.InputSchema) == 0 {
			t.Errorf("tool %q: no input schema in the catalog — a client reading only this cannot call it", want.Name)
		}
	}
}

// The card and the docs render resources and prompts from here too, so they
// have to be present and match their own registries.
func TestCatalogIncludesResourcesAndPrompts(t *testing.T) {
	_, got := fetchCatalog(t, &fakeDataSource{})

	if len(got.Resources) != len(Resources()) {
		t.Errorf("catalog lists %d resources, Resources() holds %d", len(got.Resources), len(Resources()))
	}
	if len(got.Prompts) != len(Prompts()) {
		t.Errorf("catalog lists %d prompts, Prompts() holds %d", len(got.Prompts), len(Prompts()))
	}
	for i, want := range Prompts() {
		if got.Prompts[i].Name != want.Name {
			t.Errorf("prompt %d: catalog says %q, registry says %q", i, got.Prompts[i].Name, want.Name)
		}
	}
}

// The card's transport.endpoint is rendered from this. A wrong value here
// breaks client discovery everywhere at once.
func TestCatalogPublishesTheServerIdentityAndEndpoint(t *testing.T) {
	_, got := fetchCatalog(t, &fakeDataSource{})

	if got.Server.Name != ServerName {
		t.Errorf("server name = %q, want %q", got.Server.Name, ServerName)
	}
	if got.Server.Version != ServerVersion {
		t.Errorf("server version = %q, want %q", got.Server.Version, ServerVersion)
	}
	if got.Server.Endpoint != PublicEndpoint {
		t.Errorf("endpoint = %q, want %q", got.Server.Endpoint, PublicEndpoint)
	}
	if got.Server.ProtocolVersion != latestProtocolVersion {
		t.Errorf("protocolVersion = %q, want %q", got.Server.ProtocolVersion, latestProtocolVersion)
	}
	// Phase 2 is anonymous. Publishing anything else here would send clients
	// looking for an OAuth flow that does not exist.
	if got.Authentication.Required {
		t.Error("catalog claims authentication is required; Phase 2 is anonymous")
	}
}

// A dead data source must not take the catalog down with it. Clients discover
// this server through the card, which renders from here — serving a degraded
// catalog beats serving a 500.
func TestCatalogDegradesRatherThanFailingWithoutADataSource(t *testing.T) {
	rec, got := fetchCatalog(t, nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 even with no data source", rec.Code)
	}
	if len(got.Tools) != len(Registry()) {
		t.Errorf("degraded catalog lists %d tools, Registry() holds %d", len(got.Tools), len(Registry()))
	}
	// Schemas come from the live server; names and descriptions come from the
	// registry and must survive regardless.
	for _, tool := range got.Tools {
		if tool.Description == "" {
			t.Errorf("tool %q lost its description in the degraded catalog", tool.Name)
		}
	}
}

// The catalog is built once and cached for the life of the process. Building
// it under the first request's context would let one client hanging up
// mid-build serve a permanently schema-less catalog to everyone after them.
func TestCatalogSurvivesACancelledFirstRequest(t *testing.T) {
	handler := CatalogHandler(&fakeDataSource{}, CatalogOptions{APIBaseURL: testCatalogOrigin})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec,
		httptest.NewRequest(http.MethodGet, "/mcp/catalog.json", nil).WithContext(ctx))

	// Second request, healthy context, same handler — must still have schemas.
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/mcp/catalog.json", nil))

	var got Catalog
	if err := json.Unmarshal(rec2.Body.Bytes(), &got); err != nil {
		t.Fatalf("catalog is not valid JSON: %v", err)
	}
	for _, tool := range got.Tools {
		if len(tool.InputSchema) == 0 {
			t.Fatalf("tool %q lost its input schema — the cached catalog was built "+
				"under the cancelled request's context", tool.Name)
		}
	}
}

func TestCatalogRejectsNonGET(t *testing.T) {
	rec := httptest.NewRecorder()
	CatalogHandler(&fakeDataSource{}, CatalogOptions{APIBaseURL: testCatalogOrigin}).ServeHTTP(rec,
		httptest.NewRequest(http.MethodPost, "/mcp/catalog.json", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d, want 405", rec.Code)
	}
}

// testCatalogOrigin is a non-production origin, so a test that accidentally
// asserted against the hardcoded public host would fail rather than pass by
// coincidence.
const testCatalogOrigin = "https://api.example.test"

// ---------------------------------------------------------- OAuth advertising

// Anonymous access is the adoption path. If this ever flips to true, 24 tools
// stop working for every client that has not been through a browser.
func TestTheCatalogStillSaysNoAuthenticationIsRequired(t *testing.T) {
	catalog := BuildCatalogForOrigin(context.Background(), nil, testCatalogOrigin)
	if catalog.Authentication.Required {
		t.Fatal("authentication.required went true — anonymous access is the adoption path")
	}
}

// A client that wants a higher ceiling should not have to discover the flow by
// first being refused.
func TestTheCatalogAdvertisesTheOAuthDiscoveryDocuments(t *testing.T) {
	catalog := BuildCatalogForOrigin(context.Background(), nil, testCatalogOrigin)
	auth := catalog.Authentication

	if auth.Optional != "oauth2" {
		t.Errorf("optional = %q", auth.Optional)
	}
	// Derived from the origin, not hardcoded: a dev or preview deployment must
	// advertise ITS OWN authorization server, or a client authorises against
	// production and gets a token this deployment refuses.
	if auth.ProtectedResourceMetadata != testCatalogOrigin+ProtectedResourceMetadataPath {
		t.Errorf("protectedResourceMetadata = %q", auth.ProtectedResourceMetadata)
	}
	if auth.AuthorizationServerMetadata != testCatalogOrigin+"/.well-known/oauth-authorization-server" {
		t.Errorf("authorizationServerMetadata = %q", auth.AuthorizationServerMetadata)
	}
	if len(auth.Scopes) != len(Scopes) {
		t.Errorf("scopes = %v, want the published vocabulary %v", auth.Scopes, Scopes)
	}
}

// The published ceiling is a promise. #455 found three tier rows over-promising
// against the code; the only way to keep a promise is to derive it from the
// thing that enforces it.
func TestThePublishedQuotasMatchWhatTheLimiterEnforces(t *testing.T) {
	catalog := BuildCatalogForOrigin(context.Background(), nil, testCatalogOrigin)
	limits := catalog.Authentication.RateLimits
	if limits == nil {
		t.Fatal("no rate limits published")
	}

	cfg := ratelimit.DefaultConfig()
	for _, tc := range []struct {
		tier      string
		published string
	}{
		{"anonymous", limits.Anonymous},
		{"free", limits.Free},
		{"premium", limits.Paid},
	} {
		enforced := cfg.Tiers[tc.tier]
		// The API column, not the browser column. Paid BROWSER access is
		// unlimited and paid API access is not, so publishing the browser
		// number here would be the exact over-promise `access` exists to stop.
		want := fmt.Sprintf("%d per minute, %d per month",
			enforced.RequestsPerMinute, enforced.RequestsPerMonth)
		if tc.published != want {
			t.Errorf("%s published as %q, enforced as %q", tc.tier, tc.published, want)
		}
	}

	if limits.UpgradeURL != cfg.UpgradeURL {
		t.Errorf("upgradeUrl = %q, want %q", limits.UpgradeURL, cfg.UpgradeURL)
	}
	// Per TOOL CALL, which is what the middleware actually counts. Saying
	// "per request" would understate the cost of a batch by its size.
	if limits.Unit != "tool call" {
		t.Errorf("unit = %q", limits.Unit)
	}
}

// Tier is NOT a scope. Every scope here is read-only and grants a data domain;
// none names a plan. Expressing a plan as a scope would send a paying customer
// through a pointless re-authorisation to fix a quota problem.
func TestNoScopeEncodesASubscriptionTier(t *testing.T) {
	for _, scope := range Scopes {
		for _, tier := range []string{"free", "premium", "pro", "enterprise", "paid"} {
			if strings.Contains(scope, tier) {
				t.Errorf("scope %q names the %q tier — tier is not a scope", scope, tier)
			}
		}
		if !strings.HasSuffix(scope, ":read") {
			t.Errorf("scope %q is not read-only", scope)
		}
	}
}

// Publishing a ceiling nobody enforces is the same defect as enforcing one
// nobody published. The catalog therefore reads "do we actually apply this?"
// from the running config rather than from a sentence someone has to remember
// to update — and it says so either way.
func TestTheCatalogSaysWhetherTheQuotasAreActuallyEnforced(t *testing.T) {
	off := BuildCatalogFor(context.Background(), nil, CatalogOptions{
		APIBaseURL: testCatalogOrigin, RateLimitEnabled: false,
	}).Authentication
	on := BuildCatalogFor(context.Background(), nil, CatalogOptions{
		APIBaseURL: testCatalogOrigin, RateLimitEnabled: true,
	}).Authentication

	if off.RateLimits.Enforced {
		t.Error("a deployment with the limiter off claims to enforce quotas")
	}
	if !on.RateLimits.Enforced {
		t.Error("a deployment with the limiter on disclaims quotas it applies")
	}

	// The NUMBERS are published either way — they are the documented
	// entitlement, and a client planning around them is right about what it
	// will get once limiting is on.
	if off.RateLimits.Anonymous != on.RateLimits.Anonymous {
		t.Error("the published entitlement changed with the switch")
	}

	// But the prose must not claim enforcement that is not happening, and must
	// point at the limit that IS in force.
	if strings.Contains(off.Note, "raises the per-caller quota") {
		t.Errorf("the disclaiming note still promises a quota: %q", off.Note)
	}
	if !strings.Contains(off.RateLimits.Description, "NOT currently enforced") {
		t.Errorf("the disclaimer does not disclaim: %q", off.RateLimits.Description)
	}
	if !strings.Contains(off.RateLimits.Description, "Cloudflare") {
		t.Errorf("the disclaimer does not name the limit actually in force: %q", off.RateLimits.Description)
	}
	if strings.Contains(on.RateLimits.Description, "NOT currently enforced") {
		t.Errorf("an enforcing deployment disclaims: %q", on.RateLimits.Description)
	}
}
