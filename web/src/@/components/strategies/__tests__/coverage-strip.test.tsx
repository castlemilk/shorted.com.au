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
    expect(under.querySelector(".hatch-empty")).not.toBeNull();
    expect(under.textContent).toContain("(under 80%)");
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
