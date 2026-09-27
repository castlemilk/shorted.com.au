import { render, screen } from "@testing-library/react";

const getDailyShortSeries = jest.fn();

jest.mock("~/app/actions/getDailyShortSeries", () => ({
  ...jest.requireActual<typeof import("~/app/actions/getDailyShortSeries")>(
    "~/app/actions/getDailyShortSeries",
  ),
  getDailyShortSeries: (...args: unknown[]) => getDailyShortSeries(...args),
}));
jest.mock("~/app/actions/config", () => ({
  SHORTS_API_URL: "https://shorts.test",
  buildApiUrl: (base: string, path: string) => `${base}${path}`,
  serverFetchWithUserAgent: jest.fn(async () => ({ ok: false })),
}));

import { getShortInterestDeltas } from "../short-interest-summary";
import { ShortInterestHistory } from "../short-interest-history";

/**
 * WBT around its 2024 peak, as ASIC reported it: 8.91% on Thursday 1 February.
 * The weekly MAX series averaged that week to 8.75%, and the page reported the
 * mean as the all-time high.
 */
const WBT = [
  { date: "2023-09-01", pct: 4.0 },
  { date: "2024-01-29", pct: 8.6 },
  { date: "2024-01-30", pct: 8.7 },
  { date: "2024-01-31", pct: 8.8 },
  { date: "2024-02-01", pct: 8.908 },
  { date: "2024-02-02", pct: 8.75 },
  { date: "2026-06-22", pct: 0.36 },
  { date: "2026-08-21", pct: 1.6 },
  { date: "2026-09-14", pct: 1.9 },
  { date: "2026-09-17", pct: 1.938 },
  { date: "2026-09-18", pct: 3.068 },
  { date: "2026-09-21", pct: 3.089 },
];

describe("stock page figures come from every ASIC report", () => {
  beforeEach(() => {
    getDailyShortSeries.mockResolvedValue(WBT);
  });

  it("summary: the peak is the reported day, and changes run from the latest report", async () => {
    const deltas = await getShortInterestDeltas("WBT");

    expect(getDailyShortSeries).toHaveBeenCalledWith("WBT");
    expect(deltas.peakPct).toBe(8.908);
    expect(deltas.peakDate?.toISOString().slice(0, 10)).toBe("2024-02-01");
    // 21 Sep against the last report on or before 14 Sep; 21 Aug; 22 Jun.
    expect(deltas.change7d).toBeCloseTo(3.089 - 1.9, 9);
    expect(deltas.change30d).toBeCloseTo(3.089 - 1.6, 9);
    expect(deltas.change90d).toBeCloseTo(3.089 - 0.36, 9);
  });

  it("summary: no series, no figures", async () => {
    getDailyShortSeries.mockResolvedValue([]);
    await expect(getShortInterestDeltas("WBT")).resolves.toEqual({
      change7d: null,
      change30d: null,
      change90d: null,
      peakPct: null,
      peakDate: null,
    });
  });

  it("history: the current level, extremes and changes are reported values", async () => {
    const section = await ShortInterestHistory({ stockCode: "WBT", companyName: "Weebit Nano" });
    expect(section).not.toBeNull();
    render(section!);

    const high = screen.getByText("All-time high").nextElementSibling;
    expect(high?.textContent).toContain("8.91%");
    expect(high?.textContent).toContain("February 2024");
    expect(screen.getByText(/The current level is 3\.09% of shares on issue/)).toBeInTheDocument();
    expect(screen.getByText(/peaked at 8\.91% in February 2024/)).toBeInTheDocument();
    expect(screen.getByText(/Since 2023/)).toBeInTheDocument();
    // 30-day change: 3.089 - 1.6.
    expect(screen.getByText("+1.49pp")).toBeInTheDocument();
  });
});
