package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The excluded webhook handlers are exactly the BillingService methods the
// middleware lets through only with the internal secret.
func TestPrivateDocExcludesTheInternalOnlyMethods(t *testing.T) {
	src, err := os.ReadFile("../../shorts/internal/services/shorts/middleware_connect.go")
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)for _, svc := range \[\]string\{"ShortedStocksService", "BillingService"\} \{\s*for _, method := range \[\]string\{([^}]*)\}`).FindSubmatch(src)
	if block == nil {
		t.Fatal("could not find the BillingService internal-only methods in middleware_connect.go")
	}
	names := regexp.MustCompile(`"([A-Za-z]+)"`).FindAllSubmatch(block[1], -1)
	want := map[string]bool{}
	for _, n := range names {
		want["/shorts.v1alpha1.BillingService/"+string(n[1])] = true
	}
	if len(want) != len(privateDocExcluded) {
		t.Fatalf("internal-only = %v, excluded = %v", want, privateDocExcluded)
	}
	for p := range want {
		if !privateDocExcluded[p] {
			t.Errorf("%s is internal-only but documented", p)
		}
	}
	access := PrivateMethodAccess()
	for p := range privateDocExcluded {
		if _, ok := access[p]; ok {
			t.Errorf("%s is in the private reference", p)
		}
	}
}

func TestTransformPrivateKeepsOnlyPrivateMethodsAndLabelsThem(t *testing.T) {
	spec := map[string]any{
		"paths": map[string]any{
			"/shorts.v1alpha1.MarketService/GetTopShorts":   map[string]any{"post": map[string]any{}},
			"/shorts.v1alpha1.MarketService/GetSyncStatus":  map[string]any{"post": map[string]any{}},
			"/shorts.v1alpha1.StrategyService/SaveStrategy": map[string]any{"post": map[string]any{}},
		},
		"components": map[string]any{"schemas": map[string]any{}},
	}
	base := map[string]any{
		"info":  map[string]any{"title": "Shorted API", "version": "1.2.3"},
		"paths": map[string]any{"/feed.xml": map[string]any{"get": map[string]any{}}},
	}
	access := map[string]string{
		"/shorts.v1alpha1.MarketService/GetSyncStatus":  accessAdmin,
		"/shorts.v1alpha1.StrategyService/SaveStrategy": accessSignedIn,
	}
	if err := TransformPrivate(spec, access, base); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	if len(paths) != 2 {
		t.Fatalf("paths = %v; want the two private methods only (no public method, no base path)", paths)
	}
	op := paths["/shorts.v1alpha1.MarketService/GetSyncStatus"].(map[string]any)["post"].(map[string]any)
	if op["x-shorted-access"] != accessAdmin {
		t.Errorf("GetSyncStatus access = %v", op["x-shorted-access"])
	}
	info := spec["info"].(map[string]any)
	if info["title"] != "Shorted private API" || info["version"] != "1.2.3" {
		t.Errorf("info = %v", info)
	}
	desc := spec["components"].(map[string]any)["securitySchemes"].(map[string]any)["bearerAuth"].(map[string]any)["description"].(string)
	if !strings.HasPrefix(desc, "Required.") {
		t.Errorf("the private reference must say a credential is required: %q", desc)
	}
}

func TestThePrivateReferenceCoversTheRegistry(t *testing.T) {
	access := PrivateMethodAccess()
	if access["/shorts.v1alpha1.MarketService/GetSyncStatus"] != accessAdmin {
		t.Error("GetSyncStatus is an admin method")
	}
	if access["/shorts.v1alpha1.BillingService/MintToken"] != accessSignedIn {
		t.Error("MintToken is a signed-in method")
	}
	for p := range access {
		if PublicMethodPaths()[p] {
			t.Errorf("%s is public", p)
		}
	}
}

// Every private method reaches the private reference: a service missing from
// buf.gen.yaml's connect-openapi list would drop out of it without a word.
func TestThePrivateReferenceIsGeneratedForEveryPrivateMethod(t *testing.T) {
	raw, err := os.ReadFile("../../../api/schema/generated/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for path := range PrivateMethodAccess() {
		if !strings.Contains(string(raw), "\n  "+path+":\n") {
			t.Errorf("%s is not in api/schema/generated/openapi.yaml; add its service to proto/buf.gen.yaml's connect-openapi services", path)
		}
	}
}
