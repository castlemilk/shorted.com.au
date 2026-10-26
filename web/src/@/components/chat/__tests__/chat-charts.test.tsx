import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChatLineChart, ChatSparkline } from "../chat-charts";
import { formatPercent } from "../chat-tool-format";
import type { Reading } from "../chat-tool-data";

// jsdom has no PointerEvent. A MouseEvent carries the coordinates, and the pointer type
// rides along, which is all the charts read from a pointer event.
class PointerEventShim extends MouseEvent {
  readonly pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
  }
}
if (typeof window.PointerEvent === "undefined") {
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: PointerEventShim });
}

/** Five readings on the first of successive weeks, so the day of each is clear. */
const readings: Reading[] = [
  { t: Date.parse("2026-10-01T00:00:00Z"), v: 5 },
  { t: Date.parse("2026-10-08T00:00:00Z"), v: 2 },
  { t: Date.parse("2026-10-15T00:00:00Z"), v: 9 },
  { t: Date.parse("2026-10-22T00:00:00Z"), v: 4 },
  { t: Date.parse("2026-10-29T00:00:00Z"), v: 7 },
];

/** The text a screen reader is told about the reading on screen. */
function announced(): string {
  const region = document.querySelector('[aria-live="polite"]');
  return region?.textContent ?? "";
}

