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
//   - ErrUnavailable: no usable keys (the issuer is unreachable and the cache
//     is older than StaleKeysFor, or has never loaded, or an unknown kid cannot
//     be resolved during an outage). Map to 503. Never a reason to accept a token.
//
// # Startup and readiness
//
// NewVerifier validates the config and starts the first fetch in the
// background, so startup never depends on the issuer. Ready(ctx) reports
// whether keys are loaded, and Status() reports the last success, the last
// error (a fixed reason string, never token data) and the key count. A
// discovery mismatch (wrong issuer, jwks_uri not pinned) is not an outage: it
// shows up in Ready and Status, and is logged.
//
// # Fetching
//
// Discovery and JWKS are fetched with a copy of the caller's client that never
// follows redirects. A 3xx is a failed fetch. The JWKS is pinned to exactly
// <Issuer>/jwks.json, the path the spec fixes, and discovery must name that URL.
//
// # Cache
//
// The cache honours the issuer's max-age, clamped to one hour so a long value
// cannot keep a removed key alive. Past max-age, a cached key is still served
// while a refresh runs in the background. Past StaleKeysFor the cache is never
// used. Unknown kids trigger a refresh at most once a minute, and concurrent
// refreshes share one fetch.
//
// # Audience form
//
// aud must name exactly one audience, either as a JSON string or as a
// one-element JSON array, and that audience must equal Config.Audience. An
// array with several entries is rejected even when one of them is the expected
// audience: a token minted for several services would otherwise be replayable
// against each of them.
//
// # Matching is exact
//
// iss and aud are compared byte for byte, case included. Only the config's
// AllowSubjects and DenyKIDs are trimmed, and empty entries are config errors.
//
// # Replay
//
// jti is required but not checked for replay. The ingest idempotency key is the
// replay control, so a replayed token cannot duplicate an ingest.
package workloadauth
