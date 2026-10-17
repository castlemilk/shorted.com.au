import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LADDER_DOMAIN_PCT,
  RegimeBanner,
  ladderMarks,
  ladderX,
} from "../regime-banner";
import { UPTREND } from "./fixtures";

describe("ladderX", () => {
  it("places the 200-day at the centre and scales the domain to the track", () => {
    expect(ladderX(0)).toBe(50);
    expect(ladderX(LADDER_DOMAIN_PCT)).toBe(100);
    expect(ladderX(-LADDER_DOMAIN_PCT)).toBe(0);
    expect(ladderX(6)).toBe(75);
  });

  it("clamps beyond the domain and draws nothing for an unknown", () => {
    expect(ladderX(40)).toBe(100);
    expect(ladderX(-40)).toBe(0);
    expect(ladderX(null)).toBeNull();
    expect(ladderX(Number.NaN)).toBeNull();
  });
});

describe("ladderMarks", () => {
  it("reads the close, the 50-day and the 52-week high against the 200-day", () => {
    // UPTREND: close 8812.3, 50-day 8600, 200-day 8200, 1.5% off the high.
    const marks = ladderMarks(UPTREND);
    expect(marks.needle).toBeCloseTo(50 + ((8812.3 / 8200 - 1) * 100 * 50) / 12, 6);
    expect(marks.needle).toBeCloseTo(81.11, 1);
    expect(marks.sma50).toBeCloseTo(70.33, 1);
    // The high is the close grossed back up by the distance off it.
    const high = 8812.3 / (1 - 0.015);
    expect(marks.high).toBeCloseTo(50 + ((high / 8200 - 1) * 100 * 50) / 12, 6);
  });

  it("has no needle without a close or a 200-day, and no high without the distance", () => {
    expect(ladderMarks({ ...UPTREND, close: null }).needle).toBeNull();
    expect(ladderMarks({ ...UPTREND, sma200: null }).needle).toBeNull();
    expect(ladderMarks({ ...UPTREND, pctOff52wHigh: null }).high).toBeNull();
    expect(ladderMarks({ ...UPTREND, sma50: null }).sma50).toBeNull();
  });
});

describe("RegimeBanner ladder", () => {
  it("draws the rungs as text-free, aria-hidden marks positioned by left, never by a translate class", () => {
    const { container } = render(<RegimeBanner regime={UPTREND} />);
    const ladder = container.querySelector("[data-ladder-mark]")!.parentElement!;
    expect(ladder).toHaveAttribute("aria-hidden", "true");
    expect(ladder.textContent).toBe("");
    const needle = ladder.querySelector('[data-ladder-mark="close"]')!;
    const needleX = 50 + ((8812.3 / 8200 - 1) * 100 * 50) / 12;
    expect(needle).toHaveStyle({ left: `calc(${needleX}% - 1px)` });
    expect(needle.className).not.toMatch(/translate/);
    expect(needle.className).toContain("bg-primary");
    expect(ladder.querySelector('[data-ladder-mark="sma200"]')).toHaveStyle({ left: "50%" });
    expect(ladder.querySelector('[data-ladder-mark="sma50"]')).toBeInTheDocument();
    expect(ladder.querySelector('[data-ladder-mark="high"]')).toBeInTheDocument();
    // Every number appears exactly once: in its readout.
    expect(screen.getAllByText("8,812.3")).toHaveLength(1);
    expect(screen.getAllByText("+2.5%")).toHaveLength(1);
  });

  it("draws no ladder when the close or the 200-day is unknown", () => {
    const { container } = render(<RegimeBanner regime={{ ...UPTREND, sma200: null }} />);
    expect(container.querySelector("[data-ladder-mark]")).toBeNull();
    expect(screen.getByText("Uptrend")).toBeInTheDocument();
  });

  it("renders a downtrend needle in the clay-rust alert register, never red", () => {
    const { container } = render(
      <RegimeBanner regime={{ ...UPTREND, regime: "downtrend", close: 8000 }} />,
    );
    const needle = container.querySelector('[data-ladder-mark="close"]')!;
    expect(needle.className).toContain("bg-accent");
    expect(container.innerHTML).not.toMatch(/red|destructive/);
  });
});

