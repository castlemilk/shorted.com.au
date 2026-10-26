// Package workloadauth verifies workload-identity JWTs issued by BrandBrain
// (design: docs/superpowers/specs/2026-10-27-fleet-managed-housing-crawl-design.md,
// "Workload identity"). It is a library: nothing here mounts an endpoint.
//
// Accepted tokens are ES256 only, signed by a key from the issuer's JWKS, with
// exact iss, exact aud, a bounded lifetime, an allowlisted sub, the configured
// org and a jti. Failures are classified for the caller with errors.Is:
//
//   - ErrUnauthenticated: the token is bad (wrong alg, unknown or denied kid,
//     failed claim, not on the allowlist). Map to 401.
//   - ErrUnavailable: the issuer cannot be reached and the cached keys cannot
//     answer (too stale, or the kid is unknown during the outage). Map to 503.
//     Never a reason to accept a token.
//
// # Audience form
//
// aud must name exactly one audience, either as a JSON string or as a
// one-element JSON array, and that audience must equal Config.Audience. An
// array with several entries is rejected even when one of them is the expected
// audience: a token minted for several services would otherwise be replayable
// against each of them.
package workloadauth
