/**
 * GA4 instrumentation for the developer / API-token surface (`/developer`).
 *
 * Why this exists separately from `rate-limit-analytics.ts`: these are the users
 * most likely to hit an API limit, and today we cannot see whether they
 * self-serve. We know when a limit fires, and (since #469) when a notice is
 * shown — but not whether anyone ever reached the page that fixes it, minted a
 * key, or rotated one after a leak.
 *
 *   api_token_view ──► api_token_created ──► api_token_copied
 *                  └─► api_token_regenerated   (rotation == revocation here)
 *                  └─► api_token_create_failed (the silent failure)
 *
 * Same safety properties as every other GA call site — see
 * `analytics-events.ts`, which is the only thing this module imports:
 * never throws, no-op without `window.gtag`, low cardinality, no PII.
 *
 * **No token material is ever a parameter.** The only params are the surface
 * and a boolean saying whether this was the caller's first token.
 */

import { sendGaEvent } from "./analytics-events";

export const DEVELOPER_EVENTS = {
  /** The developer surface (token + quota tables) was rendered. */
  TOKEN_VIEW: "api_token_view",
  /** A token was minted where the caller had none. Activation. */
  TOKEN_CREATED: "api_token_created",
  /**
   * A token was minted over an existing one.
   *
   * This product has no explicit revoke: regenerating invalidates the previous
   * token, so this IS the revocation event. Named for what the user does.
   */
  TOKEN_REGENERATED: "api_token_regenerated",
  /** The token was copied to the clipboard — the step that makes it usable. */
  TOKEN_COPIED: "api_token_copied",
  /**
   * Minting failed. Fires on the branch that today only sets local error state,
   * so a broken self-serve path is invisible in aggregate.
   */
  TOKEN_CREATE_FAILED: "api_token_create_failed",
} as const;

export type DeveloperEventName =
  (typeof DEVELOPER_EVENTS)[keyof typeof DEVELOPER_EVENTS];

export interface DeveloperEventParams {
  /**
   * Whether the caller had no token before this action. Boolean, not a count —
   * a count of a user's tokens is closer to identifying them than it is useful.
   */
  first_token?: boolean;
}

/** Events that happen *to* the user rather than *by* the user. */
const NON_INTERACTION_EVENTS: ReadonlySet<string> = new Set<string>([
  DEVELOPER_EVENTS.TOKEN_VIEW,
  DEVELOPER_EVENTS.TOKEN_CREATE_FAILED,
]);

/**
 * Send one developer-surface event.
 *
 * Dedupe is the caller's job: `api_token_view` is fired once per mount from a
 * ref, while the three action events are genuinely once-per-click.
 */
export function trackDeveloperEvent(
  name: DeveloperEventName,
  params: DeveloperEventParams = {},
): void {
  try {
    const payload: Record<string, string | boolean> = {
      // Constant rather than `currentSurface()`: every one of these fires from
      // /developer, and hard-coding it means a future embed of the manager
      // elsewhere shows up as a data change rather than silently merging.
      surface: "/developer",
      non_interaction: NON_INTERACTION_EVENTS.has(name),
    };
    if (typeof params.first_token === "boolean") {
      payload.first_token = params.first_token;
    }
    sendGaEvent(name, payload);
  } catch {
    // Analytics must never surface to the user.
  }
}
