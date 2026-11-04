import { fireEvent, render, screen } from "@testing-library/react";

import { DeskChip, DeskLink, LensLegend, formatFlowPp, formatLensFigure } from "../lens-legend";
import { lensScale } from "../desk-scales";

describe("formatFlowPp", () => {
  it("prints a net change in percentage points with a true minus, and n/a for no figure", () => {
    expect(formatFlowPp(1.14)).toBe("+1.14 pp");
    expect(formatFlowPp(-0.31)).toBe("−0.31 pp");
    expect(formatFlowPp(0.001)).toBe("0.00 pp");
    expect(formatFlowPp(null)).toBe("n/a");
  });
});

describe("formatLensFigure", () => {
  it("prints a share to two decimals, and n/a where there is none", () => {
    expect(formatLensFigure("disclosed", 41.2)).toBe("41.20%");
    expect(formatLensFigure("index", null)).toBe("n/a");
    expect(formatLensFigure("flow", -2)).toBe("−2.00 pp");
  });
});

describe("LensLegend", () => {
  it("draws five stepped bins with round thresholds, the top one reading and above", () => {
    render(<LensLegend lens="flow" scale={lensScale("flow", [-2, 1])} />);
    const legend = screen.getByRole("img", { name: /Net change in disclosed voting power, pp, five steps/ });
    expect(legend.querySelectorAll("span[aria-hidden='true'].block.h-2\\.5")).toHaveLength(5);
    expect(screen.getByText("−2.00 pp and below")).toBeInTheDocument();
    expect(screen.getByText("+2.00 pp and above")).toBeInTheDocument();
  });

  it("prints a sequential lens's five thresholds from zero", () => {
    render(<LensLegend lens="disclosed" scale={lensScale("disclosed", [10])} />);
    expect(screen.getByText("0.00%")).toBeInTheDocument();
    expect(screen.getByText("8.00% and above")).toBeInTheDocument();
  });

  it("states the caption beneath the scale, outside its image, when one is given (the index flow's files, spec 14.10)", () => {
    render(
      <LensLegend
        lens="index_flow"
        scale={lensScale("index_flow", [-2, 1])}
        caption="2 funds compared, files 2026-06-30 to 2026-07-31 against 2026-10-30"
      />,
    );
    const caption = screen.getByText("2 funds compared, files 2026-06-30 to 2026-07-31 against 2026-10-30");
    expect(caption.closest("[role='img']")).toBeNull();
    expect(screen.getByRole("img", { name: /Change in index fund shares, five steps/ })).toBeInTheDocument();
  });

  it("draws no caption without one", () => {
    const { container } = render(<LensLegend lens="flow" scale={lensScale("flow", [-2, 1])} />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });
});

describe("DeskChip and DeskLink", () => {
  it("marks the active chip, and links it with replace, no scroll and nofollow", () => {
    render(<DeskChip href="/ownership?window=28" active label="28 days" />);
    const chip = screen.getByRole("link", { name: "28 days" });
    expect(chip).toHaveAttribute("aria-current", "true");
    expect(chip).toHaveAttribute("href", "/ownership?window=28");
    expect(chip).toHaveAttribute("rel", "nofollow");
  });

  it("hands a plain click to the island, and leaves a modified click to the browser", () => {
    const onPick = jest.fn();
    render(<DeskLink href="/ownership?lens=short" onPick={onPick}>Short interest</DeskLink>);
    const link = screen.getByRole("link", { name: "Short interest" });
    const plain = fireEvent.click(link);
    expect(plain).toBe(false);
    expect(onPick).toHaveBeenCalledTimes(1);

    onPick.mockClear();
    fireEvent.click(link, { metaKey: true });
    expect(onPick).not.toHaveBeenCalled();
  });
});
