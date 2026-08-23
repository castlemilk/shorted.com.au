/**
 * The TanStack Query defaults are the thing that actually governs what a
 * browsing user experiences on a 429, so we assert against the real configured
 * `retry` / `retryDelay` rather than re-testing the helpers in isolation.
 */
import { getQueryClient, handleRateLimitCacheEvent } from "../query-client";

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

// ---------------------------------------------------------------------------
// rate_limit_auto_recovered — the quiet path, made measurable
// ---------------------------------------------------------------------------

type GtagWindow = { gtag?: (...args: unknown[]) => void };

function updatedEvent(queryHash: string, action: Record<string, unknown>) {
  return { type: "updated", query: { queryHash }, action };
}

describe("rate_limit_auto_recovered", () => {
  let gtag: jest.Mock;

  beforeEach(() => {
    gtag = jest.fn();
    (window as GtagWindow).gtag = gtag;
  });

  afterEach(() => {
    delete (window as GtagWindow).gtag;
  });

  function recovered() {
    return gtag.mock.calls.filter(
      (c) => c[0] === "event" && c[1] === "rate_limit_auto_recovered",
    );
  }

  it("reports a per-minute 429 that retried and then succeeded", () => {
    handleRateLimitCacheEvent(
      updatedEvent("q-a", { type: "failed", error: PER_MINUTE }),
    );
    handleRateLimitCacheEvent(updatedEvent("q-a", { type: "success" }));

    expect(recovered()).toHaveLength(1);
    expect(recovered()[0]![2]).toMatchObject({
      kind: "per_minute",
      non_interaction: true,
    });
  });

  it("fires once, not on every later success of the same query", () => {
    handleRateLimitCacheEvent(
      updatedEvent("q-b", { type: "failed", error: PER_MINUTE }),
    );
    handleRateLimitCacheEvent(updatedEvent("q-b", { type: "success" }));
    handleRateLimitCacheEvent(updatedEvent("q-b", { type: "success" }));

    expect(recovered()).toHaveLength(1);
  });

  it("stays silent for a success that was never rate limited", () => {
    handleRateLimitCacheEvent(updatedEvent("q-c", { type: "success" }));
    expect(recovered()).toHaveLength(0);
  });

  it("stays silent for a monthly quota (it is never auto-retried)", () => {
    handleRateLimitCacheEvent(
      updatedEvent("q-d", { type: "failed", error: MONTHLY }),
    );
    handleRateLimitCacheEvent(updatedEvent("q-d", { type: "success" }));
    expect(recovered()).toHaveLength(0);
  });

  it("drops the pending entry when retries are exhausted", () => {
    handleRateLimitCacheEvent(
      updatedEvent("q-e", { type: "failed", error: PER_MINUTE }),
    );
    handleRateLimitCacheEvent(
      updatedEvent("q-e", { type: "error", error: PER_MINUTE }),
    );
    handleRateLimitCacheEvent(updatedEvent("q-e", { type: "success" }));
    expect(recovered()).toHaveLength(0);
  });

  it("ignores non-rate-limit failures and malformed events", () => {
    handleRateLimitCacheEvent(
      updatedEvent("q-f", { type: "failed", error: connectError(14) }),
    );
    handleRateLimitCacheEvent(updatedEvent("q-f", { type: "success" }));
    expect(() =>
      handleRateLimitCacheEvent({} as never),
    ).not.toThrow();
    expect(recovered()).toHaveLength(0);
  });

  it("is wired into the real query cache end to end", async () => {
    const client = getQueryClient();
    let attempt = 0;

    await client.fetchQuery({
      queryKey: ["rate-limit-auto-recovery-probe"],
      retry: 1,
      retryDelay: 0,
      queryFn: () => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(PER_MINUTE);
        return Promise.resolve("ok");
      },
    });

    expect(attempt).toBe(2);
    expect(recovered()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// rate_limit_encountered — the denominator: every classified 429, UI or not
// ---------------------------------------------------------------------------

describe("rate_limit_encountered", () => {
  let gtag: jest.Mock;

  beforeEach(() => {
    gtag = jest.fn();
    (window as GtagWindow).gtag = gtag;
  });

  afterEach(() => {
    delete (window as GtagWindow).gtag;
  });

  function encountered() {
    return gtag.mock.calls.filter(
      (c) => c[0] === "event" && c[1] === "rate_limit_encountered",
    );
  }

  it("fires on a 429 that nothing will ever render", () => {
    handleRateLimitCacheEvent(
      updatedEvent("e-a", { type: "failed", error: PER_MINUTE }),
    );

    expect(encountered()).toHaveLength(1);
    expect(encountered()[0]![2]).toMatchObject({
      kind: "per_minute",
      // Being limited is not engagement.
      non_interaction: true,
    });
    // No UI was involved, so no variant is claimed.
    expect(encountered()[0]![2]).not.toHaveProperty("variant");
  });

  it("fires for a monthly quota too — unlike auto_recovered", () => {
    handleRateLimitCacheEvent(
      updatedEvent("e-b", { type: "failed", error: MONTHLY }),
    );
    expect(encountered()).toHaveLength(1);
    expect(encountered()[0]![2]).toMatchObject({ kind: "monthly" });
  });

  it("counts one occurrence, not one per retry attempt", () => {
    // TanStack dispatches `failed` once per attempt; three retries of the same
    // 429 must not read as four limits.
    for (let i = 0; i < 4; i += 1) {
      handleRateLimitCacheEvent(
        updatedEvent("e-c", { type: "failed", error: PER_MINUTE }),
      );
    }
    expect(encountered()).toHaveLength(1);
  });

  it("counts a genuinely new limit after a recovery", () => {
    handleRateLimitCacheEvent(
      updatedEvent("e-d", { type: "failed", error: PER_MINUTE }),
    );
    handleRateLimitCacheEvent(updatedEvent("e-d", { type: "success" }));
    handleRateLimitCacheEvent(
      updatedEvent("e-d", { type: "failed", error: PER_MINUTE }),
    );
    expect(encountered()).toHaveLength(2);
  });

  it("counts a new limit after retries were exhausted", () => {
    handleRateLimitCacheEvent(
      updatedEvent("e-e", { type: "failed", error: PER_MINUTE }),
    );
    handleRateLimitCacheEvent(
      updatedEvent("e-e", { type: "error", error: PER_MINUTE }),
    );
    handleRateLimitCacheEvent(
      updatedEvent("e-e", { type: "failed", error: PER_MINUTE }),
    );
    expect(encountered()).toHaveLength(2);
  });

  it("re-fires when the reset window moves — that is a different limit", () => {
    const first = connectError(8, {
      "X-RateLimit-Scope": "edge-minute",
      "Retry-After": "10",
    });
    const second = connectError(8, {
      "X-RateLimit-Scope": "edge-minute",
      "Retry-After": "30",
    });
    handleRateLimitCacheEvent(updatedEvent("e-f", { type: "failed", error: first }));
    handleRateLimitCacheEvent(
      updatedEvent("e-f", { type: "failed", error: second }),
    );
    expect(encountered()).toHaveLength(2);
  });

  it("stays silent for non-429 failures", () => {
    handleRateLimitCacheEvent(
      updatedEvent("e-g", { type: "failed", error: connectError(14) }),
    );
    expect(encountered()).toHaveLength(0);
  });

  it("is a no-op when GA is absent, and never throws", () => {
    delete (window as GtagWindow).gtag;
    expect(() =>
      handleRateLimitCacheEvent(
        updatedEvent("e-h", { type: "failed", error: PER_MINUTE }),
      ),
    ).not.toThrow();
  });

  it("does not suppress the auto_recovered event for the same query", () => {
    handleRateLimitCacheEvent(
      updatedEvent("e-i", { type: "failed", error: PER_MINUTE }),
    );
    handleRateLimitCacheEvent(updatedEvent("e-i", { type: "success" }));

    expect(encountered()).toHaveLength(1);
    expect(
      gtag.mock.calls.filter(
        (c) => c[1] === "rate_limit_auto_recovered",
      ),
    ).toHaveLength(1);
  });
});