describe("ChatLineChart keyboard reading", () => {
  function renderChart() {
    render(
      <>
        <p id="caption">Short interest, the first and latest readings.</p>
        <ChatLineChart
          label="DRO short interest"
          points={readings}
          color="#D16A47"
          kind="area"
          formatValue={formatPercent}
          describedBy="caption"
        />
      </>,
    );
    return screen.getByRole("group", { name: /DRO short interest/ });
  }

  it("is a labelled, focusable group described by its caption", () => {
    const chart = renderChart();

    expect(chart).toHaveAttribute("tabindex", "0");
    expect(chart).toHaveAttribute("aria-roledescription", "interactive chart");
    expect(chart).toHaveAttribute("aria-describedby", "caption");
    expect(chart).toHaveAccessibleName(/Use the left and right arrow keys/);
  });

  it("reads the latest reading when focus arrives, then steps back and forward", () => {
    const chart = renderChart();

    act(() => chart.focus());
    expect(announced()).toBe("29 Oct 2026: 7.00%");

    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(announced()).toBe("22 Oct 2026: 4.00%");

    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(announced()).toBe("8 Oct 2026: 2.00%");

    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(announced()).toBe("15 Oct 2026: 9.00%");
  });

  it("stops at the ends, and Home and End jump to them", () => {
    const chart = renderChart();
    act(() => chart.focus());

    fireEvent.keyDown(chart, { key: "Home" });
    expect(announced()).toBe("1 Oct 2026: 5.00%");

    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(announced()).toBe("1 Oct 2026: 5.00%");

    fireEvent.keyDown(chart, { key: "End" });
    expect(announced()).toBe("29 Oct 2026: 7.00%");

    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(announced()).toBe("29 Oct 2026: 7.00%");
  });

  it("clears the reading on Escape and on blur", () => {
    const chart = renderChart();
    act(() => chart.focus());
    expect(announced()).not.toBe("");

    fireEvent.keyDown(chart, { key: "Escape" });
    expect(announced()).toBe("");

    act(() => chart.focus());
    act(() => chart.blur());
    expect(announced()).toBe("");
  });

  it("leaves a modified key to the browser", () => {
    const chart = renderChart();
    act(() => chart.focus());

    const cancelled = !fireEvent.keyDown(chart, { key: "ArrowLeft", altKey: true });
    expect(cancelled).toBe(false);
    expect(announced()).toBe("29 Oct 2026: 7.00%");
  });

  it("draws the readout's tooltip with the day and the value", () => {
    const chart = renderChart();
    act(() => chart.focus());
    fireEvent.keyDown(chart, { key: "ArrowLeft" });

    // The tooltip repeats the reading the live region announces, visually.
    expect(document.body).toHaveTextContent("22 Oct 2026");
    expect(document.body).toHaveTextContent("4.00%");
  });

  it("does not draw a chart from fewer than two readings", () => {
    const { container } = render(
      <ChatLineChart
        label="One reading"
        points={[readings[0]!]}
        color="#D16A47"
        formatValue={formatPercent}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ChatSparkline", () => {
  it("is a named group that steps through its readings from the keyboard", () => {
    render(
      <ChatSparkline
        label="DRO short interest, last three months"
        points={readings}
        color="#D16A47"
      />,
    );

    const spark = screen.getByRole("group", {
      name: /DRO short interest, last three months\. 5 readings/,
    });
    act(() => spark.focus());
    expect(announced()).toBe("29 Oct 2026, 7.00%");

    fireEvent.keyDown(spark, { key: "ArrowLeft" });
    expect(announced()).toBe("22 Oct 2026, 4.00%");

    fireEvent.keyDown(spark, { key: "Escape" });
    expect(announced()).toBe("");
  });

  it("is hidden from a screen reader, which hears the group and the readout", () => {
    const { container } = render(
      <ChatSparkline label="Spark" points={readings} color="#D16A47" />,
    );
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws nothing for a single reading", () => {
    const { container } = render(
      <ChatSparkline label="Spark" points={[readings[0]!]} color="#D16A47" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ChatSparkline tooltip in a table cell", () => {
  it("names the series by its short label, so the tooltip stays narrow", () => {
    const { container } = render(
      <ChatSparkline
        label="DRO short interest, last three months"
        seriesLabel="DRO"
        points={readings}
        color="#D16A47"
      />,
    );
    act(() => screen.getByRole("group").focus());

    const tip = screen.getByTestId("chat-spark-tooltip");
    expect(tip).toHaveTextContent("DRO");
    expect(tip).toHaveTextContent("7.00%");
    expect(tip.textContent).not.toMatch(/last three months/);
  });

  it("is drawn in a portal on the page, not inside the table cell that clips it", () => {
    const { container } = render(
      <ChatSparkline label="Spark" points={readings} color="#D16A47" />,
    );
    act(() => screen.getByRole("group").focus());

    const tip = screen.getByTestId("chat-spark-tooltip");
    expect(container.contains(tip)).toBe(false);
    expect(tip.parentElement).toBe(document.body);
    expect(tip.className).toContain("fixed");
    expect(tip.className).toContain("pointer-events-none");
  });

  it("marks the group while it shows a reading, for the sidebar's Escape handling", () => {
    render(<ChatSparkline label="Spark" points={readings} color="#D16A47" />);
    const spark = screen.getByRole("group");
    expect(spark).not.toHaveAttribute("data-reading-active");

    act(() => spark.focus());
    expect(spark).toHaveAttribute("data-reading-active", "true");

    fireEvent.keyDown(spark, { key: "Escape" });
    expect(spark).not.toHaveAttribute("data-reading-active");
  });
});

/**
 * jsdom has no layout, so the geometry the tooltip is placed by is given. The sparkline's
 * svg reports `anchor`, and the tooltip reports its own size, which is the same for every
 * reading here.
 */
function givenGeometry(anchor: { left: number; top: number; right: number; bottom: number }) {
  const real = Element.prototype.getBoundingClientRect;
  jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this instanceof SVGSVGElement) {
      return { ...anchor, x: anchor.left, y: anchor.top, width: anchor.right - anchor.left, height: anchor.bottom - anchor.top, toJSON: () => ({}) } as DOMRect;
    }
    return real.call(this);
  });
  const sizes = { width: 200, height: 40 };
  jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => sizes.width);
  jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => sizes.height);
}

describe("ChatSparkline tooltip placement", () => {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
  });

  it("opens below a reading in the first row, which sits under the sticky header", () => {
    // 20px from the top: there is no room above it for a 40px tooltip, so it opens below.
    givenGeometry({ left: 200, top: 20, right: 296, bottom: 48 });
    render(<ChatSparkline label="Spark" points={readings} color="#D16A47" />);
    act(() => screen.getByRole("group").focus());

    const tip = screen.getByTestId("chat-spark-tooltip");
    expect(tip.style.top).toBe("54px");
  });

  it("keeps the tooltip inside the window for a reading in the last column", () => {
    // The tooltip's trailing edge meets the reading's, so at 318px it would run off the
    // right edge by 190px. It is held 8px inside the window instead.
    givenGeometry({ left: 222, top: 300, right: 318, bottom: 328 });
    render(<ChatSparkline label="Spark" points={readings} color="#D16A47" />);
    act(() => screen.getByRole("group").focus());

    const tip = screen.getByTestId("chat-spark-tooltip");
    expect(tip.style.left).toBe("112px");
    expect(parseFloat(tip.style.left) + 200).toBeLessThanOrEqual(320 - 8);
  });

  it("opens above a reading with room above it, and clamps a trailing edge that would run off the left", () => {
    // A 200px tooltip on its reading's trailing edge (156px) would start at -44px. It is
    // held to the 8px margin instead, and it still sits above the reading.
    givenGeometry({ left: 60, top: 300, right: 156, bottom: 328 });
    render(<ChatSparkline label="Spark" points={readings} color="#D16A47" />);
    act(() => screen.getByRole("group").focus());

    const tip = screen.getByTestId("chat-spark-tooltip");
    expect(tip.style.top).toBe("254px");
    expect(tip.style.left).toBe("8px");
  });

  it("is hidden until it has been placed, so it never shows at the page's corner", () => {
    render(<ChatSparkline label="Spark" points={readings} color="#D16A47" />);
    act(() => screen.getByRole("group").focus());
    expect(screen.getByTestId("chat-spark-tooltip").style.visibility).not.toBe("hidden");
  });
});

