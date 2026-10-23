/**
 * Identity the paid-feature probe runs as.
 *
 * It is NOT a Firebase account. The Go API entitles it through the internal
 * tier grant (INTERNAL_TIER_USER_IDS, set by terraform/environments/prod),
 * never through an api_subscriptions row. A probe run therefore never shows up
 * as a paying user in billing, and a Stripe webhook can never overwrite it.
 */
export const PAID_PROBE_USER_ID = "svc-paid-probe";
export const PAID_PROBE_EMAIL = "paid-probe@shorted.com.au";
export const PAID_PROBE_NAME = "Paid feature probe";

/**
 * Every probe request, to the app and to the Go API, identifies itself with
 * this UA and nothing else. It must NOT carry the first-party marker
 * (`shorted-web-ssr`) or the E2E marker (`Shorted-E2E`). The first sends the
 * request to the first-party bucket and the second skips the limiter, so either
 * one would make a green probe measure a path no paying customer takes. See
 * CLAUDE.md > Rate Limiting.
 */
export const PAID_PROBE_USER_AGENT = "shorted-paid-probe/1.0 (+https://shorted.com.au)";

/** Fixed question: one tool call, one short answer, no open-ended cost. */
export const PAID_PROBE_QUESTION =
  "What is the latest reported short position in BHP? Answer in one sentence.";

/**
 * Per-step budgets in milliseconds. The route's maxDuration is 120s, so the
 * worst case must fit under it: entitlement 10 + chat 60 (+ 5 cleanup) +
 * api_token 15 + gates 10 = 100s, then the check-ins, which run in parallel
 * under an 8s timeout each.
 */
export const STEP_BUDGET_MS = {
  entitlement: 10_000,
  chat: 60_000,
  chatCleanup: 5_000,
  apiToken: 15_000,
  gates: 10_000,
} as const;

/**
 * The smallest MONTHLY API quota a paid tier gets (pro and premium 10,000,
 * enterprise 50,000; free is 1,000). Checked against the
 * X-RateLimit-Monthly-Limit header, which the Go API only emits for a caller
 * on a metered tier. The contract test reads DefaultConfig rather than trusting
 * this number, so the two cannot drift.
 */
export const PAID_API_MONTHLY_LIMIT_MIN = 10_000;

/**
 * The public API host paying customers call. The api_token step authenticates
 * through it, so the Cloudflare edge worker is part of what the probe checks.
 * In production this is the only public origin the probe will send a token to.
 */
export const PUBLIC_API_ORIGIN = "https://api.shorted.com.au";

/**
 * The app origins a production run may use when the base URL is derived from
 * the request's Host header rather than configured. NEXTAUTH_URL's origin is
 * added to this set at runtime (context.ts).
 */
export const PRODUCTION_APP_ORIGINS: readonly string[] = [
  "https://shorted.com.au",
  "https://www.shorted.com.au",
];
