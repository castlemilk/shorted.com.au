package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func fetchCatalog(t *testing.T, src DataSource) (*httptest.ResponseRecorder, Catalog) {
	t.Helper()

	rec := httptest.NewRecorder()
	CatalogHandler(src).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/mcp/catalog.json", nil))

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
	handler := CatalogHandler(&fakeDataSource{})

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
	CatalogHandler(&fakeDataSource{}).ServeHTTP(rec,
		httptest.NewRequest(http.MethodPost, "/mcp/catalog.json", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d, want 405", rec.Code)
	}
}