/**
 * The x, in the chart's own pixels, of reading `index`. The readings are a week apart,
 * so they are evenly spaced across the plot, which starts at the translated group.
 */
function chartX(container: HTMLElement, index: number): number {
  const plot = container.querySelector('g[transform^="translate("]')!;
  const left = Number(/translate\(([\d.]+)/.exec(plot.getAttribute("transform") ?? "")![1]);
  const innerW = Number(container.querySelector('circle[r="2.5"]')!.getAttribute("cx"));
  return left + (index * innerW) / (readings.length - 1);
}

/** The x of reading `index` in a sparkline: its scale runs from 2px to 94px across 96px. */
const sparkX = (index: number) => 2 + (index * 92) / (readings.length - 1);

describe("ChatLineChart pointer and focus", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function renderLineChart() {
    const rendered = render(
      <ChatLineChart
        label="DRO short interest"
        points={readings}
        color="#D16A47"
        kind="area"
        formatValue={formatPercent}
      />,
    );
    const chart = screen.getByRole("group", { name: /DRO short interest/ });
    return { ...rendered, chart };
  }

  it("lets a vertical swipe scroll the page, so the chart takes only the horizontal drag", () => {
    const { chart } = renderLineChart();
    expect(chart.style.touchAction).toBe("pan-y");
  });

  it("keeps the point a mouse hovers when focus arrives, as a press's focus does", () => {
    const { container, chart } = renderLineChart();
    fireEvent.pointerMove(chart, { clientX: chartX(container, 0), pointerType: "mouse" });
    expect(announced()).toBe("1 Oct 2026: 5.00%");

    act(() => chart.focus());
    expect(announced()).toBe("1 Oct 2026: 5.00%");
  });

  it("reads the point a mouse clicks, keeps it after the pointer leaves, and steps on from it", () => {
    const { container, chart } = renderLineChart();
    fireEvent.pointerDown(chart, { clientX: chartX(container, 1), pointerType: "mouse" });
    expect(announced()).toBe("8 Oct 2026: 2.00%");

    act(() => chart.focus());
    fireEvent.pointerUp(chart, { clientX: chartX(container, 1), pointerType: "mouse" });
    fireEvent.pointerLeave(chart, { pointerType: "mouse" });
    expect(announced()).toBe("8 Oct 2026: 2.00%");

    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(announced()).toBe("15 Oct 2026: 9.00%");
  });

  it("ends a mouse press released outside the chart, so moving on does not pin each reading passed", () => {
    const { container, chart } = renderLineChart();
    fireEvent.pointerDown(chart, { clientX: chartX(container, 0), pointerType: "mouse" });
    // The button came up outside the chart, so no pointerup reaches it: the next move has no button down.
    fireEvent.pointerMove(chart, { clientX: chartX(container, 3), pointerType: "mouse", buttons: 0 });
    expect(announced()).toBe("22 Oct 2026: 4.00%");

    fireEvent.pointerLeave(chart, { pointerType: "mouse" });
    expect(announced()).toBe("1 Oct 2026: 5.00%");
  });

  it("reads the point a touch lands on, not the latest, and keeps it when the finger lifts", () => {
    const { container, chart } = renderLineChart();
    fireEvent.pointerDown(chart, { clientX: chartX(container, 2), pointerType: "touch" });
    expect(announced()).toBe("15 Oct 2026: 9.00%");

    fireEvent.pointerUp(chart, { clientX: chartX(container, 2), pointerType: "touch" });
    // A touch's pointerleave arrives after its pointerup, and must not clear the pin.
    fireEvent.pointerLeave(chart, { pointerType: "touch" });
    expect(announced()).toBe("15 Oct 2026: 9.00%");
  });

  it("releases a pinned touch reading on a tap on the same point", () => {
    const { container, chart } = renderLineChart();
    fireEvent.pointerDown(chart, { clientX: chartX(container, 2), pointerType: "touch" });
    fireEvent.pointerUp(chart, { clientX: chartX(container, 2), pointerType: "touch" });
    expect(announced()).toBe("15 Oct 2026: 9.00%");

    fireEvent.pointerDown(chart, { clientX: chartX(container, 2), pointerType: "touch" });
    fireEvent.pointerUp(chart, { clientX: chartX(container, 2), pointerType: "touch" });
    expect(announced()).toBe("");
  });

  it("scrubs a touch across the readings, and pins the one it lifts on", () => {
    const { container, chart } = renderLineChart();
    fireEvent.pointerDown(chart, { clientX: chartX(container, 0), pointerType: "touch" });
    expect(announced()).toBe("1 Oct 2026: 5.00%");

    fireEvent.pointerMove(chart, { clientX: chartX(container, 3), pointerType: "touch" });
    expect(announced()).toBe("22 Oct 2026: 4.00%");

    fireEvent.pointerMove(chart, { clientX: chartX(container, 4), pointerType: "touch" });
    fireEvent.pointerUp(chart, { clientX: chartX(container, 4), pointerType: "touch" });
    expect(announced()).toBe("29 Oct 2026: 7.00%");
  });

  it("returns to the reading it had when the browser takes a touch for a page scroll", () => {
    const { container, chart } = renderLineChart();
    fireEvent.pointerDown(chart, { clientX: chartX(container, 1), pointerType: "touch" });
    fireEvent.pointerUp(chart, { clientX: chartX(container, 1), pointerType: "touch" });
    expect(announced()).toBe("8 Oct 2026: 2.00%");

    fireEvent.pointerDown(chart, { clientX: chartX(container, 3), pointerType: "touch" });
    expect(announced()).toBe("22 Oct 2026: 4.00%");

    fireEvent.pointerCancel(chart, { pointerType: "touch" });
    expect(announced()).toBe("8 Oct 2026: 2.00%");
  });

  it("sizes the tooltip to its text, and holds it clear of the crosshair at the right edge", () => {
    jest.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(300);
    jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
    const { container, chart } = renderLineChart();

    // Focus starts at the latest reading, the rightmost point: the tooltip flips to its left.
    act(() => chart.focus());
    const tip = container.querySelector(".pointer-events-none") as HTMLElement;
    expect(tip.className).toContain("w-max");

    const plotLeft = Number(
      /translate\(([\d.]+)/.exec(container.querySelector('g[transform^="translate("]')!.getAttribute("transform") ?? "")![1],
    );
    const crosshair = plotLeft + Number(container.querySelector('line[stroke-dasharray="3,3"]')!.getAttribute("x1"));
    const tipLeft = parseFloat(tip.style.left);
    expect(tipLeft + 200 <= crosshair || tipLeft >= crosshair).toBe(true);
  });
});

describe("ChatSparkline pointer", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function renderSparkline() {
    render(
      <ChatSparkline label="DRO short interest" seriesLabel="DRO" points={readings} color="#D16A47" />,
    );
    return screen.getByRole("group", { name: /DRO short interest/ });
  }

  it("reads the point a tap lands on, and keeps it when the finger lifts", () => {
    const spark = renderSparkline();
    fireEvent.pointerDown(spark, { clientX: sparkX(1), pointerType: "touch" });
    expect(announced()).toBe("8 Oct 2026, 2.00%");

    fireEvent.pointerUp(spark, { clientX: sparkX(1), pointerType: "touch" });
    fireEvent.pointerLeave(spark, { pointerType: "touch" });
    expect(announced()).toBe("8 Oct 2026, 2.00%");
  });

  it("keeps the point a mouse hovers when focus arrives", () => {
    const spark = renderSparkline();
    fireEvent.pointerMove(spark, { clientX: sparkX(0), pointerType: "mouse" });
    act(() => spark.focus());
    expect(announced()).toBe("1 Oct 2026, 5.00%");
  });

  it("lets a vertical swipe scroll the page, as the chart does", () => {
    expect(renderSparkline().style.touchAction).toBe("pan-y");
  });
});

