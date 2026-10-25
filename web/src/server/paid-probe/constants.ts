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
 * Per-step budgets in milliseconds. The admin MCP tool that starts a run is
 * bounded by a 90s stream lifetime, so the worst case (every step at its budget,
 * then the check-ins) must stay under PROBE_WORST_CASE_CEILING_MS, 75s. That is
 * 8 + 40 + 10 + 8 + 6 = 72s. The route's maxDuration (120s) is headroom above
 * it, not budget.
 *
 * chat is the whole chat step. Its turn (request and stream) gets
 * CHAT_TURN_BUDGET_MS and the conversation cleanup gets chatCleanup, so the step
 * cannot run past its budget. steps.test.ts sums these numbers and asserts the ceiling.
 */
export const STEP_BUDGET_MS = {
  entitlement: 8_000,
  chat: 40_000,
  chatCleanup: 5_000,
  apiToken: 10_000,
  gates: 8_000,
} as const;

/** The chat step's share for the turn itself: the answer request and its stream. */
export const CHAT_TURN_BUDGET_MS = STEP_BUDGET_MS.chat - STEP_BUDGET_MS.chatCleanup;

/** Every check-in is posted in parallel, so the whole group shares one timeout. */
export const CHECKIN_BUDGET_MS = 6_000;

/** The longest a run may take. The admin MCP tool's 90s stream lifetime leaves this headroom. */
export const PROBE_WORST_CASE_CEILING_MS = 75_000;

/**
 * The smallest MONTHLY API quota a sold API tier gets (API Access 10,000,
 * enterprise 50,000; free and Premium are 1,000). Checked against the
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
