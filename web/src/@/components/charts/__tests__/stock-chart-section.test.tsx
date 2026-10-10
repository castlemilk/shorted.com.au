import fs from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import {
  CHART_BOX_HEIGHT_CLASS,
  StockChartHeading,
  StockChartPanelSkeleton,
} from "../stock-chart-section";

describe("CHART_BOX_HEIGHT_CLASS", () => {
  it("is 360px on a phone and 420px from sm", () => {
    expect(CHART_BOX_HEIGHT_CLASS).toBe("h-[360px] sm:h-[420px]");
  });
});

describe("StockChartHeading", () => {
  it("is the stock page's chart heading by default", () => {
    render(<StockChartHeading />);
    const h2 = screen.getByRole("heading", { level: 2, name: "Price & short interest" });
    expect(h2).toHaveAttribute("id", "stock-chart-heading");
    expect(h2).toHaveClass("text-lg", "font-semibold", "tracking-tight");
  });

  it("takes its own title and id, for a section the page labels differently", () => {
    render(<StockChartHeading title="Short interest chart" id="short-interest-chart-heading" />);
    const h2 = screen.getByRole("heading", { level: 2, name: "Short interest chart" });
    expect(h2).toHaveAttribute("id", "short-interest-chart-heading");
  });

  it("keeps its hint for sm and up, on the row the heading is on", () => {
    const { container } = render(<StockChartHeading />);
    const hint = screen.getByText("Toggle series, zoom, and compare · ASIC daily, T+4");
    expect(hint.tagName).toBe("SPAN");
    expect(hint).toHaveClass("hidden", "sm:inline");
    expect(container.firstElementChild).toHaveClass("mb-2", "flex", "justify-between");
    expect(container.firstElementChild).toContainElement(hint);
  });
});

describe("StockChartPanelSkeleton", () => {
  const classes = CHART_BOX_HEIGHT_CLASS.split(" ");

  it("is hidden from assistive technology: the route's loading state owns the status", () => {
    const { container } = render(<StockChartPanelSkeleton />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("holds the panel's rows, at the panel's heights and gaps", () => {
    const { container } = render(<StockChartPanelSkeleton />);
    const rows = Array.from(container.firstElementChild!.children);
    expect(rows).toHaveLength(4);
    const [controls, box, period, toggles] = rows as HTMLElement[];

    // The controls: 40px, then the one 32px row from xl. First, so no margin.
    expect(controls).toHaveClass("h-10", "xl:h-8");
    expect(controls).not.toHaveClass("mt-3");
    // The box, a gap below it, in the one constant the panel sizes its box by.
    expect(box).toHaveClass("mt-3", ...classes);
    // Below xl only: the period row and the toggles row, a gap each.
    expect(period).toHaveClass("mt-3", "h-10", "xl:hidden");
    expect(toggles).toHaveClass("mt-3", "h-9", "xl:hidden");
  });

  it("has no heading of its own: the page renders StockChartHeading", () => {
    render(<StockChartPanelSkeleton />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

// A server component renders these, so the file must stay one a server bundle
// can take: no client directive, nothing from Connect, and not the panel (a
// client island) behind a static import.
describe("stock-chart-section.tsx is server-safe", () => {
  const source = fs.readFileSync(path.join(__dirname, "../stock-chart-section.tsx"), "utf8");
  const importSpecifiers = Array.from(
    source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm),
    (m) => m[1],
  );

  it('has no "use client" directive', () => {
    expect(source).not.toMatch(/^\s*["']use client["']/m);
  });

  it("imports nothing from Connect or the client-only chart modules", () => {
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const specifier of importSpecifiers) {
      expect(specifier).not.toMatch(/connectrpc|bufbuild|client-api|use-stock-chart-data|StockChartPanel|StockChart$/);
    }
  });
});
