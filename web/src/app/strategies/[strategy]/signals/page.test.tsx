import type { PickRow, StrategyPicksResult } from "~/@/lib/strategies/types";
import { SIGNALS_PUBLIC_ROWS } from "~/@/lib/strategies/signals";

const getStrategyPicks = jest.fn();
jest.mock("~/app/actions/getStrategyPicks", () => ({
  getStrategyPicks: (...args: unknown[]) => getStrategyPicks(...args),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: jest.fn(async () => undefined),
}));
// The island is a client module; the page's props are what is under test.
jest.mock("./signals-island", () => ({
  SignalsIsland: () => null,
}));

import StrategySignalsPage, { generateMetadata } from "./page";

function pick(code: string, status: PickRow["status"]): PickRow {
  return { code, status, rules: [], rank: 0 } as unknown as PickRow;
}

function picks(count: number, extra: Partial<StrategyPicksResult> = {}) {
  const rows = Array.from({ length: count }, (_, i) =>
    pick(`C${i}`, i < 2 ? "triggered" : "setup"),
  );
  return {
    strategy: { name: "CAN SLIM", rules: [] },
    picks: rows,
    totalCount: 151,
    asOf: "2026-11-03",
    ...extra,
  } as unknown as StrategyPicksResult;
}

describe("the Signals page", () => {
  beforeEach(() => getStrategyPicks.mockReset());

  it("is noindex, follow, with its own canonical and share card", async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({ strategy: "canslim" }),
    });
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates?.canonical).toMatch(/\/strategies\/canslim\/signals$/);
    expect((meta.openGraph as { url?: string } | undefined)?.url).toMatch(
      /\/strategies\/canslim\/signals$/,
    );
  });

  it("passes the anonymous slice of rows and the API's status counts", async () => {
    getStrategyPicks.mockResolvedValue(
      picks(40, { statusCounts: { triggered: 9, setup: 60, watch: 82, unknown: 0 } }),
    );
    const element = await StrategySignalsPage({
      params: Promise.resolve({ strategy: "canslim" }),
    });
    const props = (element as { props: Record<string, unknown> }).props as {
      rows: PickRow[];
      counts: unknown;
      total: number;
    };
    expect(props.rows).toHaveLength(SIGNALS_PUBLIC_ROWS);
    expect(props.counts).toEqual({ triggered: 9, setup: 60, watch: 82, unknown: 0 });
    expect(props.total).toBe(151);
  });

  it("passes available=false, not an empty list, when the read failed", async () => {
    getStrategyPicks.mockResolvedValue(null);
    const element = await StrategySignalsPage({
      params: Promise.resolve({ strategy: "canslim" }),
    });
    const props = (element as { props: Record<string, unknown> }).props as {
      available: boolean;
      rows: PickRow[];
    };
    expect(props.available).toBe(false);
    expect(props.rows).toEqual([]);
  });
});
