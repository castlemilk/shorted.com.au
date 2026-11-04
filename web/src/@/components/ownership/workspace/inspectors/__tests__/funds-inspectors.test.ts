/// <reference types="jest" />

import { changeInspectorContent, deltaWords } from "../change-inspector";
import { fundInspectorContent } from "../fund-inspector";
import { absentHoldingContent, holdingInspectorContent, weightMoveNote } from "../holding-inspector";
import type { FundRow, PortfolioHolding } from "../../../funds/fund-model";

const EM_DASH = String.fromCharCode(0x2014);
const MINUS = String.fromCharCode(0x2212);

const FUND: FundRow = {
  key: "A200",
  ticker: "A200",
  name: "BetaShares Australia 200 ETF",
  institutionSlug: "betashares",
  institutionName: "Betashares",
  sourceKind: "etf",
  pooled: false,
  asAt: "2026-10-31",
  sourceUrl: "https://example.com/a200.csv",
  holdings: 198,
  top10Pct: 44.2,
  sectorWeights: [],
  largest: [
    { code: "CBA", name: "Commonwealth Bank", weightPct: 9.1 },
    { code: "BHP", name: "BHP Group", weightPct: 8.4 },
    { code: "CSL", name: "CSL", weightPct: 4.5 },
    { code: "WBC", name: "Westpac", weightPct: null },
  ],
  aumAud: null,
};

const BHP: PortfolioHolding = {
  code: "BHP",
  name: "BHP Group",
  industry: "Materials",
  weightPct: 8.4,
  units: 25_400_000,
  valueAud: 1_000_000,
  sharesOnIssue: null,
  estCompanyPct: null,
  sharesOnIssueAsAt: "",
};

const HOLDING_INPUT = {
  fund: { ticker: "A200", name: FUND.name, asAt: "2026-10-31", sourceUrl: "" },
  holding: BHP,
  series: [],
};

describe("the fund inspector (spec 14.3, Funds)", () => {
  it("names the fund by its ticker, with its name beneath, and the kind badge", () => {
    const content = fundInspectorContent(FUND);
    expect(content.heading).toBe("A200");
    expect(content.subtitle).toBe("BetaShares Australia 200 ETF");
    expect(content.badges).toEqual(["ETF"]);
    expect(content.figure).toEqual({ value: "198", caption: "reported equities" });
  });

  it("badges a pooled fund and a super option as those", () => {
    expect(fundInspectorContent({ ...FUND, pooled: true }).badges).toEqual(["Pooled"]);
    expect(fundInspectorContent({ ...FUND, sourceKind: "super_phd" }).badges).toEqual(["Super option"]);
  });

  it("draws the three largest stated positions as bars, scaled to the largest", () => {
    const bars = fundInspectorContent(FUND).sections?.[0];
    expect(bars?.kind).toBe("bars");
    if (bars?.kind !== "bars") throw new Error("expected bars");
    expect(bars.items.map((bar) => bar.label)).toEqual(["CBA", "BHP", "CSL"]);
    expect(bars.items[0]!.share).toBe(1);
    expect(bars.items[1]!.share).toBeCloseTo(8.4 / 9.1, 6);
  });

  it("prints the top-10 sum and each bar's weight at two decimals (spec A4)", () => {
    const content = fundInspectorContent(FUND);
    expect(content.rows).toContainEqual({ label: "In the top 10", value: "44.20%" });
    const bars = content.sections?.[0];
    if (bars?.kind !== "bars") throw new Error("expected bars");
    expect(bars.items.map((bar) => bar.value)).toEqual(["9.10%", "8.40%", "4.50%"]);
  });

  it("links to the portfolio and the source file, and only for a safe address", () => {
    const content = fundInspectorContent(FUND);
    expect(content.primary).toEqual({ label: "Open portfolio →", href: "/ownership/funds/A200" });
    expect(content.links).toEqual([{ label: "View holdings source", href: "https://example.com/a200.csv", external: true }]);
    expect(fundInspectorContent({ ...FUND, sourceUrl: "javascript:alert(1)" }).links).toEqual([]);
  });

  it("links a super option by its encoded key, its slash and spaces included, and logos its manager", () => {
    const key = "vanguard/Vanguard Australian Shares Index Fund";
    const content = fundInspectorContent({ ...FUND, key, sourceKind: "super_phd", institutionSlug: "vanguard" });
    expect(content.primary).toEqual({
      label: "Open portfolio →",
      href: "/ownership/funds/vanguard%2FVanguard%20Australian%20Shares%20Index%20Fund",
    });
    expect(content.logo).toEqual({ kind: "holder", name: "Betashares", holderKind: "", holderKey: "vanguard" });
  });
});

