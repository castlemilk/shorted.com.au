package economy

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// globalRegistryPath is the frontend registry these importers feed.
const globalRegistryPath = "../../../../../web/src/@/lib/economy/global-series.ts"

// The failure this guards is the one that already happened: nine FRED series
// and eight Pink Sheet series were ingested, written to the catalog and served
// by a VISIBILITY_PUBLIC RPC, while the site listed a subset of them in one
// correlation picker and showed none of them on /economy. Nothing was broken —
// there was simply no place where "what we import" and "what we show" were
// compared, so the gap was invisible.
//
// Both directions matter. A key in the registry that no importer produces is a
// chart that renders empty forever; a public series missing from the registry
// is data nobody can see.
func TestGlobalSeriesRegistryMatchesImporters(t *testing.T) {
	source, err := os.ReadFile(filepath.Clean(globalRegistryPath))
	if err != nil {
		t.Fatalf("read %s: %v — the frontend registry moved; update globalRegistryPath",
			globalRegistryPath, err)
	}
	registry := registryKeys(t, string(source))

	public, internal := importedGlobalKeys(t)

	for _, key := range public {
		if !registry[key] {
			t.Errorf("%q is imported and public but missing from global-series.ts — "+
				"it is served by the API and shown on no page", key)
		}
	}
	for _, key := range internal {
		if registry[key] {
			t.Errorf("%q is internal_only (migration 000121) but listed in global-series.ts — "+
				"the public RPCs filter it, so the chart and the overlay would both be empty", key)
		}
	}
	known := map[string]bool{}
	for _, key := range append(append([]string{}, public...), internal...) {
		known[key] = true
	}
	for key := range registry {
		if !known[key] {
			t.Errorf("global-series.ts lists %q, which no importer produces", key)
		}
	}
}

// registryKeys pulls the `key: "..."` values out of the registry. It reads only
// the GLOBAL_ECONOMY_SERIES array so unrelated string literals in the file's
// prose cannot be mistaken for entries.
func registryKeys(t *testing.T, source string) map[string]bool {
	t.Helper()
	const marker = "export const GLOBAL_ECONOMY_SERIES"
	start := strings.Index(source, marker)
	if start < 0 {
		t.Fatalf("global-series.ts has no %s — the registry was renamed", marker)
	}
	body := source[start:]
	if end := strings.Index(body, "\n];"); end >= 0 {
		body = body[:end]
	}

	keys := map[string]bool{}
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "key: \"") {
			continue
		}
		value := strings.TrimPrefix(trimmed, "key: \"")
		if idx := strings.Index(value, "\""); idx >= 0 {
			keys[value[:idx]] = true
		}
	}
	if len(keys) == 0 {
		t.Fatal("parsed zero keys from global-series.ts — the parse broke, and a " +
			"zero-key parse would pass every assertion below vacuously")
	}
	return keys
}

// importedGlobalKeys returns the catalog keys the two global importers produce,
// split by visibility. Keys are built through the real SeriesDef.Key() rather
// than reassembled here, so a change to the key format cannot make the two
// sides agree while both being wrong.
func importedGlobalKeys(t *testing.T) (public, internal []string) {
	t.Helper()
	for _, def := range fredSeriesDefs {
		obs, err := monthlyLast([]fredObservation{{"2026-03-30", "1.0"}}, def)
		if err != nil {
			t.Fatalf("%s: %v", def.ID, err)
		}
		if obs[0].Series.InternalOnly {
			internal = append(internal, obs[0].Series.Key())
		} else {
			public = append(public, obs[0].Series.Key())
		}
	}
	for _, def := range pinkSeriesDefs {
		key := SeriesDef{
			Topic: "commodities", Metric: def.Metric,
			Product: def.Product, RegionCode: "world",
		}.Key()
		public = append(public, key)
	}
	sort.Strings(public)
	sort.Strings(internal)
	return public, internal
}
