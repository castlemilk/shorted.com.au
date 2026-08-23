/**
 * RateLimitNotice → GA4 funnel wiring.
 *
 * The load-bearing assertion is "once per occurrence": the notice re-renders
 * every second while its countdown ticks, so a naive effect would report one
 * `rate_limit_notice_shown` per second and make the funnel meaningless.
 */
import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { RateLimitNotice } from "../rate-limit-notice";
import type { RateLimitInfo } from "~/@/lib/retry";

const NOW_SECONDS = 1_756_684_800; // 2025-09-01T00:00:00Z

type GtagWindow = { gtag?: (...args: unknown[]) => void };
let gtag: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW_SECONDS * 1000);
  gtag = jest.fn();
  (window as GtagWindow).gtag = gtag;
});

afterEach(() => {
  jest.useRealTimers();
  delete (window as GtagWindow).gtag;
});

function eventsNamed(name: string) {
  return gtag.mock.calls.filter((c) => c[0] === "event" && c[1] === name);
}

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

describe("rate_limit_notice_shown", () => {
  it("fires exactly once per occurrence, not once per countdown tick", () => {
    render(<RateLimitNotice info={perMinute()} variant="inline" />);

    expect(eventsNamed("rate_limit_notice_shown")).toHaveLength(1);

    // 10 seconds of countdown re-renders must not add 10 more events.
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(eventsNamed("rate_limit_notice_shown")).toHaveLength(1);
  });

  it("carries kind, tier, variant and a route-group surface", () => {
    render(<RateLimitNotice info={monthly()} variant="page" tier="free" />);

    const [call] = eventsNamed("rate_limit_notice_shown");
    expect(call![2]).toMatchObject({
      kind: "monthly",
      tier: "free",
      variant: "page",
      non_interaction: true,
    });
    expect(typeof (call![2] as Record<string, unknown>).surface).toBe("string");
  });

  it("re-fires when a NEW limit occurrence replaces the old one", () => {
    const { rerender } = render(
      <RateLimitNotice info={perMinute()} variant="inline" />,
    );
    expect(eventsNamed("rate_limit_notice_shown")).toHaveLength(1);

    // Same props object identity changes but the occurrence is identical.
    rerender(<RateLimitNotice info={perMinute()} variant="inline" />);
    expect(eventsNamed("rate_limit_notice_shown")).toHaveLength(1);

    // A fresh 429 with a new reset window IS a new occurrence.
    rerender(
      <RateLimitNotice
        info={perMinute({ resetAt: NOW_SECONDS + 90, retryAfter: 90 })}
        variant="inline"
      />,
    );
    expect(eventsNamed("rate_limit_notice_shown")).toHaveLength(2);
  });

  it("does not throw when GA is absent", () => {
    delete (window as GtagWindow).gtag;
    expect(() =>
      render(<RateLimitNotice info={monthly()} variant="page" tier="free" />),
    ).not.toThrow();
    expect(screen.getByText(/used this month's requests/i)).toBeInTheDocument();
  });
});

describe("CTA conversion events", () => {
  it("fires rate_limit_upgrade_click on the free-tier upgrade CTA", () => {
    render(<RateLimitNotice info={monthly()} variant="page" tier="free" />);

    fireEvent.click(screen.getByRole("link", { name: /upgrade/i }));

    const [call] = eventsNamed("rate_limit_upgrade_click");
    expect(call![2]).toMatchObject({
      kind: "monthly",
      tier: "free",
      variant: "page",
      non_interaction: false,
    });
  });

  it("fires rate_limit_signin_click on the anonymous sign-in CTA", () => {
    render(<RateLimitNotice info={monthly()} variant="page" tier="anonymous" />);

    fireEvent.click(screen.getByRole("link", { name: /sign in/i }));

    const [call] = eventsNamed("rate_limit_signin_click");
    expect(call![2]).toMatchObject({ kind: "monthly", tier: "anonymous" });
    expect(eventsNamed("rate_limit_upgrade_click")).toHaveLength(0);
  });

  it("emits no CTA event for a paid caller (contact support is not a conversion)", () => {
    render(<RateLimitNotice info={monthly()} variant="page" tier="paid" />);

    expect(eventsNamed("rate_limit_notice_shown")).toHaveLength(1);
    expect(eventsNamed("rate_limit_upgrade_click")).toHaveLength(0);
    expect(eventsNamed("rate_limit_signin_click")).toHaveLength(0);
  });
});
