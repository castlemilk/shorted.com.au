package oauth

// resources.go is the set of RFC 8707 resources this authorization server will
// grant, each with its own scope vocabulary and its own rule for WHO may be
// granted it.
//
// It used to be one resource (/mcp) and one vocabulary (mcp.Scopes), inlined in
// three handlers. A second resource — the admin MCP server at /mcp/admin —
// changes three things, and each is handled here rather than in the handlers:
//
//  1. DEFAULTING. An authorize request with no `resource` used to default to
//     the only grantable resource, which was provably not a widening. With two,
//     "the only one" no longer exists. The default is now the PUBLIC resource,
//     explicitly: the least-privileged one, and what every existing client
//     that omits the parameter has always received. Nothing ever defaults to
//     the admin resource.
//  2. SCOPE. Each resource grants only its own vocabulary. news:publish is not
//     grantable against /mcp, and shorts:read is not grantable against
//     /mcp/admin; an empty scope request gets the resource's own vocabulary.
//  3. ENTITLEMENT. The public resource is grantable to any signed-in user. The
//     admin resource is grantable only to a user the injected Entitlement
//     approves — checked when the consent ticket is minted, when the code is
//     granted, when the code is exchanged, and on EVERY refresh, so a revoked
//     admin cannot keep rotating a 30-day refresh family.

import (
	"context"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
)

// Entitlement reports whether a user may be granted a resource right now.
// A nil Entitlement on a resource means "any authenticated user".
type Entitlement func(ctx context.Context, userID string) (bool, error)

type grantableResource struct {
	uri      string
	scopes   []string // published order
	vocab    map[string]bool
	entitled Entitlement
}

func newGrantableResource(uri string, scopes []string, entitled Entitlement) grantableResource {
	vocab := make(map[string]bool, len(scopes))
	for _, s := range scopes {
		vocab[s] = true
	}
	return grantableResource{uri: uri, scopes: append([]string(nil), scopes...), vocab: vocab, entitled: entitled}
}

// grantableResources builds the resource list for an issuer. The PUBLIC
// resource is always first, because resolveResource defaults to the first.
//
// The admin resource exists only when an admin Entitlement is configured: with
// none, there is no way to decide who may hold it, so it is simply not
// grantable (fail closed), and the AS behaves exactly as it did before.
func grantableResources(issuer string, admin Entitlement) []grantableResource {
	resources := []grantableResource{newGrantableResource(mcp.ResourceURI(issuer), mcp.Scopes, nil)}
	if admin != nil {
		resources = append(resources, newGrantableResource(mcp.AdminResourceURI(issuer), mcp.AdminScopes, admin))
	}
	return resources
}

// resolveResource maps a requested resource to a grantable one. An empty
// request resolves to the public resource (see the file header).
func resolveResource(resources []grantableResource, requested string) (*grantableResource, bool) {
	if len(resources) == 0 {
		return nil, false
	}
	if strings.TrimSpace(requested) == "" {
		return &resources[0], true
	}
	for i := range resources {
		if resources[i].uri == requested {
			return &resources[i], true
		}
	}
	return nil, false
}

// entitledTo reports whether userID may hold this resource. A failed lookup is
// returned as an error so callers can fail closed with a retryable status.
func (r *grantableResource) entitledTo(ctx context.Context, userID string) (bool, error) {
	if r.entitled == nil {
		return true, nil
	}
	if strings.TrimSpace(userID) == "" {
		return false, nil
	}
	return r.entitled(ctx, userID)
}

// allScopes is the union of every vocabulary this AS publishes, in order: the
// public scopes first, then the admin ones. Used where a single list is
// required (registration filtering, AS metadata, consent copy).
func allScopes() []string {
	out := append([]string(nil), mcp.Scopes...)
	return append(out, mcp.AdminScopes...)
}
