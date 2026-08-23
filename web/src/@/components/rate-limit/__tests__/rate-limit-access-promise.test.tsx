/**
 * The upgrade CTA must promise only what the tier actually delivers.
 *
 * Paid BROWSER access is genuinely unlimited on both windows. Paid API access
 * is a real 120/min and 10,000/month ceiling. Until 2026-08-23 the notice told
 * every free caller to "Upgrade for unlimited requests" regardless of surface,
 * so an API caller who followed that CTA would pay and then still be limited —
 * the upgrade did not buy what the button said it would.
 *
 * `/rate-limit` is where this bites hardest: it is deep-linked FROM the API
 * error body, so it is routinely rendered for API callers, not browsers.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SessionProvider } from "next-auth/react";

import { RateLimitNotice } from "../rate-limit-notice";
import type { RateLimitInfo } from "~/@/lib/retry";

jest.mock("~/@/lib/rate-limit-analytics", () => ({
  RATE_LIMIT_EVENTS: {
    NOTICE_SHOWN: "notice_shown",
    UPGRADE_CLICK: "upgrade_click",
    SIGN_IN_CLICK: "sign_in_click",
    RETRY_CLICK: "retry_click",
    PAGE_VIEW: "page_view",
  },
  currentSurface: () => "test",
  trackRateLimitEvent: jest.fn(),
}));

function monthly(access?: "api" | "browser"): RateLimitInfo {
  return {
    isRateLimited: true,
    kind: "monthly",
    monthlyLimit: 1000,
    monthlyUsed: 1000,
    monthlyResetAt: Math.floor(Date.now() / 1000) + 86_400,
    access,
  };
}

function renderNotice(info: RateLimitInfo) {
  return render(
    <SessionProvider session={null}>
      <RateLimitNotice info={info} variant="page" tier="free" />
    </SessionProvider>,
  );
}

describe("upgrade promise matches the limited surface", () => {
  it("does NOT promise unlimited requests to an API caller", () => {
    renderNotice(monthly("api"));
    expect(screen.getByText(/upgrade for higher limits/i)).toBeInTheDocument();
    expect(screen.queryByText(/unlimited requests/i)).not.toBeInTheDocument();
  });

  it("quotes the real paid API numbers as the benefit", () => {
    renderNotice(monthly("api"));
    // The concrete uplift (1,000 -> 10,000) is the honest sell.
    expect(screen.getByText(/10,000 API requests a month/i)).toBeInTheDocument();
    expect(screen.getByText(/120 requests a minute/i)).toBeInTheDocument();
  });

  it("still promises unlimited to a browser caller, where it is true", () => {
    renderNotice(monthly("browser"));
    expect(
      screen.getByText(/upgrade for unlimited requests/i),
    ).toBeInTheDocument();
  });

  it("falls back to the browser wording when the surface is unknown", () => {
    // This notice overwhelmingly renders inside the web app, so the browser
    // list is the accurate default. The fallback must not be the API one.
    renderNotice(monthly(undefined));
    expect(
      screen.getByText(/upgrade for unlimited requests/i),
    ).toBeInTheDocument();
  });

  it("never upsells a paid caller regardless of surface", () => {
    for (const access of ["api", "browser"] as const) {
      const { unmount } = render(
        <SessionProvider session={null}>
          <RateLimitNotice info={monthly(access)} variant="page" tier="paid" />
        </SessionProvider>,
      );
      expect(screen.getByText(/contact support/i)).toBeInTheDocument();
      expect(screen.queryByText(/upgrade/i)).not.toBeInTheDocument();
      unmount();
    }
  });
});
