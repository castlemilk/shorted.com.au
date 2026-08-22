/**
 * The 429 contract: parsing, classification, and the retry policy that hangs
 * off it.
 *
 * The load-bearing rule is that `monthly` and `per_minute` are handled
 * OPPOSITELY — per-minute retries automatically, monthly must not, because a
 * monthly quota does not refill for weeks and retrying only delays the one
 * useful response (the upgrade panel).
 */
import {
  isRateLimitError,
  isMonthlyQuotaExhausted,
  parseRateLimitInfo,
  shouldRetryConnectError,
  retryWithBackoff,
  DEFAULT_UPGRADE_URL,
} from "../retry";

/**
 * Build a duck-typed ConnectError. We deliberately do NOT import from
 * @connectrpc/connect — that package breaks Next.js SSR (see CLAUDE.md), and
 * the production code duck-types for exactly this reason.
 */
function connectError(
  code: number,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    code,
    message: "rate limit exceeded",
    metadata: {
      get: (key: string): string | null => headers[key] ?? null,
    },
    ...extra,
  };
}

const NOW = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("isRateLimitError", () => {
  it("matches ResourceExhausted (code 8) only", () => {
    expect(isRateLimitError(connectError(8))).toBe(true);
    expect(isRateLimitError(connectError(14))).toBe(false);
    expect(isRateLimitError(new Error("nope"))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("parseRateLimitInfo classification", () => {
  it("classifies the edge's per-minute 429 via X-RateLimit-Scope", () => {
    const info = parseRateLimitInfo(
      connectError(8, {
        "X-RateLimit-Scope": "edge-minute",
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "0",
        "Retry-After": "60",
      }),
    );
    expect(info.kind).toBe("per_minute");
    expect(info.limit).toBe(100);
    expect(info.retryAfter).toBe(60);
  });

  it("classifies monthly from provable exhaustion in the headers", () => {
    const info = parseRateLimitInfo(
      connectError(8, {
        "X-RateLimit-Monthly-Limit": "2000",
        "X-RateLimit-Monthly-Used": "2000",
        "X-RateLimit-Monthly-Reset": String(NOW + 86_400),
      }),
    );
    expect(info.kind).toBe("monthly");
    expect(info.monthlyUsed).toBe(2000);
    expect(info.monthlyLimit).toBe(2000);
  });

  it("does NOT claim monthly when the quota is merely reported, not exhausted", () => {
    // This is the important negative: every successful-then-429 response also
    // carries monthly headers. Showing the upgrade panel here would be a lie.
    const info = parseRateLimitInfo(
      connectError(8, {
        "X-RateLimit-Monthly-Limit": "2000",
        "X-RateLimit-Monthly-Used": "12",
        "X-RateLimit-Limit": "100",
      }),
    );
    expect(info.kind).toBe("per_minute");
  });

  it("treats an unmetered monthly quota (limit 0) as not-monthly", () => {
    const info = parseRateLimitInfo(
      connectError(8, {
        "X-RateLimit-Monthly-Limit": "0",
        "X-RateLimit-Monthly-Used": "0",
      }),
    );
    expect(info.kind).toBe("unknown");
  });

  it("falls back to 'unknown' for a bare 429 with no usable headers", () => {
    expect(parseRateLimitInfo(connectError(8)).kind).toBe("unknown");
  });

  it("returns not-rate-limited for other codes and non-errors", () => {
    expect(parseRateLimitInfo(connectError(5)).isRateLimited).toBe(false);
    expect(parseRateLimitInfo("nope").isRateLimited).toBe(false);
  });

  it("survives an error whose metadata bag throws or is missing", () => {
    const hostile = {
      code: 8,
      message: "x",
      metadata: {
        get: () => {
          throw new Error("boom");
        },
      },
    };
    expect(() => parseRateLimitInfo(hostile)).not.toThrow();
    expect(parseRateLimitInfo(hostile).isRateLimited).toBe(true);
  });

  it("drops NaN and negative header values instead of surfacing them", () => {
    const info = parseRateLimitInfo(
      connectError(8, {
        "Retry-After": "-30",
        "X-RateLimit-Limit": "banana",
        "X-RateLimit-Monthly-Used": "",
      }),
    );
    expect(info.retryAfter).toBeUndefined();
    expect(info.limit).toBeUndefined();
    expect(info.monthlyUsed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Structured payload (forward-compatible with an explicit server contract)
// ---------------------------------------------------------------------------

describe("parseRateLimitInfo structured payload", () => {
  it("prefers an explicit kind/tier/upgrade_url payload over inference", () => {
    const info = parseRateLimitInfo(
      connectError(
        8,
        { "X-RateLimit-Limit": "100" },
        {
          rateLimit: {
            kind: "monthly",
            limit: 2000,
            used: 2000,
            reset: NOW + 3600,
            tier: "free",
            upgrade_url: "https://shorted.com.au/pricing",
          },
        },
      ),
    );
    expect(info.kind).toBe("monthly");
    expect(info.tier).toBe("free");
    expect(info.upgradeUrl).toBe("https://shorted.com.au/pricing");
  });

  it("reads a payload delivered in a details array", () => {
    const info = parseRateLimitInfo(
      connectError(8, {}, { details: [{ kind: "monthly", tier: "paid" }] }),
    );
    expect(info.kind).toBe("monthly");
    expect(info.tier).toBe("paid");
  });

  it("reads tier and upgrade url from headers when no payload is present", () => {
    const info = parseRateLimitInfo(
      connectError(8, {
        "X-RateLimit-Tier": "Paid",
        "X-RateLimit-Upgrade-Url": "/pricing",
      }),
    );
    expect(info.tier).toBe("paid");
    expect(info.upgradeUrl).toBe("/pricing");
  });

  it("rejects an unknown tier and a dangerous upgrade url", () => {
    const info = parseRateLimitInfo(
      connectError(
        8,
        {},
        {
          rateLimit: {
            tier: "platinum",
            // eslint-disable-next-line no-script-url
            upgrade_url: "javascript:alert(1)",
          },
        },
      ),
    );
    expect(info.tier).toBeUndefined();
    expect(info.upgradeUrl).toBeUndefined();
  });

  it("rejects a protocol-relative upgrade url", () => {
    const info = parseRateLimitInfo(
      connectError(8, {}, { rateLimit: { upgrade_url: "//evil.example/pricing" } }),
    );
    expect(info.upgradeUrl).toBeUndefined();
  });

  it("exposes /pricing as the canonical default", () => {
    expect(DEFAULT_UPGRADE_URL).toBe("/pricing");
  });
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

describe("retry policy for 429s", () => {
  const perMinuteErr = connectError(8, {
    "X-RateLimit-Scope": "edge-minute",
    "Retry-After": "1",
  });
  const monthlyErr = connectError(8, {
    "X-RateLimit-Monthly-Limit": "2000",
    "X-RateLimit-Monthly-Used": "2000",
  });

  it("retries a per-minute limit", () => {
    expect(shouldRetryConnectError(perMinuteErr)).toBe(true);
  });

  it("does NOT retry an exhausted monthly quota", () => {
    expect(shouldRetryConnectError(monthlyErr)).toBe(false);
    expect(isMonthlyQuotaExhausted(monthlyErr)).toBe(true);
  });

  it("retries an unclassified 429 (assumed transient)", () => {
    expect(shouldRetryConnectError(connectError(8))).toBe(true);
  });

  it("leaves non-429 policy untouched", () => {
    expect(shouldRetryConnectError(connectError(14))).toBe(true); // Unavailable
    expect(shouldRetryConnectError(connectError(5))).toBe(false); // NotFound
  });
});

describe("retryWithBackoff honours the 429 policy", () => {
  it("retries a per-minute failure and eventually succeeds", async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw connectError(8, {
          "X-RateLimit-Scope": "edge-minute",
          "Retry-After": "0",
        });
      }
      return "ok";
    });

    await expect(
      retryWithBackoff(fn, { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up immediately on an exhausted monthly quota", async () => {
    const err = connectError(8, {
      "X-RateLimit-Monthly-Limit": "2000",
      "X-RateLimit-Monthly-Used": "2000",
    });
    const fn = jest.fn(async () => {
      throw err;
    });

    await expect(
      retryWithBackoff(fn, { maxRetries: 3, initialDelayMs: 0, maxDelayMs: 0 }),
    ).rejects.toBe(err);
    // One attempt, zero retries.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("caps the wait using Retry-After rather than backing off unbounded", async () => {
    const started = Date.now();
    const fn = jest.fn(async () => {
      throw connectError(8, {
        "X-RateLimit-Scope": "edge-minute",
        "Retry-After": "3600", // absurd; must be capped by maxDelayMs
      });
    });

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 1,
        initialDelayMs: 0,
        maxDelayMs: 20,
      }),
    ).rejects.toBeDefined();

    expect(Date.now() - started).toBeLessThan(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
