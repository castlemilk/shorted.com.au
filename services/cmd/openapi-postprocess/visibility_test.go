package main

import (
	"strings"
	"testing"
)

func TestPublicMethodPaths(t *testing.T) {
	paths := PublicMethodPaths()

	if len(paths) == 0 {
		t.Fatal("no public methods found — are the generated proto packages imported?")
	}

	// GetStock is annotated VISIBILITY_PUBLIC on the domain service.
	if !paths["/shorts.v1alpha1.StockService/GetStock"] {
		t.Error("expected /shorts.v1alpha1.StockService/GetStock to be public")
	}

	for p := range paths {
		// The legacy monolithic service is excluded wholesale: it duplicates
		// every domain rpc, and generating it would double every path in the
		// document. Keyed off the same const the implementation uses, so a
		// typo there cannot leave this assertion passing against a substring
		// that no longer matches.
		if strings.HasPrefix(p, "/"+legacyService+"/") {
			t.Errorf("legacy service must be excluded, got %s", p)
		}

		// Pin the key FORMAT for every path, not just the one literal below.
		// Task 3 prunes the generated document by exact key match, so a drift
		// in this shape would silently delete every good path instead of
		// failing loudly.
		if !strings.HasPrefix(p, "/"+publicPackage+".") {
			t.Errorf("path %q does not start with /%s.", p, publicPackage)
		}
		if strings.Count(p, "/") != 2 {
			t.Errorf("path %q should have exactly two slashes: /<service>/<method>", p)
		}
	}

	// MintToken issues credentials — it must never be advertised as public.
	if paths["/shorts.v1alpha1.BillingService/MintToken"] {
		t.Error("MintToken must not be public")
	}
}
