package main

// private.go builds the PRIVATE API reference: the domain methods that are not
// VISIBILITY_PUBLIC (a signed-in caller's and an administrator's), for the
// admin console's private docs (/admin/api-docs). It is never published: the
// output goes to web/src/server/private-docs/, which no route serves without the
// admin login, and never to web/public.

import (
	"fmt"
	"sort"

	"github.com/castlemilk/shorted.com.au/services/pkg/protovisibility"
)

// privateDocExcluded are the internal-only webhook handlers: the Stripe webhook
// route calls them with the INTERNAL_SERVICE_SECRET, and nothing else can
// (internalOnlyMethods, services/shorts/internal/services/shorts/
// middleware_connect.go). A reference that listed them would invite a call that
// is always refused. TestPrivateDocExcludesTheInternalOnlyMethods holds this
// list to that one.
var privateDocExcluded = map[string]bool{
	"/shorts.v1alpha1.BillingService/HandleStripeCheckoutCompleted":   true,
	"/shorts.v1alpha1.BillingService/HandleStripeSubscriptionUpdated": true,
}

// Access labels written on each private operation as x-shorted-access.
const (
	accessSignedIn = "signed-in"
	accessAdmin    = "admin"
)

// PrivateMethodAccess is the private reference's method set and each method's
// access label.
func PrivateMethodAccess() map[string]string {
	out := map[string]string{}
	for path, role := range protovisibility.PrivateMethodAccess() {
		if privateDocExcluded[path] {
			continue
		}
		switch role {
		case "":
			out[path] = accessSignedIn
		default:
			out[path] = role
		}
	}
	return out
}

// TransformPrivate prunes the generated document to the private methods, stamps
// the private reference's info block, marks each operation with the access it
// needs and states that a credential is required.
func TransformPrivate(spec map[string]any, access map[string]string, base map[string]any) error {
	info, ok := base["info"].(map[string]any)
	if !ok {
		return fmt.Errorf("api/schema/base.yaml has no info block")
	}
	privateInfo := map[string]any{
		"title":   "Shorted private API",
		"version": info["version"],
		"description": "The Connect-RPC methods of api.shorted.com.au that need a credential: a signed-in " +
			"user's (any account) or an administrator's. Not published; generated for the admin console. " +
			"The public methods are documented at https://shorted.com.au/docs/api.",
	}
	keep := map[string]bool{}
	for path := range access {
		keep[path] = true
	}
	// Only the info block: the base document's hand-written paths are public web
	// surfaces and belong to the public reference.
	if err := Transform(spec, keep, map[string]any{"info": privateInfo}); err != nil {
		return err
	}

	paths, _ := spec["paths"].(map[string]any)
	names := make([]string, 0, len(paths))
	for p := range paths {
		names = append(names, p)
	}
	sort.Strings(names)
	for _, p := range names {
		item, _ := paths[p].(map[string]any)
		for _, verb := range []string{"get", "post", "put", "patch", "delete"} {
			if op, ok := item[verb].(map[string]any); ok {
				op["x-shorted-access"] = access[p]
			}
		}
	}

	comps, _ := spec["components"].(map[string]any)
	comps["securitySchemes"] = map[string]any{
		"bearerAuth": map[string]any{
			"type":   "http",
			"scheme": "bearer",
			"description": "Required. A signed-in method takes a Shorted API token (minted at https://shorted.com.au/account) " +
				"or a Firebase ID token; an admin method takes an administrator's Firebase ID token (a verified address on the " +
				"admin allowlist), or the web tier's internal secret asserting the admin role. A missing or wrong credential " +
				"is unauthenticated; the right credential without the role is permission_denied.",
			"bearerFormat": "JWT",
		},
	}
	spec["security"] = []any{map[string]any{"bearerAuth": []any{}}}
	return nil
}
