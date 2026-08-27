package main

import "fmt"

// Transform prunes every path not in public and decorates the document with
// the facts the generator cannot know: where the API actually lives, how to
// authenticate, and the rate-limit response headers.
//
// base is the parsed api/schema/base.yaml. Its `info` block is stamped over
// whatever the generator produced, because the plugin applies base= FIRST and
// then lets the file-level gnostic.openapi.v3.document option in shorts.proto
// override it — so the raw output claims `title: Shorted API`, `version: v1`
// and, worst of all, `license: Proprietary license`. Publishing a spec that
// asserts the wrong licence is a correctness problem. Fixing it in the proto
// would rewrite the descriptor bytes and churn every generated Go and TS
// file, so it is corrected here instead.
//
// It mutates spec in place. An empty result is an error: shipping a spec with
// no paths reads to an agent as "this API has no endpoints", which is worse
// than a failed build.
func Transform(spec map[string]any, public map[string]bool, base map[string]any) error {
	paths, ok := spec["paths"].(map[string]any)
	if !ok {
		return fmt.Errorf("spec has no paths object")
	}

	if info, ok := base["info"].(map[string]any); ok {
		spec["info"] = info
	} else {
		return fmt.Errorf("base document has no info block")
	}

	for p := range paths {
		if !public[p] {
			delete(paths, p)
		}
	}
	if len(paths) == 0 {
		return fmt.Errorf("every path was pruned: no VISIBILITY_PUBLIC methods matched the generated document")
	}

	spec["servers"] = []any{
		map[string]any{
			"url":         "https://api.shorted.com.au",
			"description": "Production",
		},
	}

	comps, _ := spec["components"].(map[string]any)
	if comps == nil {
		comps = map[string]any{}
		spec["components"] = comps
	}
	comps["securitySchemes"] = map[string]any{
		"bearerAuth": map[string]any{
			"type":         "http",
			"scheme":       "bearer",
			"description":  "Optional. A Shorted API token raises your rate limits; public endpoints work unauthenticated at the anonymous tier. Manage tokens at https://shorted.com.au/account.",
			"bearerFormat": "JWT",
		},
	}
	// Optional, not required: listing it under a top-level `security` block
	// would tell agents auth is mandatory, which is false and would stop them
	// trying the public endpoints at all.
	spec["security"] = []any{
		map[string]any{"bearerAuth": []any{}},
		map[string]any{},
	}

	spec["x-rate-limit-headers"] = map[string]any{
		"X-RateLimit-Limit":             "Per-minute ceiling for your tier",
		"X-RateLimit-Remaining":         "Requests left in the current minute",
		"X-RateLimit-Reset":             "Unix seconds when the minute window resets",
		"X-RateLimit-Monthly-Limit":     "Monthly quota for your tier",
		"X-RateLimit-Monthly-Remaining": "Requests left this month",
		"X-RateLimit-Detail":            "On a 429, compact JSON describing which limit fired, the ceiling, when it clears, and the upgrade URL",
	}

	return nil
}
