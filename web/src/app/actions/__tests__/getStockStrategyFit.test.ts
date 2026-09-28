import { describe, it, expect } from "@jest/globals";

const mockGetStockStrategyFit = jest.fn();
const mockListStrategies = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getStockStrategyFit: (...args: unknown[]) => mockGetStockStrategyFit(...args),
    listStrategies: (...args: unknown[]) => mockListStrategies(...args),
  })),
}));
jest.mock("~/gen/shorts/v1alpha1/strategies_pb", () => ({ StrategyService: {} }));

type CacheCall = [() => Promise<unknown>, string[], { revalidate: number; tags: string[] }];
const cacheCalls: CacheCall[] = [];
jest.mock("next/cache", () => ({
  unstable_cache: (
    loader: () => Promise<unknown>,
    key: string[],
    opts: { revalidate: number; tags: string[] },
  ) => {
    cacheCalls.push([loader, key, opts]);
    return loader;
  },
}));

import {
  STRATEGY_FIT_TIMEOUT_MS,
  getStockStrategyFit,
  humaniseRuleId,
  mapStockStrategyFit,
} from "../getStockStrategyFit";

function fitResponse() {
  return {
    stockCode: "BHP",
    asOf: "2026-09-25",
    inUniverse: true,
    fits: [
      {
        strategyId: "zanger-breakout",
        strategyName: "Zanger Breakout",
        status: "setup",
        score: 71.6,
        rank: 4,
        totalCount: 37,
        rules: [
          { ruleId: "eps_growth", status: "pass", detail: "EPS +31%" },
          { ruleId: "breakout", status: "weird", detail: "" },
        ],
      },
      {
        strategyId: "canslim",
        strategyName: "CAN SLIM",
        status: "none",
        score: 0,
        rank: 0,
        totalCount: 12,
        rules: [],
      },
    ],
  };
}

describe("getStockStrategyFit", () => {
  beforeEach(() => {
    cacheCalls.length = 0;
    mockGetStockStrategyFit.mockReset();
    mockListStrategies.mockReset();
  });

  it("caches under ['stock-strategy-fit', code, 'v1'] for an hour with the strategy-picks tag", async () => {
    mockGetStockStrategyFit.mockResolvedValue(fitResponse());
    mockListStrategies.mockResolvedValue({
      strategies: [
        { id: "zanger-breakout", rules: [{ id: "eps_growth", title: "Earnings growth" }] },
      ],
    });
    const fit = await getStockStrategyFit("bhp");

    const [, key, opts] = cacheCalls.find(([, k]) => k[0] === "stock-strategy-fit")!;
    expect(key).toEqual(["stock-strategy-fit", "BHP", "v1"]);
    expect(opts.revalidate).toBe(3600);
    expect(opts.tags).toEqual(["strategy-picks", "shorts-data", "stock-page:strategy-fit:bhp"]);

    // A 4 s abort on the call.
    const [request, callOptions] = mockGetStockStrategyFit.mock.calls[0] as [
      unknown,
      { signal: AbortSignal; timeoutMs: number },
    ];
    expect(request).toEqual({ stockCode: "BHP" });
    expect(callOptions.signal).toBeInstanceOf(AbortSignal);
    expect(callOptions.timeoutMs).toBe(STRATEGY_FIT_TIMEOUT_MS);
    expect(STRATEGY_FIT_TIMEOUT_MS).toBe(4000);

    expect(fit.fits[0]).toMatchObject({
      strategyId: "zanger-breakout",
      status: "setup",
      score: 71.6,
      rank: 4,
      totalCount: 37,
      ruleColumns: [
        { id: "eps_growth", title: "Earnings growth" },
        { id: "breakout", title: "Breakout" },
      ],
    });
    expect(fit.fits[0]!.rules[1]!.status).toBe("unknown");
    expect(fit.fits[1]).toMatchObject({ status: "none", score: null, rank: null });
  });

  it("aborts a call that outlives 4 s", async () => {
    jest.useFakeTimers();
    try {
      mockListStrategies.mockResolvedValue({ strategies: [] });
      mockGetStockStrategyFit.mockImplementation(
        (_req: unknown, { signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const pending = getStockStrategyFit("BHP");
      const assertion = expect(pending).rejects.toThrow("aborted");
      await jest.advanceTimersByTimeAsync(STRATEGY_FIT_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it("throws inside the cache on failure (never cached): the caller hides the card", async () => {
    mockGetStockStrategyFit.mockRejectedValue(new Error("unimplemented"));
    mockListStrategies.mockResolvedValue({ strategies: [] });
    await expect(getStockStrategyFit("BHP")).rejects.toThrow("unimplemented");
    const [loader] = cacheCalls.find(([, k]) => k[0] === "stock-strategy-fit")!;
    await expect(loader()).rejects.toThrow("unimplemented");
  });

  it("degrades missing rule titles to readable ids without failing the fit", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockGetStockStrategyFit.mockResolvedValue(fitResponse());
    mockListStrategies.mockRejectedValue(new Error("down"));
    const fit = await getStockStrategyFit("BHP");
    expect(fit.fits[0]!.ruleColumns[0]).toEqual({ id: "eps_growth", title: "Eps growth" });
    warn.mockRestore();
  });
});

describe("mapStockStrategyFit", () => {
  it("drops fits without an id and reads an empty universe as no fits", () => {
    expect(
      mapStockStrategyFit("X", { asOf: "", inUniverse: false, fits: [] }),
    ).toEqual({ stockCode: "X", asOf: "", inUniverse: false, fits: [] });
    expect(
      mapStockStrategyFit("X", { fits: [{ strategyId: "", status: "setup" }] }).fits,
    ).toEqual([]);
  });

  it("humanises a rule id", () => {
    expect(humaniseRuleId("revenue_growth")).toBe("Revenue growth");
    expect(humaniseRuleId("")).toBe("Rule");
  });
});
