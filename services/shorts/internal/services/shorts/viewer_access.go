package shorts

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/subscription"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/viewerctx"
)

// Access is how much of a strategy picks list a viewer receives.
//
// The public strategy reads serve one answer to every HTTP caller, so their
// depth cannot depend on who asked. Signed-in depth is read only through the
// private rpc (privateAccess), or through a verified MCP viewer that the MCP
// server sets in process (publicDepth).
type Access int

const (
	// AccessAnonymous is a caller with no verified identity. It receives the
	// public depth, which the clamp limits when the flag is set.
	AccessAnonymous Access = iota
	// AccessFree is a signed-in caller without a Premium entitlement. It
	// receives the full list.
	AccessFree
	// AccessPremium is a signed-in caller with a Premium entitlement.
	AccessPremium
)

// String is the wire value of the access, as ViewerDepth.access names it.
func (a Access) String() string {
	switch a {
	case AccessFree:
		return "free"
	case AccessPremium:
		return "premium"
	default:
		return "anonymous"
	}
}

// privateAccess resolves the caller of a VISIBILITY_PRIVATE handler from the
// claims the interceptor verified. A request with no claims is refused as
// Unauthenticated: the interceptor already refuses a private method without
// a credential, and this keeps a mis-annotated method failing closed.
//
// Premium is read from the claims' tier, which the interceptor re-resolves
// from the subscription store on every request, and only when that lookup
// succeeded (TierResolved). Mutations re-check the entitlement themselves.
//
// The verified uid comes back with the access, so a handler resolves every
// id it reads under the same identity it checked.
func privateAccess(ctx context.Context) (Access, string, error) {
	claims, ok := UserFromContext(ctx)
	if !ok || claims == nil || strings.TrimSpace(claims.UserID) == "" {
		return AccessAnonymous, "", connect.NewError(connect.CodeUnauthenticated, errors.New("sign in to read this"))
	}
	uid := strings.TrimSpace(claims.UserID)
	if claims.TierResolved && subscription.PremiumFeatureTier(claims.Tier) {
		return AccessPremium, uid, nil
	}
	return AccessFree, uid, nil
}

// publicDepth is the depth a public strategy read gives its caller.
//
// It ignores the Connect claims on purpose. The interceptor attaches a
// verified bearer identity to public methods too, so reading claims here
// would make the public answer depend on the caller. It returns AccessFree
// only for a verified MCP viewer, which the MCP server sets in process, so no
// HTTP request can reach that branch.
func publicDepth(ctx context.Context) Access {
	if _, ok := viewerctx.MCPUser(ctx); ok {
		return AccessFree
	}
	return AccessAnonymous
}
