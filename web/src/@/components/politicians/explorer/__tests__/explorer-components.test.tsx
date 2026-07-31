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

  it("groups the donut tail instead of reusing a colour, and keys every arc", () => {
    // The ramp has six steps and the seventh segment used to wrap back to the
    // first one's amber — two categories, one colour, nothing on screen to tell
    // them apart.
    const segments = Array.from({ length: 9 }, (_, index) => ({
      label: `Category ${index + 1}`,
      count: index + 1,
    }));
    const { container } = render(
      <CountDonut
        title="Category mix"
        centerLabel="declared entries"
        segments={segments}
      />,
    );

    const arcs = Array.from(
      container.querySelectorAll("g circle[stroke-dasharray]"),
    );
    const strokes = arcs.map((arc) => arc.getAttribute("stroke"));
    expect(strokes).toHaveLength(6);
    expect(new Set(strokes).size).toBe(strokes.length);

    // The grouped arc says how many categories it stands for.
    const legend = screen.getByRole("list");
    expect(within(legend).getByText("Other (4)")).toBeInTheDocument();
    // 6 + 7 + 8 + 9
    expect(within(legend).getByText("30")).toBeInTheDocument();

    // Every original category still reaches a screen reader, and the total is
    // the sum of all nine, not of the six drawn.
    const table = screen.getByRole("table");
    expect(within(table).getByText("Category 9")).toBeInTheDocument();
    expect(within(table).getByText("45")).toBeInTheDocument();
  });

  it("fits the donut centre text inside the hole for realistic totals", () => {
    const { container } = render(
      <CountDonut
        title="Category mix"
        centerLabel="declared entries"
        segments={[{ label: "Shareholdings", count: 17240 }]}
      />,
    );

    const texts = Array.from(container.querySelectorAll("svg > text"));
    expect(texts).toHaveLength(2);
    const [total, label] = texts;
    expect(total).toHaveTextContent("17240");

    // The hole is 48 user units across; `text-xl` was 20 of them, so five
    // digits ran out over the ring. Both lines are sized to fit it.
    const HOLE = 48;
    const width = (element: Element | undefined, per: number) =>
      Number(element?.getAttribute("font-size")) *
      (element?.textContent?.length ?? 0) *
      per;
    expect(Number(total?.getAttribute("font-size"))).toBeLessThan(20);
    expect(width(total, 0.6)).toBeLessThanOrEqual(HOLE);
    expect(width(label, 0.55)).toBeLessThanOrEqual(HOLE);
    expect(screen.getByText("declared entries")).toBeInTheDocument();
  });

  it("truncates a centre label that cannot be shrunk to fit, keeping the full text", () => {
    const long = "declared entries across every register category";
    const { container } = render(
      <CountDonut title="Category mix" centerLabel={long} segments={[]} />,
    );

    const label = container.querySelectorAll("svg > text")[1];
    // The drawn glyphs are the last child; the <title> before it is a tooltip,
    // not rendered text.
    const drawn = label?.lastChild?.textContent ?? "";
    expect(drawn).toContain("…");
    expect(drawn.length).toBeLessThan(long.length);
    // Nothing is lost: the full label is in the tooltip and in the aria-label.
    expect(label?.querySelector("title")).toHaveTextContent(long);
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      expect.stringContaining(long),
    );
  });

  it("renders a sparkline and reserves the muted dash for having nothing to plot", () => {
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

    // A FLAT SERIES IS DATA. It used to render the same dash as an empty one,
    // so "steady at 12 a month" and "no dated history" were byte-identical in
    // the hub table. It draws a real flat line now, and says the level out loud.
    rerender(
      <SparkTrend
        points={[
          { month: "2025-01", count: 12 },
          { month: "2025-02", count: 12 },
        ]}
      />,
    );
    const flat = screen.getByRole("img");
    expect(flat).toHaveAttribute("data-state", "flat");
    expect(flat).toHaveAttribute(
      "aria-label",
      expect.stringContaining("steady at 12"),
    );
    const flatLine = container.querySelector("polyline");
    expect(flatLine).toBeInTheDocument();
    expect(container.querySelector('line[stroke-dasharray="3 3"]')).toBeNull();
    // Flat means one level: both vertices share a y.
    const ys = (flatLine?.getAttribute("points") ?? "")
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(",")[1]);
    expect(ys.length).toBe(2);
    expect(ys[0]).toBe(ys[1]);

    rerender(<SparkTrend points={[]} />);
    expect(screen.getByRole("img")).toHaveAttribute("data-state", "empty");
    expect(
      container.querySelector('line[stroke-dasharray="3 3"]'),
    ).toBeInTheDocument();
  });

  it("distinguishes no dated history from nothing declared", () => {
    const { container, rerender } = render(<SparkTrend points={[]} />);
    const emptyLabel = screen.getByRole("img").getAttribute("aria-label");

    rerender(<SparkTrend points={[]} undatedOnly />);
    const undated = screen.getByRole("img");
    expect(undated).toHaveAttribute("data-state", "undated");
    expect(undated.getAttribute("aria-label")).not.toBe(emptyLabel);
    expect(undated).toHaveAttribute(
      "aria-label",
      expect.stringContaining("no dated history"),
    );
    // Still the honest dash — there is genuinely nothing to plot.
    expect(
      container.querySelector('line[stroke-dasharray="3 3"]'),
    ).toBeInTheDocument();
    expect(screen.getByText("No dated history")).toBeInTheDocument();
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
      screen.getByText("1 entry without a stated date is not plotted."),
    ).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();

    const { rerender } = render(<TrendArea points={[]} undatedCount={2} />);
    rerender(<TrendArea points={[]} undatedCount={2} />);
    expect(
      screen.getByText("2 entries without a stated date are not plotted."),
    ).toBeInTheDocument();
  });

  it("draws a visible mark for a single dated month", () => {
    // A one-point series makes a zero-width area and a one-vertex polyline —
    // both draw nothing — while the empty-state dash stayed suppressed because
    // the series was not empty. The result was a blank plot for a real member.
    const { container } = render(
      <TrendArea points={[{ month: "2025-03", count: 7 }]} />,
    );

    const dot = container.querySelector("[data-single-point]");
    expect(dot).toBeInTheDocument();
    expect(container.querySelector("[data-single-point-level]")).toBeInTheDocument();
    // Not the empty-state dash: this series HAS data.
    expect(container.querySelector('line[stroke-dasharray="3 3"]')).toBeNull();
    // And the value is legible on the plot, not only in the table.
    expect(screen.getAllByText("7").length).toBeGreaterThan(0);

    const svg = container.querySelector("svg");
    const [, , , viewBoxHeight] = (svg?.getAttribute("viewBox") ?? "")
      .split(/\s+/)
      .map(Number);
    const cy = Number(dot?.getAttribute("cy"));
    expect(cy).toBeGreaterThanOrEqual(0);
    expect(cy).toBeLessThanOrEqual(viewBoxHeight ?? 0);
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

  it("keeps every axis label inside the viewBox at any axis count", () => {
    // With an EVEN axis count one vertex lands due south, and its label used to
    // be drawn below the bottom of the viewBox — clipped away entirely for 4
    // and 6 grouped categories, which is what the compare page will pass.
    for (const axisCount of [3, 4, 5, 6, 7, 8]) {
      const axes = Array.from({ length: axisCount }, (_, index) => ({
        label: `Category ${index + 1}`,
        countA: index + 1,
        countB: axisCount - index,
      }));
      const { container, unmount } = render(
        <CompareRadar
          axes={axes}
          colorA="#d9544d"
          colorB="#2f6fb0"
          nameA="Member A"
          nameB="Member B"
        />,
      );

      const svg = container.querySelector("svg");
      const [, , width, height] = (svg?.getAttribute("viewBox") ?? "")
        .split(/\s+/)
        .map(Number);
      const labels = Array.from(
        container.querySelectorAll("[data-axis-label]"),
      );
      expect(labels).toHaveLength(axisCount);
      for (const label of labels) {
        const x = Number(label.getAttribute("x"));
        const y = Number(label.getAttribute("y"));
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(width ?? 0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(height ?? 0);
      }
      unmount();
    }
  });

  it("falls back to paired bars when a radar would be a line", () => {
    // One axis is a point and two axes are a zero-area segment: both polygons
    // render as nothing, while the empty-state fallback only fired at zero
    // axes. The bars carry the same numbers and the same colours.
    for (const axes of [
      [{ label: "Shareholdings", countA: 3, countB: 1 }],
      [
        { label: "Shareholdings", countA: 3, countB: 1 },
        { label: "Real estate", countA: 2, countB: 4 },
      ],
    ]) {
      const { container, unmount } = render(
        <CompareRadar
          axes={axes}
          colorA="#d9544d"
          colorB="#2f6fb0"
          nameA="Member A"
          nameB="Member B"
        />,
      );

      expect(container.querySelector("polygon[data-series]")).toBeNull();
      expect(container.querySelectorAll("[data-compare-bar]")).toHaveLength(
        axes.length * 2,
      );
      expect(screen.getByRole("img")).toHaveAttribute(
        "aria-label",
        expect.stringContaining("Shareholdings"),
      );
      expect(screen.getByRole("table")).toBeInTheDocument();
      unmount();
    }
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

  it("renders one source, licence, as-at, methodology and report-an-error band", () => {
    const { container } = render(
      <AboutThisData
        sourceLabel="Registers of Members’ and Senators’ Interests (aph.gov.au)"
        sourceHref="https://www.aph.gov.au/Senators_and_Members/Members/Register"
        licence="Extracted facts, attributed to the Parliament of Australia"
        asAt="2026-07-31"
        updateCadence="Checked weekly"
        methodologyHref="/methodology/politicians"
        reportErrorHref="mailto:corrections@example.com"
      />,
    );

    // The link is labelled as what it points at. It used to be handed to
    // SourceLine as `pdfUrl`, which renders the fixed label "Original PDF" —
    // over a register LANDING PAGE.
    expect(
      screen.getByText("Registers of Members’ and Senators’ Interests (aph.gov.au)"),
    ).toHaveAttribute(
      "href",
      "https://www.aph.gov.au/Senators_and_Members/Members/Register",
    );
    expect(
      screen.getByText("Extracted facts, attributed to the Parliament of Australia"),
    ).toBeInTheDocument();

    // A VALID machine value. "31 July 2026" is not one, and was previously
    // used as both the dateTime attribute and the displayed string.
    const time = container.querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2026-07-31");
    expect(time).toHaveTextContent("31 July 2026");
    expect(screen.getByText("Checked weekly")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Methodology" })).toHaveAttribute(
      "href",
      "/methodology/politicians",
    );

    // ONE dispute link, not two: the band used to render its own and then
    // compose SourceLine, which renders another with a different href.
    const reportLinks = screen.getAllByRole("link", {
      name: /Report an error/,
    });
    expect(reportLinks).toHaveLength(1);
    expect(reportLinks[0]).toHaveAttribute(
      "href",
      "mailto:corrections@example.com",
    );
  });

  it("names the registers by default and survives an unparseable as-at", () => {
    const { container } = render(
      <AboutThisData
        licence="Extracted facts, attributed to the Parliament of Australia"
        asAt="not a date"
        reportErrorHref="mailto:corrections@example.com"
      />,
    );

    expect(container.textContent).toMatch(/Registers of Members/);
    // No `<time>` at all rather than an invalid dateTime, and the string we
    // were handed is shown rather than a date we invented.
    expect(container.querySelector("time")).toBeNull();
    expect(screen.getByText("not a date")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Methodology" })).toBeNull();
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
