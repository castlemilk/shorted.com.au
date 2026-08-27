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

	// The legacy monolithic service is excluded wholesale: it duplicates every
	// domain rpc, and generating it would double every path in the document.
	for p := range paths {
		if strings.Contains(p, "ShortedStocksService") {
			t.Errorf("legacy service must be excluded, got %s", p)
		}
	}

	// MintToken issues credentials — it must never be advertised as public.
	if paths["/shorts.v1alpha1.BillingService/MintToken"] {
		t.Error("MintToken must not be public")
	}
}
