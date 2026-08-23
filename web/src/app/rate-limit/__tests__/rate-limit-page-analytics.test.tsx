/**
 * `/rate-limit` → `rate_limit_page_view`.
 *
 * This route is deep-linked from an API error body, the edge, or an email, so
 * an arrival here is a funnel entry that no in-app event can stand in for. Two
 * things must hold: it reports the params the link actually carried, and it
 * fires once per link rather than once per render (the notice it wraps
 * re-renders every second while a countdown ticks).
 */
import React from "react";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import { RateLimitPageClient } from "../rate-limit-page-client";

let searchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

const NOW_SECONDS = 1_756_684_800; // 2025-09-01T00:00:00Z

type GtagWindow = { gtag?: (...args: unknown[]) => void };
let gtag: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW_SECONDS * 1000);
  gtag = jest.fn();
  (window as GtagWindow).gtag = gtag;
  searchParams = new URLSearchParams();
});

afterEach(() => {
  jest.useRealTimers();
  delete (window as GtagWindow).gtag;
});

function pageViews() {
  return gtag.mock.calls.filter(
    (c) => c[0] === "event" && c[1] === "rate_limit_page_view",
  );
}

describe("rate_limit_page_view", () => {
  it("reports the kind and tier the deep link carried", () => {
    searchParams = new URLSearchParams(
      "kind=monthly&tier=free&limit=2000&used=2000",
    );
    render(<RateLimitPageClient />);

    expect(pageViews()).toHaveLength(1);
    expect(pageViews()[0]![2]).toMatchObject({
      kind: "monthly",
      tier: "free",
      variant: "page",
      non_interaction: true,
    });
  });

  it("reports unknown rather than guessing on an unparameterised link", () => {
    render(<RateLimitPageClient />);

    expect(pageViews()[0]![2]).toMatchObject({
      kind: "unknown",
      tier: "unknown",
    });
  });

  it("fires once, not once per countdown tick", () => {
    searchParams = new URLSearchParams(
      `kind=per_minute&tier=anonymous&reset=${NOW_SECONDS + 45}`,
    );
    render(<RateLimitPageClient />);

    act(() => {
      jest.advanceTimersByTime(5_000);
    });

    expect(pageViews()).toHaveLength(1);
  });

  it("fires once per mount, and a re-render is not a new arrival", () => {
    searchParams = new URLSearchParams("kind=monthly&tier=free");
    const { rerender } = render(<RateLimitPageClient />);
    rerender(<RateLimitPageClient />);
    rerender(<RateLimitPageClient />);

    expect(pageViews()).toHaveLength(1);
  });

  it("is a no-op when GA is absent, and renders anyway", () => {
    delete (window as GtagWindow).gtag;
    searchParams = new URLSearchParams("kind=monthly");
    expect(() => render(<RateLimitPageClient />)).not.toThrow();
  });

  it("still lets the notice report itself — the two are not duplicates", () => {
    searchParams = new URLSearchParams("kind=monthly&tier=free");
    render(<RateLimitPageClient />);

    expect(pageViews()).toHaveLength(1);
    expect(
      gtag.mock.calls.filter((c) => c[1] === "rate_limit_notice_shown"),
    ).toHaveLength(1);
  });
});