// The stock Strategy tab's phone form (spec D4). Below sm the readouts and the
// ladder are hidden so the levels chart is not pushed below the fold; from sm,
// and on /picks, the gauge is whole. The hiding is CSS, so every figure stays in
// the server HTML.
describe("RegimeBanner compact", () => {
  const readouts = (container: HTMLElement) =>
    container.querySelector("dl") as HTMLElement;
  const ladder = (container: HTMLElement) =>
    container.querySelector("[data-ladder-mark]")!.parentElement as HTMLElement;

  it("hides the readouts and the ladder below sm, and shows them from sm", () => {
    const { container } = render(<RegimeBanner regime={UPTREND} compact />);
    expect(readouts(container)).toHaveClass("hidden", "sm:grid");
    expect(readouts(container)).not.toHaveClass("grid");
    // The four columns from sm are still the readouts' own.
    expect(readouts(container)).toHaveClass("grid-cols-2", "gap-2", "sm:grid-cols-4");
    expect(ladder(container)).toHaveClass("hidden", "sm:block");
    // The ladder keeps its own box for the widths that show it.
    expect(ladder(container)).toHaveClass("relative", "mt-4", "h-8", "select-none");
  });

  it("keeps the eyebrow, the pill, the as-of date and the verdict in view at every width", () => {
    const { container } = render(<RegimeBanner regime={UPTREND} compact />);
    const banner = screen.getByRole("region", { name: "Market regime" });
    const asOf = container.querySelector('time[datetime="2026-09-25"]') as HTMLElement;
    expect(asOf).toHaveTextContent("25 September 2026");
    for (const shown of [
      within(banner).getByText(/Market regime · /),
      within(banner).getByText("Uptrend"),
      asOf,
      within(banner).getByText(UPTREND.verdict),
    ]) {
      // None of them is inside anything hidden.
      expect(shown.closest(".hidden")).toBeNull();
    }
    // Only the two blocks are hidden: nothing else in the banner carries `hidden`.
    expect(Array.from(container.querySelectorAll(".hidden"))).toEqual([
      readouts(container),
      ladder(container),
    ]);
  });

  it("leaves every figure in the markup: the hiding is CSS, not a different render", () => {
    render(<RegimeBanner regime={UPTREND} compact />);
    expect(screen.getAllByText("8,812.3")).toHaveLength(1);
    expect(screen.getAllByText("+2.5%")).toHaveLength(1);
    for (const label of ["Close", "vs 50-day", "vs 200-day", "Off 52w high"]) {
      expect(screen.getByText(label, { selector: "dt" })).toBeInTheDocument();
    }
  });

  it("is the whole gauge by default, with the classes it had before the prop", () => {
    const { container } = render(<RegimeBanner regime={UPTREND} />);
    expect(readouts(container).className).toBe("grid grid-cols-2 gap-2 sm:grid-cols-4");
    expect(ladder(container).className).toBe("relative mt-4 h-8 select-none");
    expect(container.querySelector(".hidden")).toBeNull();
  });

  it("renders identically with compact false and with no prop", () => {
    expect(renderToStaticMarkup(<RegimeBanner regime={UPTREND} compact={false} />)).toBe(
      renderToStaticMarkup(<RegimeBanner regime={UPTREND} />),
    );
  });

  it("changes nothing else about the banner", () => {
    // Strip the two responsive-hiding additions and the compact markup is the
    // default markup, so the prop cannot have moved a class anywhere else.
    const compact = renderToStaticMarkup(<RegimeBanner regime={UPTREND} compact />)
      .replace('class="hidden sm:grid grid-cols-2', 'class="grid grid-cols-2')
      .replace('class="relative mt-4 h-8 select-none hidden sm:block"', 'class="relative mt-4 h-8 select-none"');
    expect(compact).toBe(renderToStaticMarkup(<RegimeBanner regime={UPTREND} />));
  });

  it("has nothing to hide, and hides nothing, when the regime is unavailable", () => {
    const { container } = render(<RegimeBanner regime={null} compact />);
    expect(container.querySelector("dl")).toBeNull();
    expect(container.querySelector("[data-ladder-mark]")).toBeNull();
    expect(container.querySelector(".hidden")).toBeNull();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Market regime unavailable/)).toBeInTheDocument();
  });
});