describe("ChatLineChart tooltip and label", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps the tooltip inside a phone-width box, at the middle and at the ends", () => {
    // jsdom has no layout. Give the box a 300px width and the tooltip 200px, as a phone bubble has.
    jest.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(300);
    jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
    const { container } = render(
      <ChatLineChart
        label="DRO short interest"
        points={readings}
        color="#D16A47"
        kind="area"
        formatValue={formatPercent}
      />,
    );
    const chart = screen.getByRole("group", { name: /DRO short interest/ });
    const tipLeft = () =>
      parseFloat((container.querySelector(".pointer-events-none") as HTMLElement).style.left);

    // The middle reading is where the old fixed side clipped the tooltip off the box.
    act(() => chart.focus());
    fireEvent.keyDown(chart, { key: "Home" });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(tipLeft()).toBeGreaterThanOrEqual(0);
    expect(tipLeft() + 200).toBeLessThanOrEqual(300);

    fireEvent.keyDown(chart, { key: "End" });
    expect(tipLeft()).toBeGreaterThanOrEqual(0);
    expect(tipLeft() + 200).toBeLessThanOrEqual(300);

    fireEvent.keyDown(chart, { key: "Home" });
    expect(tipLeft()).toBeGreaterThanOrEqual(0);
    expect(tipLeft() + 200).toBeLessThanOrEqual(300);
  });

  it("outlines the latest value, so the line does not run through its digits", () => {
    const { container } = render(
      <ChatLineChart
        label="DRO short interest"
        points={readings}
        color="#D16A47"
        formatValue={formatPercent}
      />,
    );
    const latest = container.querySelector('text[paint-order="stroke"]');
    expect(latest).toHaveTextContent("7.00%");
    expect(latest).toHaveAttribute("stroke", "hsl(var(--background))");
  });

  it("hides the latest value while a reading is on screen, so the headline cannot read beside it", () => {
    render(
      <ChatLineChart label="DRO short interest" points={readings} color="#D16A47" formatValue={formatPercent} />,
    );
    const chart = screen.getByRole("group", { name: /DRO short interest/ });
    expect(screen.getByTestId("chat-latest-label")).toHaveTextContent("7.00%");

    act(() => chart.focus());
    expect(screen.queryByTestId("chat-latest-label")).not.toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.queryByTestId("chat-latest-label")).not.toBeInTheDocument();

    act(() => chart.blur());
    expect(screen.getByTestId("chat-latest-label")).toHaveTextContent("7.00%");
  });

  it("names the tooltip's date in the chat's short months, not the stock chart's", () => {
    render(
      <ChatLineChart
        label="DRO short interest"
        points={[
          { t: Date.parse("2026-09-01T00:00:00Z"), v: 5 },
          { t: Date.parse("2026-09-08T00:00:00Z"), v: 6 },
        ]}
        color="#D16A47"
        formatValue={formatPercent}
      />,
    );
    const chart = screen.getByRole("group", { name: /DRO short interest/ });
    act(() => chart.focus());
    fireEvent.keyDown(chart, { key: "Home" });
    expect(announced()).toBe("1 Sep 2026: 5.00%");
    expect(screen.getByText("1 Sep 2026")).toBeInTheDocument();
  });

  it("marks the chart while it shows a reading, for the sidebar's Escape handling", () => {
    render(
      <ChatLineChart label="DRO short interest" points={readings} color="#D16A47" formatValue={formatPercent} />,
    );
    const chart = screen.getByRole("group", { name: /DRO short interest/ });
    expect(chart).not.toHaveAttribute("data-reading-active");

    act(() => chart.focus());
    expect(chart).toHaveAttribute("data-reading-active", "true");
  });
});
