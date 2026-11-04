/// <reference types="jest" />

import type { FundSeriesPoint, FundStockChange, StockFundSeriesPage } from "~/app/actions/ownershipDesk";
import type { StockPanelPage } from "../../../desk/stock-panel";
import type { BandHolder } from "../connection-inspector";
import { connectionInspectorContent } from "../connection-inspector";
import { formatShareChange, formatSharesSince, stockInspectorContent } from "../stock-inspector";
import type { InspectorBar, InspectorSection } from "../../inspector-types";

const EM_DASH = String.fromCharCode(0x2014);

function panel(overrides: Partial<StockPanelPage> = {}): StockPanelPage {
  return {
    ok: true,
    code: "PLS",
    companyName: "PLS Group",
    industry: "Materials",
    disclosed: [
      { kind: "hedge_fund", pct: 10, holders: 1 },
      { kind: "super_fund", pct: 5, holders: 2 },
    ],
    disclosedPct: 15,
    largest: [{ name: "Alpha Capital", slug: "alpha", holderKey: "alpha", kind: "hedge_fund", votingPowerPct: 10, asAt: "2026-10-01" }],
    index: { pct: 3.2, asAt: "2026-10-30" },
    notices: [],
    ...overrides,
  };
}

const point = (asAt: string, units: number | null, valueAud: number | null = null, weightPct: number | null = null): FundSeriesPoint => ({
  asAt,
  units,
  valueAud,
  weightPct,
});

/** A fund's own comparison, every figure unknown unless given. */
const change = (over: Partial<FundStockChange> = {}): FundStockChange => ({
  startDate: null,
  startUnits: null,
  endDate: null,
  endUnits: null,
  unitsChange: null,
  changeValueAud: null,
  ...over,
});

function fund(points: FundSeriesPoint[], fundCode = "IOZ", over: Partial<FundStockChange> = {}): StockFundSeriesPage["funds"][number] {
  return {
    institutionSlug: "ishares",
    institutionName: "iShares",
    fundName: "iShares Core S&P/ASX 200 ETF",
    fundCode,
    fundKey: `asx:${fundCode}`,
    sourceKind: "etf",
    points,
    change: change(over),
  };
}

function series(funds: StockFundSeriesPage["funds"]): StockFundSeriesPage {
  return { ok: true, error: "", stockCode: "PLS", fundFrom: "2026-08-03", fundTo: "2026-10-31", funds };
}

function section(content: ReturnType<typeof stockInspectorContent>, title: string): InspectorSection | undefined {
  return content?.sections?.find((s) => s.title === title);
}

describe("the stock rail's By kind bars (spec 14.10)", () => {
  it("draws one bar per disclosed kind, sized to the largest, with its holders", () => {
    const content = stockInspectorContent(panel(), null, "disclosed");
    const bars = section(content, "By kind");
    expect(bars?.kind).toBe("bars");
    const items = (bars as Extract<InspectorSection, { kind: "bars" }>).items;
    expect(items.map((bar) => bar.label)).toEqual([expect.any(String), expect.any(String)]);
    expect(items[0]).toMatchObject({ share: 1, detail: "1 holder" });
    expect(items[1]).toMatchObject({ share: 0.5, detail: "2 holders" });
  });

  it("draws no kind section when the panel discloses no kind", () => {
    const content = stockInspectorContent(panel({ disclosed: [] }), null);
    expect(section(content, "By kind")).toBeUndefined();
  });
});

