/// <reference types="jest" />

import type { StockFundSeriesPage } from "~/app/actions/ownershipDesk";
import type { StockPanelPage } from "../../../desk/stock-panel";
import { latestFundWeight, stockInspectorContent, stockNoticesHref } from "../stock-inspector";

const EM_DASH = String.fromCharCode(0x2014);

function panel(overrides: Partial<StockPanelPage> = {}): StockPanelPage {
  return {
    ok: true,
    code: "PLS",
    companyName: "PLS Group",
    industry: "Materials",
    disclosed: [],
    disclosedPct: 20,
    largest: [
      { name: "Alpha Capital", slug: "alpha", holderKey: "alpha", kind: "hedge_fund", votingPowerPct: 10, asAt: "2026-10-01" },
      { name: "Beta Super", slug: "beta", holderKey: "beta", kind: "super_fund", votingPowerPct: 5, asAt: "2026-09-01" },
    ],
    index: { pct: 3.2, asAt: "2026-10-30" },
    notices: [
      { announcedOn: "2026-10-01", form: "604", ceased: false, holderName: "Alpha Capital" },
      { announcedOn: "2026-09-01", form: "603", ceased: false, holderName: "Beta Super" },
    ],
    ...overrides,
  };
}

const series: StockFundSeriesPage = {
  ok: true,
  error: "",
  stockCode: "PLS",
  funds: [
    {
      institutionSlug: "ishares",
      institutionName: "iShares",
      fundName: "iShares Core S&P/ASX 200 ETF",
      fundCode: "IOZ",
      fundKey: "asx:IOZ",
      sourceKind: "etf",
      points: [
        { asAt: "2026-09-30", weightPct: 2.5, valueAud: null },
        { asAt: "2026-10-30", weightPct: 3.2, valueAud: null },
      ],
    },
    {
      institutionSlug: "betashares",
      institutionName: "Betashares",
      fundName: "Betashares Australia 200 ETF",
      fundCode: "A200",
      fundKey: "asx:A200",
      sourceKind: "etf",
      points: [{ asAt: "2026-10-30", weightPct: null, valueAud: null }],
    },
  ],
};

describe("stockInspectorContent (spec 14.3, Market map)", () => {
  it("draws nothing for a panel that did not answer, so an outage is never an empty company", () => {
    expect(stockInspectorContent(panel({ ok: false }), series)).toBeNull();
  });

  it("names the company, prints its disclosed figure, and states the basis in the note", () => {
    const content = stockInspectorContent(panel(), series);
    expect(content?.heading).toBe("PLS");
    // The name and the sector (spec 14.8); a stock with no industry reads "Other".
    expect(content?.subtitle).toBe("PLS Group · Materials");
    expect(stockInspectorContent(panel({ industry: "" }), series)?.subtitle).toBe("PLS Group · Other");
    expect(content?.figure).toEqual({ value: "20.00%", caption: "Disclosed by notices" });
    expect(content?.note).toBe(
      "Latest notice per holder. What the notices disclose, each interest counted once; not a share of the company.",
    );
  });

  it("labels a super option by its name, never by an empty ticker, with its institution as the row's title", () => {
    const superSeries: StockFundSeriesPage = {
      ...series,
      funds: [
        {
          institutionSlug: "hostplus",
          institutionName: "Hostplus",
          fundName: "Balanced Growth",
          fundCode: "",
          fundKey: "hostplus/Balanced Growth",
          sourceKind: "super_phd",
          points: [{ asAt: "2026-06-30", weightPct: 1.5, valueAud: null }],
        },
      ],
    };
    const content = stockInspectorContent(panel(), superSeries);
    const section = content?.sections?.find((s) => s.title === "Fund contributions");
    if (section?.kind !== "bars") throw new Error("expected bars");
    expect(section.items[0]?.label).toBe("Balanced Growth");
    expect(section.items[0]?.title).toBe("Hostplus");
  });

  it("draws the index lens's figure and caption, with the disclosed figure beside it", () => {
    const content = stockInspectorContent(panel(), series, "index");
    expect(content?.figure).toEqual({ value: "3.20%", caption: "Held by tracked index funds" });
    expect(content?.rows).toEqual([{ label: "Disclosed by notices", value: "20.00%" }]);
  });

    it("prints n/a, never zero, when no holder is disclosed", () => {
    expect(stockInspectorContent(panel({ disclosedPct: 0, largest: [] }), null)?.figure?.value).toBe("n/a");
  });

  it("draws the holders as bars against the largest, and each fund's latest weight, skipping a fund with none", () => {
    const content = stockInspectorContent(panel(), series);
    const holders = content?.sections?.find((s) => s.title === "Reported interests");
    expect(holders?.kind).toBe("bars");
    if (holders?.kind !== "bars") throw new Error("expected bars");
    expect(holders.items.map((b) => b.share)).toEqual([1, 0.5]);
    const funds = content?.sections?.find((s) => s.title === "Fund contributions");
    if (funds?.kind !== "bars") throw new Error("expected bars");
    expect(funds.items).toHaveLength(1);
    expect(funds.items[0]?.label).toBe("IOZ");
    expect(funds.items[0]?.value).toBe("3.20% at 2026-10-30");
  });

  it("never prints the short position (spec 13.8): the rail links it instead", () => {
    const content = stockInspectorContent(panel(), series);
    const labels = (content?.links ?? []).map((link) => link.label);
    expect(labels).toContain("Short interest →");
    expect(JSON.stringify(content?.rows)).not.toMatch(/short/i);
  });

  it("links the company's notices, its overview and its register", () => {
    const content = stockInspectorContent(panel(), series);
    expect(content?.primary).toEqual({ label: "Open ownership →", href: "/ownership/stocks/PLS" });
    const notices = content?.links?.find((l) => l.label === "All notices for PLS →");
    expect(notices?.href).toBe(stockNoticesHref("PLS"));
    expect(notices?.nofollow).toBe(true);
    expect(stockNoticesHref("PLS")).toBe("/ownership/notices?stock=PLS&window=all");
  });

  it("writes no em dash anywhere in its copy", () => {
    expect(JSON.stringify(stockInspectorContent(panel(), series))).not.toContain(EM_DASH);
  });
});

describe("latestFundWeight", () => {
  it("takes the newest point that states a weight", () => {
    expect(
      latestFundWeight([
        { asAt: "2026-10-30", weightPct: null, valueAud: null },
        { asAt: "2026-09-30", weightPct: 1.5, valueAud: null },
        { asAt: "2026-10-01", weightPct: 2, valueAud: null },
      ]),
    ).toEqual({ pct: 2, asAt: "2026-10-01" });
    expect(latestFundWeight([])).toBeNull();
  });
});
