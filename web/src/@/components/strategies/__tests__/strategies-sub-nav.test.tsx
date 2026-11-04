/// <reference types="jest" />

import { render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
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

describe("StrategiesSubNav", () => {
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
    expect(screen.getByRole("navigation", { name: "Strategy workspace" }).className).toContain("sticky top-16");
    unmount();
    mockPathname = "/strategies/canslim";
    render(<StrategiesSubNav />);
    expect(screen.getByRole("navigation", { name: "Strategy workspace" }).className).not.toContain("sticky");
  });

  it("names the bar apart from the in-page strategy switchers", () => {
    mockPathname = "/strategies";
    render(<StrategiesSubNav />);
    expect(screen.getByRole("navigation", { name: "Strategy workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Strategies" })).toBeNull();
  });

  // Effects do not run on the server, so this is the HTML the ISR cache holds.
  describe("server render", () => {
    function serverSignalsHref(): string | null {
      const host = document.createElement("div");
      host.innerHTML = renderToString(<StrategiesSubNav />);
      return host.querySelector('a[href$="/signals"]')?.getAttribute("href") ?? null;
    }

    beforeEach(() => {
      window.localStorage.setItem(LAST_VIEWED_STRATEGY_KEY, "canslim");
    });

    it("links Signals to the strategy the profile route is on, not the stored or default one", () => {
      mockPathname = "/strategies/canslim/signals";
      expect(serverSignalsHref()).toBe("/strategies/canslim/signals");
      mockPathname = "/strategies/zanger-breakout";
      expect(serverSignalsHref()).toBe("/strategies/zanger-breakout/signals");
    });

    it("never reads storage, so a hub page's Signals is the default until mounted", () => {
      mockPathname = "/strategies";
      expect(serverSignalsHref()).toBe("/strategies/crowded-short-breakout/signals");
    });
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
