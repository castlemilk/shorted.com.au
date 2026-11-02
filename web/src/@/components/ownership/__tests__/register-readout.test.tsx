import { render, screen } from "@testing-library/react";
import { RegisterReadout, type RegisterReadoutProps } from "../register-readout";

const current: RegisterReadoutProps = {
  code: "ZIP",
  disclosed: "6.20%",
  interests: 1,
  holders: 1,
  asOf: "2026-10-19",
  indexPct: "3.01%",
  indexFiles: 2,
  indexFrom: "2026-09-30",
  indexTo: "2026-10-19",
  superOptions: 1,
  superValue: "A$2.97M",
  superFrom: "2026-06-30",
  superTo: "2026-06-30",
  segments: [{ kind: "super_fund", pct: 6.2, holders: 1 }],
  total: 6.2,
};

const none: RegisterReadoutProps = {
  ...current,
  disclosed: "n/a",
  interests: 0,
  holders: 0,
  indexPct: null,
  indexFiles: 0,
  superOptions: 0,
  superValue: null,
  segments: [],
  total: 0,
};

// A meta line can hold <time> elements, so it is found by its whole text, not its own text nodes.
const cellText = (text: string) => screen.getByText((_, node) => node?.tagName === "DD" && node.textContent === text);

// The figures a readout prints, in cell order: the large type, not the meta lines.
const figuresOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("dd"))
    .filter((dd) => dd.classList.contains("text-2xl"))
    .map((dd) => dd.textContent);

describe("RegisterReadout", () => {
  it("has three labelled cells, and none of them is short interest", () => {
    const { container } = render(<RegisterReadout {...current} />);
    const labels = Array.from(container.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(labels).toEqual(["Disclosed by notices", "Index funds tracked", "Super options tracked"]);
    expect(container.textContent?.toLowerCase()).not.toContain("short");
  });

  it("prints each figure with its own date or range, and the disclosed figure as read to its notices", () => {
    render(<RegisterReadout {...current} />);
    const disclosed = screen.getByText("6.20%");
    expect(disclosed).toHaveAttribute("title", "Notices read to 2026-10-19");
    expect(cellText("1 interest counted once, 1 holder; not a share of the company")).toHaveClass("tabular-nums");
    expect(screen.getByText("3.01%")).toBeInTheDocument();
    expect(cellText("2 files, as at 2026-09-30 to 2026-10-19")).toBeInTheDocument();
    expect(cellText("A$2.97M combined, as at 2026-06-30")).toBeInTheDocument();
  });

  it("prints the count of super options as the super figure, and the combined value only in its meta line", () => {
    const { container } = render(<RegisterReadout {...current} />);
    expect(figuresOf(container)).toEqual(["6.20%", "3.01%", "1"]);
    const combined = screen.getAllByText(/A\$2\.97M/);
    expect(combined).toHaveLength(1);
    expect(combined[0]!.tagName).toBe("DD");
    expect(combined[0]).not.toHaveClass("text-2xl");
  });

  it("sets each date of a range as a time element", () => {
    const { container } = render(<RegisterReadout {...current} />);
    const times = Array.from(container.querySelectorAll("time")).map((t) => t.getAttribute("datetime"));
    expect(times).toEqual(["2026-09-30", "2026-10-19", "2026-06-30"]);
  });

  it("prints n/a, never zero, for every figure a register does not hold", () => {
    const { container } = render(<RegisterReadout {...none} />);
    expect(figuresOf(container)).toEqual(["n/a", "n/a", "n/a"]);
    expect(screen.getByText("no current holder read")).toBeInTheDocument();
    expect(screen.getByText("no file tracked holds it")).toBeInTheDocument();
    expect(screen.getByText("none tracked holds it")).toBeInTheDocument();
    expect(container.textContent).not.toContain("0.00%");
  });

  it("draws no bar, and no caption under one, when no holder is current", () => {
    render(<RegisterReadout {...none} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/each interest counted once/)).toBeNull();
  });

  it("draws the disclosure bar beneath the cells, without a second figure of the same sum", () => {
    render(<RegisterReadout {...current} />);
    expect(screen.getByRole("img", { name: /not a share of the company/ })).toBeInTheDocument();
    expect(screen.getAllByText("6.20%")).toHaveLength(1);
    expect(
      screen.getByText("What the notices disclose, each interest counted once; not a share of the company."),
    ).toBeInTheDocument();
  });
});
