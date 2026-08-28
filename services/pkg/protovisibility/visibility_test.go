package protovisibility

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
		if strings.HasPrefix(p, "/"+LegacyService+"/") {
			t.Errorf("legacy service must be excluded, got %s", p)
		}

		// Pin the key FORMAT for every path, not just the one literal below.
		// The post-processor prunes the generated document by exact key match,
		// so a drift in this shape would silently delete every good path
		// instead of failing loudly.
		if !strings.HasPrefix(p, "/"+PublicPackage+".") {
			t.Errorf("path %q does not start with /%s.", p, PublicPackage)
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

func TestPublicMethodNames(t *testing.T) {
	names := PublicMethodNames()

	if len(names) == 0 {
		t.Fatal("no public methods found — are the generated proto packages imported?")
	}

	if !names["shorts.v1alpha1.StockService.GetStock"] {
		t.Error("expected shorts.v1alpha1.StockService.GetStock to be public")
	}

	// MintToken issues API credentials. The MCP tool guard keys off this exact
	// spelling, so an assertion on it here is not redundant with the paths test.
	if names["shorts.v1alpha1.BillingService.MintToken"] {
		t.Error("MintToken must not be public")
	}

	for n := range names {
		if strings.HasPrefix(n, LegacyService+".") {
			t.Errorf("legacy service must be excluded, got %s", n)
		}
		if strings.Contains(n, "/") {
			t.Errorf("method name %q must be dotted, not a path", n)
		}
	}
}

// The two views must describe the SAME set. They are spelled differently and
// consumed by different subsystems (OpenAPI pruning vs the MCP tool guard); if
// one ever went out of sync with the other, a method could be public on one
// surface and private on the other — exactly the split this package exists to
// prevent.
func TestNamesAndPathsAgree(t *testing.T) {
	names := PublicMethodNames()
	paths := PublicMethodPaths()

	if len(names) != len(paths) {
		t.Fatalf("names (%d) and paths (%d) disagree on how many methods are public", len(names), len(paths))
	}

	for p := range paths {
		trimmed := strings.TrimPrefix(p, "/")
		svc, method, ok := strings.Cut(trimmed, "/")
		if !ok {
			t.Fatalf("malformed path %q", p)
		}
		if !names[svc+"."+method] {
			t.Errorf("path %q has no corresponding entry in PublicMethodNames", p)
		}
	}
}
