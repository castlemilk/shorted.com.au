/**
 * RateLimitNotice — both variants, all three tiers, both limit kinds, and
 * degraded/garbage payloads.
 *
 * The governing product rule under test: a per-minute limit must read as a
 * calm, self-healing pause (no alarm language, no upgrade CTA), while a
 * monthly limit is the upgrade moment.
 */
import React from "react";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import {
  RateLimitNotice,
  formatCountdown,
  formatResetDate,
} from "../rate-limit-notice";
import type { RateLimitInfo } from "~/@/lib/retry";

const NOW_SECONDS = 1_756_684_800; // 2025-09-01T00:00:00Z — stable in tests

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW_SECONDS * 1000);
});

afterEach(() => {
  jest.useRealTimers();
});

function perMinute(overrides: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    isRateLimited: true,
    kind: "per_minute",
    limit: 100,
    remaining: 0,
    resetAt: NOW_SECONDS + 45,
    retryAfter: 45,
    ...overrides,
  };
}

function monthly(overrides: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    isRateLimited: true,
    kind: "monthly",
    monthlyLimit: 2000,
    monthlyUsed: 2000,
    monthlyResetAt: NOW_SECONDS + 86_400 * 30,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe("formatCountdown", () => {
  it("formats sub-minute values in seconds", () => {
    expect(formatCountdown(45)).toBe("45s");
    expect(formatCountdown(0)).toBe("0s");
  });

  it("formats minutes with zero-padded seconds", () => {
    expect(formatCountdown(125)).toBe("2m 05s");
  });

  it("formats hours and days", () => {
    expect(formatCountdown(3600 * 2 + 60 * 12)).toBe("2h 12m");
    expect(formatCountdown(86_400 * 3 + 3600 * 4)).toBe("3d 4h");
  });

  it("returns null for missing or garbage input", () => {
    expect(formatCountdown(undefined)).toBeNull();
    expect(formatCountdown(null)).toBeNull();
    expect(formatCountdown(-5)).toBeNull();
    expect(formatCountdown(NaN)).toBeNull();
    expect(formatCountdown(Infinity)).toBeNull();
  });
});

describe("formatResetDate", () => {
  it("formats a valid unix timestamp", () => {
    expect(formatResetDate(NOW_SECONDS)).toMatch(/September/);
  });

  it("returns null for missing, zero, negative or millisecond-scale values", () => {
    expect(formatResetDate(undefined)).toBeNull();
    expect(formatResetDate(null)).toBeNull();
    expect(formatResetDate(0)).toBeNull();
    expect(formatResetDate(-1)).toBeNull();
    // milliseconds accidentally passed as seconds → out of range, rejected
    expect(formatResetDate(NOW_SECONDS * 1000)).toBeNull();
    expect(formatResetDate(NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inline variant — per-minute
// ---------------------------------------------------------------------------

describe("RateLimitNotice inline / per_minute", () => {
  it("reads as a calm self-healing pause, not an error", () => {
    render(<RateLimitNotice info={perMinute()} variant="inline" />);

    expect(screen.getByText(/just a moment/i)).toBeInTheDocument();
    // No alarm language and no upsell on a transient burst limit.
    expect(screen.queryByText(/exceeded/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /upgrade/i })).not.toBeInTheDocument();
  });

  it("renders a live countdown that ticks down", () => {
    render(<RateLimitNotice info={perMinute()} variant="inline" />);
    expect(screen.getByText("45s")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(screen.getByText("40s")).toBeInTheDocument();
  });

  it("omits the countdown when no reset information is available", () => {
    render(
      <RateLimitNotice
        info={perMinute({ resetAt: undefined, retryAfter: undefined })}
        variant="inline"
      />,
    );
    expect(screen.getByText(/refreshing shortly/i)).toBeInTheDocument();
  });

  it("offers a manual retry only once the countdown has elapsed", () => {
    const onRetry = jest.fn();
    render(
      <RateLimitNotice info={perMinute()} variant="inline" onRetry={onRetry} />,
    );
    // Countdown still running → no retry button.
    expect(
      screen.queryByRole("button", { name: /retry now/i }),
    ).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(46_000);
    });
    expect(screen.getByRole("button", { name: /retry now/i })).toBeInTheDocument();
  });

  it("is announced politely to assistive tech", () => {
    render(<RateLimitNotice info={perMinute()} variant="inline" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});

// ---------------------------------------------------------------------------
// Inline variant — monthly
// ---------------------------------------------------------------------------

describe("RateLimitNotice inline / monthly", () => {
  it("states what ran out and offers the upgrade CTA", () => {
    render(<RateLimitNotice info={monthly()} variant="inline" tier="free" />);

    expect(screen.getByText(/monthly request allowance/i)).toBeInTheDocument();
    expect(screen.getByText(/2,000 of 2,000/)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /upgrade/i });
    expect(cta).toHaveAttribute("href", "/pricing");
  });
});

// ---------------------------------------------------------------------------
// Page variant — kinds
// ---------------------------------------------------------------------------

describe("RateLimitNotice page variant", () => {
  it("per_minute shows the countdown and no upgrade benefits", () => {
    render(<RateLimitNotice info={perMinute()} variant="page" tier="free" />);

    expect(screen.getByText(/just a moment/i)).toBeInTheDocument();
    expect(screen.getByText(/retrying in/i)).toBeInTheDocument();
    expect(screen.getByText(/100 requests\/minute/i)).toBeInTheDocument();
    // Benefits list is the monthly-only upgrade pitch.
    expect(
      screen.queryByText(/unlimited requests — no monthly ceiling/i),
    ).not.toBeInTheDocument();
  });

  it("monthly shows usage, reset date and what upgrading gives", () => {
    render(<RateLimitNotice info={monthly()} variant="page" tier="free" />);

    expect(screen.getByText(/used this month's requests/i)).toBeInTheDocument();
    expect(screen.getByText("2,000 / 2,000")).toBeInTheDocument();
    expect(screen.getByText(/resets on/i)).toBeInTheDocument();
    expect(
      screen.getByText(/unlimited requests — no monthly ceiling/i),
    ).toBeInTheDocument();

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
  });

  it("does not offer a retry button for a monthly quota", () => {
    render(
      <RateLimitNotice
        info={monthly()}
        variant="page"
        tier="free"
        onRetry={jest.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /try again/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tier-aware CTAs
// ---------------------------------------------------------------------------

describe("RateLimitNotice tier messaging", () => {
  it("anonymous is invited to sign in", () => {
    render(
      <RateLimitNotice info={monthly()} variant="page" tier="anonymous" />,
    );
    const cta = screen.getByRole("link", { name: /sign in for higher limits/i });
    expect(cta.getAttribute("href")).toContain("/signin");
  });

  it("free is invited to upgrade, at the canonical pricing page", () => {
    render(<RateLimitNotice info={monthly()} variant="page" tier="free" />);
    expect(screen.getByRole("link", { name: /upgrade/i })).toHaveAttribute(
      "href",
      "/pricing",
    );
  });

  it("paid is pointed at support rather than sold to", () => {
    render(<RateLimitNotice info={monthly()} variant="page" tier="paid" />);
    const cta = screen.getByRole("link", { name: /contact support/i });
    expect(cta.getAttribute("href")).toContain("mailto:support@shorted.com.au");
    // A paying customer must never be shown an upsell for a limit.
    expect(
      screen.queryByText(/unlimited requests — no monthly ceiling/i),
    ).not.toBeInTheDocument();
  });

  it("prefers an explicit server-reported tier over the session", () => {
    render(<RateLimitNotice info={monthly({ tier: "paid" })} variant="page" />);
    expect(
      screen.getByRole("link", { name: /contact support/i }),
    ).toBeInTheDocument();
  });

  it("honours a server-supplied upgrade URL", () => {
    render(
      <RateLimitNotice
        info={monthly({ upgradeUrl: "https://shorted.com.au/pricing?ref=429" })}
        variant="page"
        tier="free"
      />,
    );
    expect(screen.getByRole("link", { name: /upgrade/i })).toHaveAttribute(
      "href",
      "https://shorted.com.au/pricing?ref=429",
    );
  });
});

// ---------------------------------------------------------------------------
// Degraded payloads
// ---------------------------------------------------------------------------

describe("RateLimitNotice with missing or garbage payload fields", () => {
  it("renders the transient state for a bare unclassified 429", () => {
    render(
      <RateLimitNotice
        info={{ isRateLimited: true, kind: "unknown" }}
        variant="inline"
      />,
    );
    expect(screen.getByText(/just a moment/i)).toBeInTheDocument();
  });

  it("renders a monthly panel without numbers when they are absent", () => {
    render(
      <RateLimitNotice
        info={{ isRateLimited: true, kind: "monthly" }}
        variant="page"
        tier="free"
      />,
    );
    expect(screen.getByText(/used this month's requests/i)).toBeInTheDocument();
    // Falls back to generic reset copy rather than printing a bogus date.
    expect(
      screen.getByText(/at the start of next month/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it("never renders NaN or Invalid Date from garbage numbers", () => {
    const { container } = render(
      <RateLimitNotice
        info={{
          isRateLimited: true,
          kind: "monthly",
          monthlyLimit: NaN,
          monthlyUsed: NaN,
          monthlyResetAt: NaN,
        }}
        variant="page"
        tier="free"
      />,
    );
    expect(container.textContent).not.toMatch(/NaN|Invalid Date/);
  });

  it("clamps a usage bar that exceeds its limit", () => {
    render(
      <RateLimitNotice
        info={monthly({ monthlyUsed: 5000, monthlyLimit: 2000 })}
        variant="page"
        tier="free"
      />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
  });
});
