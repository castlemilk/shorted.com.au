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

	// Split by response class because they are not interchangeable: the
	// success headers describe your standing, the 429 headers describe a
	// rejection. A limit of 0 means "unlimited for this tier" and its headers
	// are OMITTED rather than sent as 0 — "X-RateLimit-Limit: 0" reads as
	// "you may make zero requests", the opposite of the truth.
	//
	// These must stay in step with services/pkg/ratelimit (interceptor.go and
	// quota_error.go). The field names in X-RateLimit-Detail are a contract;
	// renaming one is a breaking change.
	spec["x-rate-limit-headers"] = map[string]any{
		"success": map[string]any{
			"X-RateLimit-Limit":             "Per-minute ceiling for your tier",
			"X-RateLimit-Remaining":         "Requests left in the current minute",
			"X-RateLimit-Reset":             "Unix seconds when the minute window resets",
			"X-RateLimit-Monthly-Limit":     "Monthly quota for your tier",
			"X-RateLimit-Monthly-Used":      "Requests consumed this month",
			"X-RateLimit-Monthly-Remaining": "Requests left this month",
			"X-RateLimit-Monthly-Reset":     "Unix seconds at the start of next month",
		},
		"rejection": map[string]any{
			"Retry-After":             "Seconds to wait before retrying",
			"X-RateLimit-Kind":        "Which limit fired: per_minute or monthly",
			"X-RateLimit-Tier":        "anonymous | free | premium | pro | enterprise",
			"X-RateLimit-Access":      "api or browser — paid browser access is unlimited, paid API access is not",
			"X-RateLimit-Upgrade-Url": "Absolute URL to raise the limit",
			"X-RateLimit-Detail":      "Compact JSON mirroring all of the above: kind, limit, used, remaining, reset_at, retry_after_seconds, tier, access, upgrade_url, message",
			"X-RateLimit-Scope":       "Edge rejections only: edge-10s or edge-60s",
			"X-RateLimit-Bucket":      "Edge rejections only: the traffic class that rejected",
		},
	}

	return nil
}
