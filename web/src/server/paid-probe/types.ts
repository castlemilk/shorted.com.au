import type { ProbeCookie } from "./session-cookie";

/**
 * Everything a probe run touches from the outside, injected so the steps stay
 * pure enough to test with a fake fetch and a fake clock. The route builds the
 * real one (context.ts); tests build fakes.
 */
export interface ProbeContext {
  /** Origin of the app under test. Chat and gate requests go here. */
  origin: string;
  /** Base URL of the Go shorts API. Entitlement, token and data calls go here. */
  shortsApiUrl: string;
  /** INTERNAL_SERVICE_SECRET, or "" when unset (the steps then fail closed). */
  internalSecret: string;
  /** The probe's own fetch: plain UA, no-store, never a bypass secret. */
  fetch: typeof fetch;
  /** Mints the probe session cookie. Throws when NEXTAUTH_SECRET is unset. */
  sessionCookie: () => Promise<ProbeCookie>;
  now: () => number;
  /** Values scrubbed from every detail string before it leaves the process. */
  secrets: readonly string[];
}

/**
 * A step failure with a reason that is safe to return to the caller and to
 * Telesis. Anything else thrown is described by its error name only.
 */
export class ProbeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeFailure";
  }
}

/** Name of an error for logs and details. Never the message: fetch errors can carry a URL. */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}