describe("the holding inspector (spec 14.3, Fund page)", () => {
  it("names the holding in the fund, the company with its sector, and the weight as the figure", () => {
    const content = holdingInspectorContent(HOLDING_INPUT);
    expect(content.heading).toBe("BHP in A200");
    expect(content.subtitle).toBe("BHP Group · Materials");
    expect(content.figure).toEqual({ value: "8.40%", caption: "Weight in this fund" });
    expect(content.logo).toEqual({ kind: "stock", code: "BHP" });
  });

  it("prints the estimated share of the company as n/a unless both units and shares on issue are stated", () => {
    const content = holdingInspectorContent(HOLDING_INPUT);
    expect(content.rows).toContainEqual({ label: "Est. company shares held", value: "n/a" });
    expect(content.rows).toContainEqual({ label: "Reported shares", value: "25.4M" });
  });

  it("states the move between the two newest file dates that state a weight, with a true minus", () => {
    expect(
      weightMoveNote([
        { asAt: "2026-09-30", weightPct: 8.1 },
        { asAt: "2026-10-31", weightPct: 8.4 },
      ]),
    ).toBe("+0.3 percentage points vs 2026-09-30");
    expect(
      weightMoveNote([
        { asAt: "2026-09-30", weightPct: 8.7 },
        { asAt: "2026-10-31", weightPct: 8.39 },
      ]),
    ).toBe(`${MINUS}0.3 percentage points vs 2026-09-30`);
    expect(weightMoveNote([{ asAt: "2026-10-31", weightPct: 8.4 }])).toBeNull();
  });

  it("draws a file that could not be read as not read, and a file without the holding as n/a", () => {
    const content = absentHoldingContent({
      fund: { ticker: "A200", name: "BetaShares Australia 200 ETF", asAt: "2026-10-31", sourceUrl: "" },
      code: "BHP",
      series: [
        { asAt: "2026-09-30", weightPct: null, read: false },
        { asAt: "2026-10-31", weightPct: null, read: true },
      ],
    });
    const items = content.sections?.[0]?.kind === "series" ? content.sections[0].items : [];
    expect(items).toEqual([
      { label: "2026-09-30", value: "Not read just now" },
      { label: "2026-10-31", value: "n/a" },
    ]);
  });

  it("says a weight change can reflect price moves, and links the company's ownership as the primary action", () => {
    const content = holdingInspectorContent(HOLDING_INPUT);
    expect(content.footnote).toBe("Weight changes can reflect price moves.");
    expect(content.primary).toEqual({ label: "Open BHP ownership →", href: "/ownership/stocks/BHP" });
  });
});

describe("the change inspector (spec 14.3, Changes)", () => {
  const row = {
    code: "CBA",
    name: "Commonwealth Bank",
    industry: "Banks",
    weightFrom: 10.1,
    weightTo: 10.2,
    deltaPp: 0.1,
    valueFrom: null,
    valueTo: null,
    status: "continuing",
  };

  it("reads the two weights as the figure and the change in words beneath", () => {
    const content = changeInspectorContent({
      fund: { key: "asx:IOZ", ticker: "IOZ" },
      row,
      from: "2026-09-30",
      to: "2026-10-31",
      sourceFrom: "https://example.com/a.csv",
      sourceTo: "https://example.com/b.csv",
    });
    expect(content.heading).toBe("CBA in IOZ");
    // A rise takes the figure's tone, the whole figure with its sign and unit (spec 14.9).
    expect(content.figure).toEqual({ value: "10.10% → 10.20%", caption: "+0.10 percentage points", tone: "up" });
  });

  it("names the two files as evidence, keeping only the safe addresses", () => {
    const content = changeInspectorContent({
      fund: { key: "asx:IOZ", ticker: "IOZ" },
      row,
      from: "2026-09-30",
      to: "2026-10-31",
      sourceFrom: "https://example.com/a.csv",
      sourceTo: "javascript:void(0)",
    });
    expect(content.sections?.[0]).toEqual({
      title: "Evidence",
      kind: "list",
      items: [{ label: "Earlier file, 2026-09-30", href: "https://example.com/a.csv", external: true }],
    });
  });

  it("carries both notes the rule requires: weights move with prices, and newly reported is not a purchase", () => {
    const content = changeInspectorContent({
      fund: { key: "asx:IOZ", ticker: "IOZ" },
      row: { ...row, deltaPp: null, status: "new" },
      from: "2026-09-30",
      to: "2026-10-31",
      sourceFrom: "",
      sourceTo: "",
    });
    expect(content.note).toContain("Portfolio weight can change with prices, fund subscriptions and corporate actions.");
    expect(content.footnote).toBe("Newly reported means absent from the earlier file. It is not proof of a new purchase.");
    expect(content.figure?.caption).toBe("Held on one file date only");
    expect(content.primary).toEqual({
      label: "View fund history →",
      href: "/ownership/funds/asx%3AIOZ?tab=changes&from=2026-09-30&to=2026-10-31",
    });
  });

  it("words a change of zero as zero, never as a rise", () => {
    expect(deltaWords(0.001)).toBe("0.00 percentage points");
    expect(deltaWords(-0.2)).toBe(`${MINUS}0.20 percentage points`);
  });
});

describe("the inspector copy", () => {
  it("holds no em dash in anything the builders print", () => {
    const content = [fundInspectorContent(FUND), holdingInspectorContent(HOLDING_INPUT)];
    expect(JSON.stringify(content)).not.toContain(EM_DASH);
  });
});
