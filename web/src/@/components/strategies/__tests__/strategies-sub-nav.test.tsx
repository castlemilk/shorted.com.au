/// <reference types="jest" />

import { render, screen, waitFor } from "@testing-library/react";
import { StrategiesSubNav } from "../strategies-sub-nav";
import { LAST_VIEWED_STRATEGY_KEY } from "~/@/lib/strategies/workspace-nav";

let mockPathname = "/strategies";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ prefetch: jest.fn(), push: jest.fn() }),
}));

function signalsHref(): string | null {
  return screen.getByRole("link", { name: "Signals" }).getAttribute("href");
}

describe("StrategiesSubNav (spec 1.4)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("points Signals at the default strategy when nothing has been viewed", async () => {
    mockPathname = "/strategies";
    render(<StrategiesSubNav />);
    await waitFor(() => expect(signalsHref()).toBe("/strategies/crowded-short-breakout/signals"));
    expect(screen.getByRole("link", { name: "Explore" })).toHaveAttribute("aria-current", "page");
  });

  it("points Signals at the strategy stored by an earlier visit", async () => {
    window.localStorage.setItem(LAST_VIEWED_STRATEGY_KEY, "canslim");
    mockPathname = "/strategies";
    render(<StrategiesSubNav />);
    await waitFor(() => expect(signalsHref()).toBe("/strategies/canslim/signals"));
  });

  it("records the strategy being viewed, and points Signals at it", async () => {
    window.localStorage.setItem(LAST_VIEWED_STRATEGY_KEY, "canslim");
    mockPathname = "/strategies/zanger-breakout";
    render(<StrategiesSubNav />);
    await waitFor(() => expect(signalsHref()).toBe("/strategies/zanger-breakout/signals"));
    expect(window.localStorage.getItem(LAST_VIEWED_STRATEGY_KEY)).toBe("zanger-breakout");
  });

  it("keeps the bar sticky on the hub and not on a profile route", () => {
    mockPathname = "/strategies";
    const { unmount } = render(<StrategiesSubNav />);
    expect(screen.getByRole("navigation", { name: "Strategies" }).className).toContain("sticky top-16");
    unmount();
    mockPathname = "/strategies/canslim";
    render(<StrategiesSubNav />);
    expect(screen.getByRole("navigation", { name: "Strategies" }).className).not.toContain("sticky");
  });

  it("still renders the bar when storage throws", async () => {
    const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      mockPathname = "/strategies";
      render(<StrategiesSubNav />);
      await waitFor(() => expect(signalsHref()).toBe("/strategies/crowded-short-breakout/signals"));
    } finally {
      getItem.mockRestore();
    }
  });
});
