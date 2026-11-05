import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

import StrategyLayout, { dynamicParams, generateStaticParams } from "./layout";
import { STRATEGY_SLUGS, getStrategy } from "~/@/lib/strategies/registry";
import { STRATEGY_CAPABILITIES } from "~/@/lib/strategies/capabilities";

// The strategy profile's chrome: breadcrumbs, faceplate, tab bar, then the tab.
// The faceplate's art (baked for one strategy, the generative scene for the
// rest) moved here from the Overview page with the faceplate.

jest.mock("~/@/lib/strategies/art.generated", () => ({
  STRATEGY_ART: { "zanger-breakout": { hash: "deadbeef" } },
}));
jest.mock("~/@/components/picks/strategy-scene-lazy", () => ({
  StrategySceneLazy: () => null,
}));

const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const prefetch = jest.fn();
let pathname = "/strategies/canslim";

jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
  usePathname: () => pathname,
  useRouter: () => ({ prefetch }),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: ({
    items,
  }: {
    items: Array<{ label: string; href: string }>;
  }) => (
    <nav aria-label="Breadcrumb">
      {items.map((item) => (
        <a key={item.href} href={item.href}>
          {item.label}
        </a>
      ))}
    </nav>
  ),
}));

const params = (strategy: string) => Promise.resolve({ strategy });

async function renderLayout(slug: string, child = "The tab") {
  return render(
    await StrategyLayout({
      children: <div>{child}</div>,
      params: params(slug),
    }),
  );
}

describe("StrategyLayout", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pathname = "/strategies/canslim";
  });

  it("prerenders every registry strategy and answers any other slug with a 404", () => {
    expect(generateStaticParams()).toEqual(
      STRATEGY_SLUGS.map((strategy) => ({ strategy })),
    );
    expect(STRATEGY_SLUGS).toHaveLength(5);
    expect(generateStaticParams()).toContainEqual({
      strategy: "quality-compounders",
    });
    expect(dynamicParams).toBe(false);
  });

  it("404s a slug the registry does not hold, without rendering a child", async () => {
    await expect(
      StrategyLayout({
        children: <div>x</div>,
        params: params("not-a-strategy"),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the breadcrumbs, the faceplate and the tab before its child", async () => {
    const seo = getStrategy("canslim")!;
    const { container } = await renderLayout("canslim");

    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(trail).getByRole("link", { name: "Strategies" }),
    ).toHaveAttribute("href", "/strategies");
    expect(within(trail).getByRole("link", { name: seo.h1 })).toHaveAttribute(
      "href",
      "/strategies/canslim",
    );

    expect(
      screen.getByRole("heading", { level: 1, name: seo.h1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(seo.dek)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Stock picker" })).toHaveAttribute(
      "href",
      "/strategies",
    );

    const tabBar = screen.getByRole("navigation", {
      name: "Strategy sections",
    });
    const child = screen.getByText("The tab");
    expect(
      tabBar.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("lists the Overview, Rules and Signals tabs, the ones whose pages ship", async () => {
    await renderLayout("canslim");
    const bar = screen.getByRole("navigation", { name: "Strategy sections" });
    const links = within(bar).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Overview", "Rules", "Signals"]);
    expect(links[0]).toHaveAttribute("href", "/strategies/canslim");
    expect(links[0]).toHaveAttribute("aria-current", "page");
  });

  it("renders no Compare, Create alert or Alert-me control", async () => {
    await renderLayout("canslim");
    for (const name of [/compare/i, /create alert/i, /alert me/i]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    }
    // Saves ships with My strategies and is on; every other capability stays dark.
    expect(
      Object.entries(STRATEGY_CAPABILITIES)
        .filter(([name]) => name !== "saves")
        .every(([, on]) => on === false),
    ).toBe(true);
  });

  it("never prefetches the tab the page is already on", async () => {
    await renderLayout("canslim");
    const bar = screen.getByRole("navigation", { name: "Strategy sections" });
    const overview = within(bar).getByRole("link", { name: "Overview" });
    fireEvent.pointerEnter(overview);
    fireEvent.touchStart(overview);
    fireEvent.focus(overview);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("draws the baked art under the faceplate when a strategy has baked art", async () => {
    await renderLayout("zanger-breakout");
    const header = screen
      .getByRole("heading", { level: 1 })
      .closest("section")!;
    expect(header.className).toContain("overflow-hidden rounded-lg border");
    expect(header).toHaveAttribute("data-scene-stage");
    const band = header.querySelector('[data-strategy-art="band"]')!;
    expect(band).toHaveAttribute("aria-hidden", "true");
    expect(
      (band.querySelector(".banner-art") as HTMLElement).style.getPropertyValue(
        "--banner-dark",
      ),
    ).toBe("url('/picks-art/zanger-breakout.dark.avif?v=deadbeef')");
    expect(header.firstElementChild).toBe(band);
  });

  it("draws the generative scene for a strategy without baked art", async () => {
    await renderLayout("canslim");
    const header = screen
      .getByRole("heading", { level: 1 })
      .closest("section")!;
    expect(header.className).toContain("overflow-hidden rounded-lg border");
    const band = header.querySelector('[data-strategy-art="scene"]')!;
    expect(
      band.querySelector('[data-strategy-scene="canslim"] svg'),
    ).not.toBeNull();
    expect(band.querySelector(".banner-art")).toBeNull();
  });
});
