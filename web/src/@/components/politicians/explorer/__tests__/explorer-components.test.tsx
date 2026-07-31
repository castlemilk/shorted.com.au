import { render, screen, within } from "@testing-library/react";

import { AboutThisData } from "../about-this-data";
import { CompareBars } from "../compare-bars";
import { CompareRadar } from "../compare-radar";
import { CountDonut } from "../count-donut";
import { CountTile } from "../count-tile";
import { KeyFacts } from "../key-facts";
import { SparkTrend } from "../spark-trend";
import { TrendArea } from "../trend-area";

describe("politician explorer shared kit", () => {
  it("renders a labelled count donut with a table fallback and total", () => {
    const { container } = render(
      <CountDonut
        title="Category mix"
        centerLabel="declared entries"
        segments={[
          { label: "Shareholdings", count: 2 },
          { label: "Gift", count: 1 },
        ]}
      />,
    );

    const graphic = screen.getByRole("img");
    expect(graphic).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Category mix"),
    );
    expect(graphic).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Shareholdings"),
    );
    expect(graphic).toHaveAttribute("aria-label", expect.stringContaining("3"));
    expect(container.querySelector("svg")).toHaveAttribute(
      "viewBox",
      "0 0 100 100",
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("declared entries")).toBeInTheDocument();
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
  });

  it("renders a sparkline and degrades flat and empty series to a muted dash", () => {
    const { container, rerender } = render(
      <SparkTrend
        points={[
          { month: "2025-01", count: 1 },
          { month: "2025-02", count: 4 },
        ]}
      />,
    );

    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Monthly count trend"),
    );
    expect(container.querySelector("polyline")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();

    rerender(
      <SparkTrend
        points={[
          { month: "2025-01", count: 4 },
          { month: "2025-02", count: 4 },
        ]}
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute("data-state", "flat");
    expect(
      container.querySelector('line[stroke-dasharray="3 3"]'),
    ).toBeInTheDocument();

    rerender(<SparkTrend points={[]} />);
    expect(screen.getByRole("img")).toHaveAttribute("data-state", "empty");
    expect(
      container.querySelector('line[stroke-dasharray="3 3"]'),
    ).toBeInTheDocument();
  });

  it("renders the trend area with year ticks, integer counts, and the exact undated note", () => {
    const { container } = render(
      <TrendArea
        points={[
          { month: "2024-12", count: 1 },
          { month: "2025-01", count: 4 },
          { month: "2025-02", count: 2 },
        ]}
        undatedCount={1}
      />,
    );

    const graphic = screen.getByRole("img");
    expect(graphic).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Monthly"),
    );
    expect(container.querySelector("path")).toBeInTheDocument();
    expect(screen.getByText("2024")).toBeInTheDocument();
    expect(screen.getByText("2025")).toBeInTheDocument();
    expect(
      screen.getByText("1 entry without a stated date are not plotted."),
    ).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();

    const { rerender } = render(<TrendArea points={[]} undatedCount={2} />);
    rerender(<TrendArea points={[]} undatedCount={2} />);
    expect(
      screen.getByText("2 entries without a stated date are not plotted."),
    ).toBeInTheDocument();
  });

  it("renders symmetric compare bars with both names, counts, and table fallback", () => {
    const { container } = render(
      <CompareBars
        rows={[
          { label: "Shareholdings", countA: 3, countB: 5 },
          { label: "Real estate", countA: 1, countB: 2 },
        ]}
        colorA="#d9544d"
        colorB="#2f6fb0"
        nameA="Member A"
        nameB="Member B"
      />,
    );

    const graphic = screen.getByRole("img");
    expect(graphic).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Member A"),
    );
    expect(graphic).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Member B"),
    );
    expect(container.querySelectorAll("[data-compare-bar]")).toHaveLength(4);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    expect(screen.getAllByText("5").length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/winner|leads|advantage|trophy/i);
  });

  it("renders two labelled sqrt-scaled radar polygons and a table fallback", () => {
    const { container } = render(
      <CompareRadar
        axes={[
          { label: "Shareholdings", countA: 4, countB: 9 },
          { label: "Real estate", countA: 1, countB: 4 },
          { label: "Gift", countA: 2, countB: 3 },
        ]}
        colorA="#d9544d"
        colorB="#2f6fb0"
        nameA="Member A"
        nameB="Member B"
      />,
    );

    const graphic = screen.getByRole("img");
    expect(graphic).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Member A"),
    );
    expect(graphic).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Member B"),
    );
    expect(container.querySelectorAll("polygon[data-series]")).toHaveLength(2);
    expect(
      container.querySelector('[data-axis-label="Shareholdings"]'),
    ).toHaveTextContent("Shareholdings");
    expect(
      container.querySelector('[data-axis-label="Real estate"]'),
    ).toHaveTextContent("Real estate");
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders a count tile with a signed muted delta", () => {
    const { container } = render(
      <CountTile
        count={12}
        label="declared entries"
        delta={{ count: -2, periodLabel: "vs 12 months ago" }}
      />,
    );

    expect(screen.getByText("12")).toHaveClass("tabular-nums");
    expect(screen.getByText("declared entries")).toBeInTheDocument();
    const delta = screen.getByText("−2");
    expect(delta).toHaveClass("text-muted-foreground");
    expect(screen.getByText("vs 12 months ago")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$\s*\d/);
    expect(container.innerHTML).not.toMatch(/text-(?:red|green)/i);
  });

  it("renders key facts as neutral sentences with optional links", () => {
    render(
      <KeyFacts
        facts={[
          {
            text: "12 of 18 listed declarations are dated.",
            href: "/politicians/member-a",
          },
          { text: "The register identifies three holder categories." },
        ]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Key facts" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /12 of 18/ })).toHaveAttribute(
      "href",
      "/politicians/member-a",
    );
    expect(screen.getByText(/three holder categories/)).toBeInTheDocument();
    expect(screen.queryByText(/high|medium|low/i)).toBeNull();
  });

  it("composes source, licence, as-at, methodology, report, and caveat copy", () => {
    const { container } = render(
      <AboutThisData
        sourceLabel="Parliament of Australia register"
        sourceUrl="https://www.aph.gov.au/register"
        licence="Extracted facts with attribution"
        asAt="31 July 2026"
        methodologyHref="/methodology/politicians"
        reportErrorHref="mailto:corrections@example.com"
      />,
    );

    expect(
      screen.getByText("Parliament of Australia register"),
    ).toHaveAttribute("href", "https://www.aph.gov.au/register");
    expect(
      screen.getByText("Extracted facts with attribution"),
    ).toBeInTheDocument();
    expect(screen.getByText("31 July 2026")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Methodology" })).toHaveAttribute(
      "href",
      "/methodology/politicians",
    );
    expect(
      screen.getAllByRole("link", { name: /Report an error/ }).length,
    ).toBeGreaterThan(0);
    const customReportLink = screen
      .getAllByRole("link", { name: /Report an error/ })
      .find(
        (link) =>
          link.getAttribute("href") === "mailto:corrections@example.com",
      );
    expect(customReportLink).toBeDefined();
    expect(container.textContent).toMatch(/Method & caveats/);
  });

  it("keeps default rendered states free of currency and warning glyphs", () => {
    const { container } = render(
      <>
        <CountDonut title="Mix" centerLabel="entries" segments={[]} />
        <SparkTrend points={[]} />
        <TrendArea points={[]} />
        <CompareBars
          rows={[]}
          colorA="#d9544d"
          colorB="#2f6fb0"
          nameA="A"
          nameB="B"
        />
        <CompareRadar
          axes={[]}
          colorA="#d9544d"
          colorB="#2f6fb0"
          nameA="A"
          nameB="B"
        />
        <CountTile count={0} label="entries" />
        <KeyFacts facts={[]} />
      </>,
    );

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(/[⚠🚨🔴🚩👀💰💵🪙💲🏆]/u);
  });

  it("keeps the hidden fallback tables labelled", () => {
    const { container } = render(
      <>
        <CountDonut
          title="Mix"
          centerLabel="entries"
          segments={[{ label: "Gift", count: 1 }]}
        />
        <SparkTrend points={[{ month: "2025-01", count: 1 }]} />
        <TrendArea points={[{ month: "2025-01", count: 1 }]} />
        <CompareBars
          rows={[{ label: "Gift", countA: 1, countB: 2 }]}
          colorA="#d9544d"
          colorB="#2f6fb0"
          nameA="A"
          nameB="B"
        />
        <CompareRadar
          axes={[{ label: "Gift", countA: 1, countB: 2 }]}
          colorA="#d9544d"
          colorB="#2f6fb0"
          nameA="A"
          nameB="B"
        />
      </>,
    );

    const tables = screen.getAllByRole("table");
    expect(tables.length).toBe(5);
    for (const table of tables) {
      expect(within(table).getAllByRole("row").length).toBeGreaterThan(0);
    }
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(5);
  });
});
