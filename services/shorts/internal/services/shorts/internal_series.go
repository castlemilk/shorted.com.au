package shorts

import "context"

// Who may see an internal-only economic series (migration 000121).
//
// Some sources may be analysed but not redistributed. FRED's own metadata for
// VIXCLS reads "Copyright, 2016, Chicago Board Options Exchange, Inc. Reprinted
// with permission" — permission granted to FRED, not onward — while the three
// Federal Reserve series beside it carry no such notice. Those series are
// ingested and correlated like any other and withheld from every anonymous
// caller; this decides who the exceptions are.
//
// TWO PATHS, because this service has two kinds of caller and they carry
// different identity:
//
//  1. Browser/session auth resolves an EMAIL, and middleware_connect.go already
//     promotes the operator emails (ben.ebsworth@gmail.com among them) to the
//     `admin` role. This is the path the site itself uses, so it is the one that
//     makes the series visible on a page.
//
//  2. An OAuth access token carries NEITHER roles NOR email — MintAccessToken is
//     explicit that a role is an operator grant rather than something a consent
//     screen can confer. For API callers the only always-present identifier is
//     the user id, which is what INTERNAL_TIER_USER_IDS is keyed on
//     (internal_tier.go).
//
// Gating on the internal ALLOWLIST rather than on the tier it grants is
// deliberate. The grant resolves to `enterprise` by default, so a check for
// "tier == enterprise" would hand this data to every paying enterprise
// customer — a licence breach dressed as a feature flag.
func callerMaySeeInternalSeries(ctx context.Context) bool {
	claims, ok := UserFromContext(ctx)
	if !ok || claims == nil {
		return false // anonymous — the common case, and the one that matters
	}
	if hasRoleInList(claims.Roles, "admin") {
		return true
	}
	_, internal := InternalTierFor(claims.UserID)
	return internal
}
