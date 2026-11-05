import { render, screen } from "@testing-library/react";
import { CoverageStrip } from "../coverage-strip";

const ITEMS = [
  { key: "2019", label: "2019", coverage: 0.64 },
  { key: "2024", label: "2024", coverage: 0.96 },
  { key: "2025", label: "2025", coverage: null },
];

describe("CoverageStrip", () => {
  it("is an ordered list named for the period it covers, not an SVG", () => {
    const { container } = render(
      <CoverageStrip label="Coverage by year" items={ITEMS} />,
    );
    const list = screen.getByRole("list", { name: "Coverage by year" });
    expect(list.tagName).toBe("OL");
    expect(list.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("sizes each bar to its coverage", () => {
    const { container } = render(
      <CoverageStrip label="Coverage by year" items={ITEMS} />,
    );
    const bar = container.querySelector(
      "li span[aria-hidden] > span",
    ) as HTMLElement;
    expect(bar.style.width).toBe("64%");
  });

  it("hatches a bar under 80% and says so in the figure", () => {
    render(<CoverageStrip label="Coverage by year" items={ITEMS} />);
    const under = screen.getByText("64%").closest("li")!;
    expect(under.getAttribute("data-hatched")).toBe("");
    expect(under.querySelector(".hatch-bar")).not.toBeNull();
    expect(under.querySelector(".hatch-empty")).toBeNull();
    expect(under.textContent).toContain("(under 80%)");
  });

  it("gives a hatched bar a base of the solid bar's ink, not the track's colour", () => {
    // The bar is .hatch-bar (a solid-ink base under light stripes), so it reads
    // against the track. A hatch on the track's own muted base could not be seen.
    render(<CoverageStrip label="Coverage by year" items={ITEMS} />);
    const under = screen.getByText("64%").closest("li")!;
    const bar = under.querySelector(".hatch-bar") as HTMLElement;
    expect(bar.className).not.toContain("bg-muted");
  });

  it("prints n/a, not NaN, for a coverage figure that is not a number", () => {
    const { container } = render(
      <CoverageStrip
        label="Coverage by year"
        items={[{ key: "x", label: "2026", coverage: Number.NaN }]}
      />,
    );
    expect(container.textContent).toContain("n/a");
    expect(container.textContent).not.toContain("NaN");
    expect(container.querySelector("[data-hatched]")).toBeNull();
  });

  it("draws the months as one row of narrow bars, hatched under 80%, with each read", () => {
    const { container } = render(
      <CoverageStrip
        label="Coverage by month"
        layout="columns"
        items={[
          { key: "m1", label: "Mar 2023", coverage: 0.5 },
          { key: "m2", label: "Apr 2023", coverage: 0.9 },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Coverage by month" });
    expect(list.className).toContain("flex");
    expect(list.querySelectorAll("li[data-hatched]")).toHaveLength(1);
    expect(screen.getByText("Mar 2023: 50% (under 80%)")).toBeInTheDocument();
    expect(container.querySelectorAll(".hatch-bar")).toHaveLength(1);
  });

  it("leaves a bar at or over 80% solid", () => {
    render(<CoverageStrip label="Coverage by year" items={ITEMS} />);
    const full = screen.getByText("96%").closest("li")!;
    expect(full.getAttribute("data-hatched")).toBeNull();
    expect(full.querySelector(".hatch-empty")).toBeNull();
  });

  it("prints n/a and draws no bar for an unknown coverage", () => {
    const { container } = render(
      <CoverageStrip label="Coverage by year" items={ITEMS} />,
    );
    const unknown = screen.getByText("n/a").closest("li")!;
    expect(unknown.getAttribute("data-hatched")).toBeNull();
    const bar = unknown.querySelector(
      "span[aria-hidden] > span",
    ) as HTMLElement;
    expect(bar.style.width).toBe("0%");
    expect(container.textContent).not.toContain("NaN");
  });
});
