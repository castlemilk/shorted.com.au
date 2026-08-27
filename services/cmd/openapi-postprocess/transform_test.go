package main

import "testing"

func specFixture() map[string]any {
	return map[string]any{
		"openapi": "3.1.0",
		// The raw generator output carries the info block from the
		// gnostic.openapi.v3.document option in shorts.proto — NOT from
		// base.yaml, which the plugin applies first and gnostic then
		// overrides. That block asserts a proprietary licence.
		"info": map[string]any{
			"title":   "Shorted API",
			"version": "v1",
			"license": map[string]any{"name": "Proprietary license"},
		},
		"paths": map[string]any{
			"/shorts.v1alpha1.StockService/GetStock": map[string]any{
				"post": map[string]any{"summary": "Get Stock"},
			},
			"/shorts.v1alpha1.BillingService/MintToken": map[string]any{
				"post": map[string]any{"summary": "Mint Token"},
			},
		},
	}
}

func baseFixture() map[string]any {
	return map[string]any{
		"info": map[string]any{
			"title":   "Shorted Public API",
			"version": "1.0.0",
			"license": map[string]any{
				"name": "CC BY 4.0",
				"url":  "https://creativecommons.org/licenses/by/4.0/",
			},
		},
	}
}

func TestTransformStampsInfoFromBase(t *testing.T) {
	spec := specFixture()
	public := map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}

	if err := Transform(spec, public, baseFixture()); err != nil {
		t.Fatalf("Transform: %v", err)
	}

	info := spec["info"].(map[string]any)
	if info["title"] != "Shorted Public API" {
		t.Errorf("title = %v, want Shorted Public API", info["title"])
	}
	if info["version"] != "1.0.0" {
		t.Errorf("version = %v, want 1.0.0", info["version"])
	}

	// A public API document asserting the wrong licence is a correctness
	// problem, not a cosmetic one: the gnostic option in shorts.proto claims
	// the API is proprietary, and it wins over base.yaml inside the plugin.
	license := info["license"].(map[string]any)
	if license["name"] != "CC BY 4.0" {
		t.Errorf("license = %v, want CC BY 4.0", license["name"])
	}
}

func TestTransformDropsNonPublicPaths(t *testing.T) {
	spec := specFixture()
	public := map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}

	if err := Transform(spec, public, baseFixture()); err != nil {
		t.Fatalf("Transform: %v", err)
	}

	paths := spec["paths"].(map[string]any)
	if _, ok := paths["/shorts.v1alpha1.StockService/GetStock"]; !ok {
		t.Error("public path was dropped")
	}
	if _, ok := paths["/shorts.v1alpha1.BillingService/MintToken"]; ok {
		t.Error("non-public path survived — it would advertise a credential-issuing endpoint")
	}
}

func TestTransformAddsServersAndSecurity(t *testing.T) {
	spec := specFixture()
	if err := Transform(spec, map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}, baseFixture()); err != nil {
		t.Fatalf("Transform: %v", err)
	}

	servers, ok := spec["servers"].([]any)
	if !ok || len(servers) != 1 {
		t.Fatalf("expected exactly one server, got %#v", spec["servers"])
	}
	if got := servers[0].(map[string]any)["url"]; got != "https://api.shorted.com.au" {
		t.Errorf("server url = %v, want https://api.shorted.com.au", got)
	}

	comps := spec["components"].(map[string]any)
	schemes := comps["securitySchemes"].(map[string]any)
	if _, ok := schemes["bearerAuth"]; !ok {
		t.Error("bearerAuth security scheme missing")
	}
}

// Auth being OPTIONAL is the load-bearing property of the security block: an
// agent that reads the spec as "a token is required" will never try the public
// endpoints at all. That is only expressed by the empty requirement object
// sitting alongside bearerAuth, so assert it explicitly rather than trusting
// the comment on the implementation.
func TestTransformAdvertisesAuthAsOptional(t *testing.T) {
	spec := specFixture()
	if err := Transform(spec, map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}, baseFixture()); err != nil {
		t.Fatalf("Transform: %v", err)
	}

	security, ok := spec["security"].([]any)
	if !ok {
		t.Fatalf("expected a top-level security list, got %#v", spec["security"])
	}

	var anonymous bool
	for _, req := range security {
		if m, ok := req.(map[string]any); ok && len(m) == 0 {
			anonymous = true
		}
	}
	if !anonymous {
		t.Errorf("no empty security requirement in %#v — the spec would read as auth-required", security)
	}
}

func TestTransformErrorsWhenNoPathsSurvive(t *testing.T) {
	spec := specFixture()
	err := Transform(spec, map[string]bool{}, baseFixture())
	if err == nil {
		t.Fatal("expected an error when every path is pruned — silently shipping an empty spec is worse than failing the build")
	}
}
