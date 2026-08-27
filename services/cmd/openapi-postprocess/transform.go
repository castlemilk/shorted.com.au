package main

import (
	"fmt"
	"strings"
)

const schemaRefPrefix = "#/components/schemas/"

// collectRefs walks an arbitrary decoded-JSON value and appends every "$ref"
// string it finds, at any depth, inside objects or arrays. It deliberately
// models nothing about OpenAPI's structure: a $ref is legal in more places
// than any hand-written traversal would remember, and the cost of missing one
// is deleting a schema a live endpoint depends on.
func collectRefs(node any, out *[]string) {
	switch v := node.(type) {
	case map[string]any:
		for k, child := range v {
			if k == "$ref" {
				if ref, ok := child.(string); ok {
					*out = append(*out, ref)
				}
				continue
			}
			collectRefs(child, out)
		}
	case []any:
		for _, child := range v {
			collectRefs(child, out)
		}
	}
}

// pruneOrphanedSchemas deletes every entry in components.schemas that is not
// transitively reachable from a surviving path item.
//
// Pruning `paths` alone is not enough: the generator emits a schema for every
// message in the descriptor, so the published document still described the
// request and response shapes of non-public methods — including the
// credential-issuing MintToken pair. No endpoint advertised them, so this was
// never an access problem, but publishing the message shape of a private API
// is an information leak, and the orphans inflate a document whose primary
// reader is an LLM agent paying for every token.
//
// The walk is a mark-and-sweep to a fixed point over a worklist, with a
// visited set — protobuf-derived schemas reference each other in cycles, so
// recursion without a visited set does not terminate.
func pruneOrphanedSchemas(spec map[string]any, paths map[string]any) {
	comps, ok := spec["components"].(map[string]any)
	if !ok {
		return
	}
	schemas, ok := comps["schemas"].(map[string]any)
	if !ok {
		return
	}

	var queue []string
	{
		var refs []string
		collectRefs(paths, &refs)
		queue = refs
	}

	reachable := map[string]bool{}
	for len(queue) > 0 {
		ref := queue[len(queue)-1]
		queue = queue[:len(queue)-1]

		name, ok := strings.CutPrefix(ref, schemaRefPrefix)
		if !ok || reachable[name] {
			// Not a schema ref (or already marked). Refs into other
			// components.* sub-objects are none of this function's business.
			continue
		}
		reachable[name] = true

		schema, ok := schemas[name]
		if !ok {
			// A dangling ref is the generator's problem, not ours; marking it
			// reachable simply means we never delete anything on its account.
			continue
		}
		var refs []string
		collectRefs(schema, &refs)
		queue = append(queue, refs...)
	}

	for name := range schemas {
		if !reachable[name] {
			delete(schemas, name)
		}
	}
}

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
		return fmt.Errorf("generated spec (api/schema/generated/openapi.yaml) has no paths object, or its paths value is not a mapping — regenerate it with `cd proto && buf generate`")
	}

	if info, ok := base["info"].(map[string]any); ok {
		spec["info"] = info
	} else {
		return fmt.Errorf("api/schema/base.yaml has no info block — that file is the source of truth for the published title, description and licence, so there is nothing correct to stamp")
	}

	for p := range paths {
		if !public[p] {
			delete(paths, p)
		}
	}
	if len(paths) == 0 {
		return fmt.Errorf("every path was pruned: no VISIBILITY_PUBLIC methods matched the generated document")
	}

	pruneOrphanedSchemas(spec, paths)

	spec["servers"] = []any{
		map[string]any{
			"url":         "https://api.shorted.com.au",
			"description": "Production",
		},
	}

	// An absent or malformed `components` is ours to create — nothing we need
	// survives in it, so replacing a non-map value here is deliberate.
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
