import { render, screen } from "@testing-library/react";
import { DisclosedBar, type DisclosedSegment } from "../disclosed-bar";

const seg = (kind: string, pct: number, holders = 1): DisclosedSegment => ({ kind, pct, holders });

describe("DisclosedBar", () => {
  it("draws the outlined track to total over scaleMax, and to full width when the two are equal", () => {
    const { rerender } = render(
      <DisclosedBar segments={[seg("super_fund", 60)]} total={60} scaleMax={120} showFigure={false} />,
    );
    expect(screen.getByRole("img")).toHaveStyle({ width: "50%" });

    rerender(<DisclosedBar segments={[seg("super_fund", 60)]} total={60} scaleMax={60} showFigure={false} />);
    expect(screen.getByRole("img")).toHaveStyle({ width: "100%" });
  });

  it("sizes each segment as its share of the total, and keeps every one inside the track", () => {
    render(
      <DisclosedBar
        segments={[seg("unclassified", 5), seg("hedge_fund", 10), seg("super_fund", 30)]}
        total={45}
        scaleMax={90}
        showFigure={false}
      />,
    );
    const segments = Array.from(screen.getByRole("img").children) as HTMLElement[];
    // Kind order, not the order given: super funds first, unclassified last.
    expect(segments.map((s) => s.style.width)).toEqual([
      `${(30 / 45) * 100}%`,
      `${(10 / 45) * 100}%`,
      `${(5 / 45) * 100}%`,
    ]);
    for (const segment of segments) {
      expect(Number.parseFloat(segment.style.width)).toBeLessThanOrEqual(100);
    }
  });

  it("draws other and unclassified holders hollow, with no kind colour", () => {
    render(
      <DisclosedBar
        segments={[seg("unclassified", 1), seg("super_fund", 4), seg("other", 2)]}
        total={7}
        scaleMax={7}
        showFigure={false}
      />,
    );
    const [superFund, other, unclassified] = Array.from(screen.getByRole("img").children) as HTMLElement[];
    expect(superFund).toHaveClass("bg-[#87A96B]");
    expect(other).not.toHaveClass("bg-[#E8DEB5]");
    expect(unclassified).not.toHaveClass("bg-[#E5E1DC]");
    expect(other!.className).not.toMatch(/bg-\[/);
    expect(unclassified!.className).not.toMatch(/bg-\[/);
  });

  it("says in its label what the sum is, to two decimals, and that it is not a share of the company", () => {
    render(
      <DisclosedBar segments={[seg("index_manager", 45.2308, 2)]} total={45.2308} scaleMax={45.2308} showFigure />,
    );
    expect(
      screen.getByRole("img", {
        name: "Disclosed voting power 45.23%, what the notices disclose and not a share of the company: Index manager 45.23% (2 holders)",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("45.23%")).toBeInTheDocument();
  });

  it("outlines the track in the muted ink, never the control boundary token", () => {
    render(<DisclosedBar segments={[seg("super_fund", 10)]} total={10} scaleMax={20} showFigure={false} />);
    const track = screen.getByRole("img");
    expect(track).toHaveClass("border-muted-foreground");
    expect(track).not.toHaveClass("border-input");
  });

  it("prints n/a, and draws no track, for a sum with nothing to draw", () => {
    render(<DisclosedBar segments={[]} total={0} scaleMax={0} />);
    expect(screen.getByText("n/a")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("prints its caption beneath the track when one is given", () => {
    render(
      <DisclosedBar
        segments={[seg("super_fund", 1)]}
        total={1}
        scaleMax={1}
        caption="What the notices disclose, each interest counted once; not a share of the company."
      />,
    );
    expect(screen.getByText(/each interest counted once/)).toHaveClass("text-[11px]");
  });
});
