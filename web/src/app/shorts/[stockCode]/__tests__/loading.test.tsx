/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { criticalCSS } from "~/styles/critical-css";
import StockOverviewLoading from "../loading";

/**
 * The Overview's skeleton follows the page block for block (page.tsx), so what
 * loads in lands where its placeholder was. That a loading.tsx is a labelled,
 * busy status region is held for every tab by loading-boundaries.test.tsx; this
 * file holds what only the Overview's skeleton promises: the sizes and the
 * sign-in slot that stop the grid from moving when the page arrives.
 */
describe("the Overview's loading skeleton", () => {
  // The skeleton's own blocks, in document order: the chart section, the About
  // placeholder, the sign-in slot and the grid.
  const blocks = () => {
    render(<StockOverviewLoading />);
    return Array.from(screen.getByRole("status").children) as HTMLElement[];
  };

  it("follows the page: the chart section, the About card, the sign-in slot, then the grid", () => {
    const [chart, about, slot, grid, ...rest] = blocks();
    expect(rest).toHaveLength(0);
    // The chart section: the heading's row, then the panel's own skeleton.
    expect(chart).toHaveClass("mb-4", "min-w-0");
    expect(chart?.children).toHaveLength(2);
    expect(about).toHaveClass("animate-pulse", "rounded-lg");
    expect(slot).toHaveClass("login-slot");
    expect(grid).toHaveClass("grid", "lg:grid-cols-[minmax(0,1fr)_310px]");
  });

  it("holds the About card's place at its measured height: 500px on a phone, 360px from sm", () => {
    const about = blocks()[1]!;
    expect(about).toHaveClass("mb-4", "rounded-lg", "h-[500px]", "sm:h-[360px]");
    // The placeholder the card replaced (112px) was a fifth of its height on a
    // phone, which the grid then paid for by moving.
    expect(about).not.toHaveClass("h-28");
  });

  it("leaves the page's own empty sign-in slot after the card, with no height of its own", () => {
    const slot = blocks()[2]!;
    // The page's slot is `<div className="login-slot">` and nothing else on it:
    // the height it holds comes from critical CSS under html.anon, so a signed-in
    // visitor, who never gets that class, sees no gap.
    expect(slot.className).toBe("login-slot");
    expect(slot).toBeEmptyDOMElement();
  });

  it("uses the slot class critical CSS reserves: 46px and a margin under html.anon, nothing without it", () => {
    expect(criticalCSS).toMatch(/(^|\n)\.login-slot \{ min-height: 0; \}/);
    expect(criticalCSS).toMatch(
      /(^|\n)html\.anon \.login-slot \{ min-height: 46px; margin-bottom: 1rem; \}/,
    );
  });
});
