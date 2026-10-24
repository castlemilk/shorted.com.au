import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChatLineChart, ChatSparkline } from "../chat-charts";
import { formatPercent } from "../chat-tool-format";
import type { Reading } from "../chat-tool-data";

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
