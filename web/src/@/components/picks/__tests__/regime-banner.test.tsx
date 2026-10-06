import { render, screen, within } from "@testing-library/react";

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
