package main

import (
	"testing"
	"time"
)

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

// The doc comment promises these fail loud rather than emitting a half-formed
// document; nothing pinned that until now.
func TestTransformErrorsWhenSpecHasNoPaths(t *testing.T) {
	if err := Transform(map[string]any{}, map[string]bool{"/a": true}, baseFixture()); err == nil {
		t.Fatal("expected an error when the spec has no paths object")
	}
}

func TestTransformErrorsWhenBaseHasNoInfo(t *testing.T) {
	if err := Transform(specFixture(), map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}, map[string]any{}); err == nil {
		t.Fatal("expected an error when base.yaml has no info block")
	}
}

// A spec that still describes the request/response shape of a pruned,
// credential-issuing method is an information leak, and every orphan inflates
// the artifact an agent has to read. The cycle here is the point: protobuf
// derived schemas reference each other in loops, so a naive walk never
// terminates.
func TestTransformPrunesOrphanedSchemas(t *testing.T) {
	spec := specFixture()
	paths := spec["paths"].(map[string]any)
	paths["/shorts.v1alpha1.StockService/GetStock"] = map[string]any{
		"post": map[string]any{
			"requestBody": map[string]any{
				"content": map[string]any{
					"application/json": map[string]any{
						"schema": map[string]any{"$ref": "#/components/schemas/A"},
					},
				},
			},
		},
	}
	spec["components"] = map[string]any{
		"schemas": map[string]any{
			// A -> B -> A: a cycle. Both must survive, and the walk must stop.
			"A": map[string]any{
				"properties": map[string]any{
					"b": map[string]any{"$ref": "#/components/schemas/B"},
				},
			},
			"B": map[string]any{
				"items": []any{
					map[string]any{"$ref": "#/components/schemas/A"},
				},
			},
			// Unreferenced by any surviving path.
			"C": map[string]any{"type": "object"},
		},
	}

	done := make(chan error, 1)
	go func() {
		done <- Transform(spec, map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}, baseFixture())
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Transform: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Transform did not terminate — the $ref walk is not cycle-safe")
	}

	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for _, want := range []string{"A", "B"} {
		if _, ok := schemas[want]; !ok {
			t.Errorf("reachable schema %s was pruned — the published document would be broken", want)
		}
	}
	if _, ok := schemas["C"]; ok {
		t.Error("orphaned schema C survived")
	}
}

func TestSchemaPruningLeavesOtherComponentsAlone(t *testing.T) {
	spec := specFixture()
	spec["components"] = map[string]any{
		"schemas":    map[string]any{"C": map[string]any{"type": "object"}},
		"parameters": map[string]any{"Foo": map[string]any{"name": "foo"}},
	}

	if err := Transform(spec, map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}, baseFixture()); err != nil {
		t.Fatalf("Transform: %v", err)
	}

	comps := spec["components"].(map[string]any)
	if _, ok := comps["securitySchemes"].(map[string]any)["bearerAuth"]; !ok {
		t.Error("securitySchemes was clobbered by schema pruning")
	}
	if _, ok := comps["parameters"]; !ok {
		t.Error("components.parameters was removed by schema pruning")
	}
}

// Hand-written paths are not proto methods, so they can never appear in the
// public-method set and would be pruned if they were merged before the sweep.
// They also do not live on the document's top-level server, so losing their
// path-level `servers` override would tell an agent to call a URL that 404s.
func TestTransformMergesBasePaths(t *testing.T) {
	spec := specFixture()
	base := baseFixture()
	base["paths"] = map[string]any{
		"/api/search/stocks": map[string]any{
			"servers": []any{map[string]any{"url": "https://shorted.com.au"}},
			"get":     map[string]any{"operationId": "searchStocks"},
		},
	}

	if err := Transform(spec, map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}, base); err != nil {
		t.Fatalf("Transform: %v", err)
	}

	paths := spec["paths"].(map[string]any)
	item, ok := paths["/api/search/stocks"].(map[string]any)
	if !ok {
		t.Fatalf("hand-written path was pruned or never merged: %#v", paths)
	}
	servers, ok := item["servers"].([]any)
	if !ok || len(servers) != 1 {
		t.Fatalf("path-level servers override lost: %#v", item["servers"])
	}
	if got := servers[0].(map[string]any)["url"]; got != "https://shorted.com.au" {
		t.Errorf("servers[0].url = %v, want https://shorted.com.au", got)
	}
}

// A base entry keyed to a generated path must enrich it, never replace it —
// clobbering would silently delete the operation the generator emitted.
func TestTransformBasePathsDoNotClobberGeneratedOnes(t *testing.T) {
	spec := specFixture()
	base := baseFixture()
	base["paths"] = map[string]any{
		"/shorts.v1alpha1.StockService/GetStock": map[string]any{
			"description": "hand-written prose",
			"post":        map[string]any{"summary": "CLOBBERED"},
		},
	}

	if err := Transform(spec, map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}, base); err != nil {
		t.Fatalf("Transform: %v", err)
	}

	item := spec["paths"].(map[string]any)["/shorts.v1alpha1.StockService/GetStock"].(map[string]any)
	if got := item["post"].(map[string]any)["summary"]; got != "Get Stock" {
		t.Errorf("generated operation was clobbered by the base entry: summary = %v", got)
	}
	if item["description"] != "hand-written prose" {
		t.Errorf("base-only key was not merged in: %#v", item["description"])
	}
}

func TestTransformSurvivesMissingComponents(t *testing.T) {
	spec := specFixture()
	delete(spec, "components")
	if err := Transform(spec, map[string]bool{"/shorts.v1alpha1.StockService/GetStock": true}, baseFixture()); err != nil {
		t.Fatalf("Transform with no components: %v", err)
	}
}
