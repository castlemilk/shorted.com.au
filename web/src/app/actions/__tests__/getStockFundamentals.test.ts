import { describe, it, expect } from "@jest/globals";
import { create } from "@bufbuild/protobuf";
import { TextEncoder, TextDecoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}
import { FundamentalsGrowthSchema } from "~/gen/shorts/v1alpha1/stock_pb";

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn() }));
jest.mock("next/cache", () => ({
  unstable_cache: jest.fn((loader: () => Promise<unknown>) => loader),
}));

import { mapGrowth } from "../getStockFundamentals";

describe("getStockFundamentals mapGrowth", () => {
  it("returns null without a growth row", () => {
    expect(mapGrowth(undefined, true)).toBeNull();
    expect(mapGrowth(create(FundamentalsGrowthSchema, {}), false)).toBeNull();
  });

  it("carries the half basis and half-on-half figures, honouring has_* flags", () => {
    const g = mapGrowth(
      create(FundamentalsGrowthSchema, {
        basisPeriodType: "half",
        revenueBasisPeriodType: "half",
        revenueYoyPct: 22,
        hasRevenueYoy: true,
        epsYoyPct: 31,
        hasEpsYoy: true,
        revenueHalfYoyPct: 22,
        hasRevenueHalfYoy: true,
        // Present as 0 with no flag: not known, so null rather than 0.
        epsHalfYoyPct: 0,
        hasEpsHalfYoy: false,
        halfLatestPeriodEnd: "2025-12-31",
      }),
      true,
    );
    expect(g).toEqual({
      basisPeriodType: "half",
      revenueBasisPeriodType: "half",
      revenueYoyPct: 22,
      epsYoyPct: 31,
      revenueHalfYoyPct: 22,
      epsHalfYoyPct: null,
      halfLatestPeriodEnd: "2025-12-31",
    });
  });

  it("leaves the half fields empty for an annual/TTM row", () => {
    const g = mapGrowth(
      create(FundamentalsGrowthSchema, {
        basisPeriodType: "ttm",
        revenueYoyPct: 5,
        hasRevenueYoy: true,
      }),
      true,
    );
    expect(g?.revenueBasisPeriodType).toBe("");
    expect(g?.revenueHalfYoyPct).toBeNull();
    expect(g?.epsHalfYoyPct).toBeNull();
    expect(g?.halfLatestPeriodEnd).toBe("");
  });
});
