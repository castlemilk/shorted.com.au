import { scaleTime } from "@visx/scale";
import { timeTickValues } from "../chart-primitives";

/**
 * The stock chart's time ticks. The chat's labelled path is tested beside the chat's labels;
 * these pin the default, which the stock chart draws, so the chat's change cannot move it.
 */
describe("timeTickValues without a label width (the stock chart)", () => {
  const from = new Date(2026, 0, 1);
  const to = new Date(2026, 3, 1);

  it("draws d3's own ticks when the plot has room for them", () => {
    const scale = scaleTime<number>({ domain: [from, to], range: [0, 600] });
    expect(timeTickValues(scale, 600)).toEqual(scale.ticks(5));
  });

  it("thins to whole ticks, at least 64px apart on average, when the plot is narrow", () => {
    const scale = scaleTime<number>({ domain: [from, to], range: [0, 150] });
    const raw = scale.ticks(5);
    const kept = timeTickValues(scale, 150);
    expect(kept.length).toBeLessThan(raw.length);
    expect(kept.every((tick) => raw.some((r) => r.getTime() === tick.getTime()))).toBe(true);
    const spacing = 150 / (raw.length - 1);
    expect(spacing * Math.max(1, Math.ceil(64 / spacing))).toBeGreaterThanOrEqual(64);
  });

  it("uses three ticks in the compact axis", () => {
    const scale = scaleTime<number>({ domain: [from, to], range: [0, 600] });
    expect(timeTickValues(scale, 600, { compact: true })).toEqual(scale.ticks(3));
  });
});