describe("the fund contributions' shares and value (spec 14.10)", () => {
  it("prints each fund's value at its end file and its change in shares since its start file", () => {
    const content = stockInspectorContent(
      panel(),
      series([
        fund([point("2026-08-03", 1_000_000, 4e7, 2.5), point("2026-10-30", 1_250_000, 6e7, 3.2)], "IOZ", {
          startDate: "2026-08-03",
          startUnits: 1_000_000,
          endDate: "2026-10-30",
          endUnits: 1_250_000,
          unitsChange: 250_000,
          changeValueAud: 1e7,
        }),
        fund([point("2026-10-30", 500, null, 1)], "A200"),
      ]),
      "disclosed",
    );
    const bars = section(content, "Fund contributions") as Extract<InspectorSection, { kind: "bars" }>;
    const first = bars.items[0] as InspectorBar;
    expect(first.value).toBe("3.20% at 2026-10-30");
    expect(first.detail).toBe("Value $60.0M · +250,000 shares since 2026-08-03");
    // A fund with no comparison states its value as n/a when its end file has none, and its change as n/a.
    expect(bars.items[1]!.detail).toBe("Value n/a · n/a");
  });

  it("values the fund at the end file its comparison names, never at its newest point", () => {
    const content = stockInspectorContent(
      panel(),
      series([
        fund([point("2026-06-30", 1_000_000, 5e7, 2), point("2026-09-30", 1_400_000, 6e7, 2.5), point("2026-10-30", 1_500_000, 9e7, 3)], "IOZ", {
          startDate: "2026-06-30",
          startUnits: 1_000_000,
          endDate: "2026-09-30",
          endUnits: 1_400_000,
          unitsChange: 400_000,
        }),
      ]),
    );
    const bars = section(content, "Fund contributions") as Extract<InspectorSection, { kind: "bars" }>;
    expect(bars.items[0]!.detail).toBe("Value $60.0M · +400,000 shares since 2026-06-30");
    expect(bars.items[0]!.value).toBe("3.00% at 2026-10-30");
  });

  it("prints n/a for the value when the end file names no point, and for the change when it is unknown", () => {
    const content = stockInspectorContent(
      panel(),
      series([fund([point("2026-08-03", 1_000_000, 4e7, 2.5), point("2026-10-30", 1_250_000, 6e7, 3.2)], "IOZ", { endDate: "2026-10-15", endUnits: 9 })]),
    );
    const bars = section(content, "Fund contributions") as Extract<InspectorSection, { kind: "bars" }>;
    expect(bars.items[0]!.detail).toBe("Value n/a · n/a");
  });

  it("prints a change in shares with a true minus, and n/a without one", () => {
    expect(formatShareChange(250_000)).toBe("+250,000 shares");
    expect(formatShareChange(-12_345)).toBe(`${"−"}12,345 shares`);
    expect(formatShareChange(0)).toBe("0 shares");
    expect(formatShareChange(null)).toBe("n/a");
  });

  it("dates a change by the file it runs from, and is n/a without the change", () => {
    expect(formatSharesSince(250_000, "2026-08-03")).toBe("+250,000 shares since 2026-08-03");
    expect(formatSharesSince(-12_345, null)).toBe(`${"−"}12,345 shares`);
    expect(formatSharesSince(null, "2026-08-03")).toBe("n/a");
  });
});

describe("the connection rail's holders (spec 14.10)", () => {
  const holders: BandHolder[] = [
    { slug: "aware", name: "Aware Super", exposureAud: 4e8, holdings: 2 },
    { slug: "", name: "Unlisted fund", exposureAud: null, holdings: 1 },
  ];

  function connection(over: Partial<Parameters<typeof connectionInspectorContent>[0]> = {}) {
    return connectionInspectorContent({
      holderKind: "super_fund",
      sector: "Materials",
      companies: [{ code: "BHP", name: "BHP", pct: 5, marketCap: 1e9, latestNotice: "2026-10-01" }],
      total: 1,
      ...over,
    });
  }

  it("lists the band's holders by name, linking to the holder's page, with exposure and holdings", () => {
    const content = connection({ holders });
    const block = section(content, "Holders on this connection") as Extract<InspectorSection, { kind: "bars" }>;
    expect(block.kind).toBe("bars");
    expect(block.items[0]).toMatchObject({ label: "Aware Super", href: "/ownership/aware", detail: "2 holdings", share: 1 });
    expect(block.items[0]!.value).toBe("$400.0M");
    // A holder with no slug is named without a link, and an unknown exposure is n/a, never zero.
    expect(block.items[1]).toMatchObject({ label: "Unlisted fund", detail: "1 holding", value: "n/a", share: 0 });
    expect(block.items[1]!.href).toBeUndefined();
  });

  it("draws no holders section when the band's holders were not read, or the band has none", () => {
    expect(section(connection({ holders: null }), "Holders on this connection")).toBeUndefined();
    expect(section(connection({ holders: [] }), "Holders on this connection")).toBeUndefined();
    expect(section(connection(), "Holders on this connection")).toBeUndefined();
  });
});

describe("the new rail copy", () => {
  it("never prints an em dash", () => {
    const content = stockInspectorContent(
      panel(),
      series([
        fund([point("2026-08-03", 1, 1, 1), point("2026-10-30", 2, 2, 2)], "IOZ", {
          startDate: "2026-08-03",
          startUnits: 1,
          endDate: "2026-10-30",
          endUnits: 2,
          unitsChange: 1,
          changeValueAud: 1,
        }),
      ]),
      "disclosed",
    );
    expect(JSON.stringify(content)).not.toContain(EM_DASH);
  });
});
