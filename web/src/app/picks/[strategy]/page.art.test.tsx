import { render, screen } from "@testing-library/react";

import StrategyPicksPage from "./page";
import { PICKS } from "~/@/components/picks/__tests__/fixtures";

// The strategy page's art: baked brandbrain art for one strategy, the
// generative scene for every other. The faceplate is a bordered band on
// either, with the H1 and the provenance plate above it.
jest.mock("~/@/lib/strategies/art.generated", () => ({
  STRATEGY_ART: { "zanger-breakout": { hash: "deadbeef" } },
}));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useSearchParams: () => new URLSearchParams(""),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({ Breadcrumbs: () => null }));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
  DatasetStructuredData: () => null,
  ItemListStructuredData: () => null,
}));
jest.mock("~/app/actions/config", () => ({ bailOnEmptyRender: jest.fn() }));
jest.mock("~/app/actions/getStrategyPicks", () => ({
  getStrategyPicks: jest.fn(async () => PICKS),
}));

const params = (strategy: string) => Promise.resolve({ strategy });

describe("StrategyPicksPage with baked art", () => {
  it("sets the faceplate on the scene, under the H1 and the provenance plate", async () => {
    render(await StrategyPicksPage({ params: params("zanger-breakout") }));
    const h1 = screen.getByRole("heading", { level: 1 });
    const header = h1.closest("section")!;
    expect(header.className).toContain("overflow-hidden rounded-lg border");
    expect(header.className).not.toContain("border-b border-border/40");
    const band = header.querySelector('[data-strategy-art="band"]')!;
    expect(band).toHaveAttribute("aria-hidden", "true");
    expect((band.querySelector(".banner-art") as HTMLElement).style.getPropertyValue("--banner-dark")).toBe(
      "url('/picks-art/zanger-breakout.dark.avif?v=deadbeef')",
    );
    // The band is the section's first child, so it paints under everything
    // that follows; the copy that follows is positioned above it.
    expect(header.firstElementChild).toBe(band);
    expect(h1.closest(".relative")).not.toBeNull();
    expect(screen.getByText(/ASIC shorts T\+4/).closest("div")!.className).toContain("relative");
  });

  it("sets the faceplate on the generative scene for a strategy without baked art", async () => {
    render(await StrategyPicksPage({ params: params("canslim") }));
    const header = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(header.className).toContain("overflow-hidden rounded-lg border");
    const band = header.querySelector('[data-strategy-art="scene"]')!;
    expect(band.querySelector('[data-strategy-scene="canslim"] svg')).not.toBeNull();
    expect(band.querySelector(".banner-art")).toBeNull();
  });
});
