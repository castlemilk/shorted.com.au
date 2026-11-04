/// <reference types="jest" />

import { formatFlowPp } from "~/@/components/ownership/desk/lens-legend";
import { inclusiveDays, largestMoveLines, weekSpanDays, type LargestMove } from "../largest-moves";

describe("largestMoveLines", () => {
  it("prints each move's change with the desk's true minus, its date, and its notice only when the link is safe", () => {
    const moves: LargestMove[] = [
      { code: "RIO", holder: "BlackRock", released: "2026-10-20", change: -2.5, url: "javascript:alert(1)" },
      { code: "BHP", holder: "Vanguard", released: "2026-10-28", change: 1.2, url: "https://www.asx.com.au/bhp.pdf" },
    ];
    const lines = largestMoveLines(moves, formatFlowPp, (url) => (url.startsWith("https://") ? url : undefined));
    expect(lines).toEqual([
      { label: "RIO · BlackRock", value: "−2.50 pp · 2026-10-20", href: "" },
      { label: "BHP · Vanguard", value: "+1.20 pp · 2026-10-28", href: "https://www.asx.com.au/bhp.pdf" },
    ]);
  });

  it("keeps the served order, and draws no line for no move", () => {
    expect(largestMoveLines([], formatFlowPp, () => undefined)).toEqual([]);
  });
});

describe("weekSpanDays", () => {
  it("counts both ends of the window: the Monday of its first week to the Sunday of its last", () => {
    expect(weekSpanDays("2026-10-26", "2026-10-26")).toBe(7);
    expect(weekSpanDays("2025-11-03", "2026-10-26")).toBe(364);
  });

  it("is 0 for an empty, malformed or inverted window", () => {
    expect(weekSpanDays("", "")).toBe(0);
    expect(weekSpanDays("2026-10-26", "2025-10-27")).toBe(0);
    expect(weekSpanDays("nope", "2026-10-26")).toBe(0);
  });
});

describe("inclusiveDays", () => {
  it("counts both ends: from the first week's Monday to the newest notice's date", () => {
    expect(inclusiveDays("2025-11-03", "2026-10-31")).toBe(363);
    expect(inclusiveDays("2026-10-26", "2026-10-26")).toBe(1);
  });

  it("is 0 for a bad date or an inverted window", () => {
    expect(inclusiveDays("", "2026-10-26")).toBe(0);
    expect(inclusiveDays("2026-10-27", "2026-10-26")).toBe(0);
  });
});
