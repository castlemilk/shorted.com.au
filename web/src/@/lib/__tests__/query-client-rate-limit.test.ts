/**
 * The TanStack Query defaults are the thing that actually governs what a
 * browsing user experiences on a 429, so we assert against the real configured
 * `retry` / `retryDelay` rather than re-testing the helpers in isolation.
 */
import { getQueryClient } from "../query-client";

function connectError(code: number, headers: Record<string, string> = {}) {
  return {
    code,
    message: "rate limit exceeded",
    metadata: { get: (k: string): string | null => headers[k] ?? null },
  };
}

const PER_MINUTE = connectError(8, {
  "X-RateLimit-Scope": "edge-minute",
  "Retry-After": "60",
});

const MONTHLY = connectError(8, {
  "X-RateLimit-Monthly-Limit": "2000",
  "X-RateLimit-Monthly-Used": "2000",
});

function defaults() {
  const options = getQueryClient().getDefaultOptions().queries!;
  return {
    retry: options.retry as (failureCount: number, error: unknown) => boolean,
    retryDelay: options.retryDelay as (
      attempt: number,
      error: unknown,
    ) => number,
  };
}

describe("query client 429 retry policy", () => {
  it("retries a per-minute limit", () => {
    const { retry } = defaults();
    expect(retry(0, PER_MINUTE)).toBe(true);
    expect(retry(2, PER_MINUTE)).toBe(true);
  });

  it("stops retrying a per-minute limit after 3 failures", () => {
    const { retry } = defaults();
    expect(retry(3, PER_MINUTE)).toBe(false);
  });

  it("never retries an exhausted monthly quota", () => {
    const { retry } = defaults();
    expect(retry(0, MONTHLY)).toBe(false);
    expect(retry(1, MONTHLY)).toBe(false);
  });

  it("retries an unclassified 429 as transient", () => {
    const { retry } = defaults();
    expect(retry(0, connectError(8))).toBe(true);
  });

  it("leaves non-429 behaviour intact", () => {
    const { retry } = defaults();
    expect(retry(0, connectError(14))).toBe(true); // Unavailable
    expect(retry(0, connectError(5))).toBe(false); // NotFound
  });
});

describe("query client 429 retry delay", () => {
  it("honours Retry-After but caps the wait so the UI stays responsive", () => {
    const { retryDelay } = defaults();
    // Retry-After: 60 → would be 60_500ms uncapped; cap is 30s.
    expect(retryDelay(0, PER_MINUTE)).toBe(30_000);
  });

  it("uses a short server-suggested delay verbatim (plus a small buffer)", () => {
    const { retryDelay } = defaults();
    const err = connectError(8, {
      "X-RateLimit-Scope": "edge-minute",
      "Retry-After": "5",
    });
    expect(retryDelay(0, err)).toBe(5_500);
  });

  it("backs off exponentially when no Retry-After is supplied, still capped", () => {
    const { retryDelay } = defaults();
    const err = connectError(8, { "X-RateLimit-Scope": "edge-minute" });
    expect(retryDelay(0, err)).toBe(5_000);
    expect(retryDelay(1, err)).toBe(10_000);
    expect(retryDelay(5, err)).toBe(30_000);
  });

  it("uses standard backoff for non-rate-limit errors", () => {
    const { retryDelay } = defaults();
    expect(retryDelay(0, connectError(14))).toBe(1_000);
    expect(retryDelay(2, connectError(14))).toBe(4_000);
  });
});
