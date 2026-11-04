import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { EquitySparkline } from "../equity-sparkline";

const DAY = 86_400_000;
const T0 = Date.UTC(2019, 4, 1);
const series = (values: number[]) =>
  values.map((v, i) => ({ t: T0 + i * 30 * DAY, v }));

const STRATEGY = series([100, 110, 105, 130, 160]);
const BENCHMARK = series([100, 102, 104, 106, 108]);

describe("EquitySparkline", () => {
  it("is a labelled image: a server SVG with no script", () => {
    render(
      <EquitySparkline
        label="Backtest, in-sample to 1 Jan 2026, then recorded"
        strategy={STRATEGY}
      />,
    );
    const svg = screen.getByRole("img", {
      name: "Backtest, in-sample to 1 Jan 2026, then recorded",
    });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    // jsdom cannot show a script that React never emits, so the check is on the
    // markup the server writes: the component renders with no script in it.
    const html = renderToStaticMarkup(<EquitySparkline label="s" strategy={STRATEGY} />);
    expect(html).toContain("<svg");
    expect(html).not.toContain("<script");
  });

  it("draws the strategy solid in the primary token", () => {
    const { container } = render(
      <EquitySparkline label="s" strategy={STRATEGY} />,
    );
    const path = container.querySelector("[data-spark-strategy]")!;
    expect(path.getAttribute("stroke")).toBe("hsl(var(--primary))");
    expect(path.getAttribute("stroke-dasharray")).toBeNull();
  });

  it("draws the benchmark dashed in muted ink", () => {
    const { container } = render(
      <EquitySparkline label="s" strategy={STRATEGY} benchmark={BENCHMARK} />,
    );
    const path = container.querySelector("[data-spark-benchmark]")!;
    expect(path.getAttribute("stroke-dasharray")).toBe("3 3");
    expect(path.getAttribute("stroke")).toBe("hsl(var(--muted-foreground))");
  });

  it("shades the recorded span after the freeze date in a token tint", () => {
    const { container } = render(
      <EquitySparkline
        label="s"
        strategy={STRATEGY}
        liveFrom={T0 + 60 * DAY}
      />,
    );
    const band = container.querySelector("[data-spark-live]") as SVGRectElement;
    expect(band).not.toBeNull();
    expect(band.getAttribute("style")).toContain("--primary");
  });

  it("draws no benchmark or recorded band when neither is given", () => {
    const { container } = render(
      <EquitySparkline label="s" strategy={STRATEGY} />,
    );
    expect(container.querySelector("[data-spark-benchmark]")).toBeNull();
    expect(container.querySelector("[data-spark-live]")).toBeNull();
  });

  it("shows the empty label in a hatched box when there is no series yet", () => {
    const { container } = render(
      <EquitySparkline
        label="No series"
        strategy={[]}
        emptyLabel="Run required"
      />,
    );
    // The name carries the empty state, so a screen reader hears what is shown.
    const box = screen.getByRole("img", { name: "No series: Run required" });
    expect(box.textContent).toBe("Run required");
    expect(container.querySelector("svg")).toBeNull();
    expect(box.className).toContain("hatch-empty");
  });
});
