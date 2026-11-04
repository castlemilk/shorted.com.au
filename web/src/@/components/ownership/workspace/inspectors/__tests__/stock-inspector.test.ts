/// <reference types="jest" />

import type { StockFundSeriesPage } from "~/app/actions/ownershipDesk";
import { formatAmount } from "~/@/lib/fundamentals/format";
import type { StockPanelPage } from "../../../desk/stock-panel";
import {
  latestFundWeight,
  stockInspectorContent,
  stockNoticesHref,
  stockReading,
  stockWeekHref,
  type StockNoticeWindow,
} from "../stock-inspector";

const EM_DASH = String.fromCharCode(0x2014);

const NO_CHANGE = {
  startDate: null,
  startUnits: null,
  endDate: null,
  endUnits: null,
  unitsChange: null,
  changeValueAud: null,
};

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
  fundFrom: "2026-09-30",
  fundTo: "2026-10-30",
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
      change: NO_CHANGE,
    },
    {
      institutionSlug: "betashares",
      institutionName: "Betashares",
      fundName: "Betashares Australia 200 ETF",
      fundCode: "A200",
      fundKey: "asx:A200",
      sourceKind: "etf",
      points: [{ asAt: "2026-10-30", weightPct: null, valueAud: null }],
      change: NO_CHANGE,
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

  it("prints a super option's stated value from its newest point, with no comparison to read it from", () => {
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
          points: [
            { asAt: "2025-12-31", weightPct: 1.2, valueAud: 90_000_000 },
            { asAt: "2026-06-30", weightPct: 1.5, valueAud: 120_000_000 },
          ],
          change: NO_CHANGE,
        },
      ],
    };
    const content = stockInspectorContent(panel(), superSeries);
    const section = content?.sections?.find((s) => s.title === "Fund contributions");
    if (section?.kind !== "bars") throw new Error("expected bars");
    expect(section.items[0]?.detail).toContain("Value $120.0M");
    expect(section.items[0]?.detail).toContain("n/a");
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
          change: NO_CHANGE,
        },
      ],
    };
    const content = stockInspectorContent(panel(), superSeries);
    const section = content?.sections?.find((s) => s.title === "Fund contributions");
    if (section?.kind !== "bars") throw new Error("expected bars");
    expect(section.items[0]?.label).toBe("Balanced Growth");
    expect(section.items[0]?.title).toBe("Hostplus");
    expect(section.items[0]?.detail).toBe("Value n/a · n/a");
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

  it("prints the headline and every bar at two decimals, where a notice states four (spec A4)", () => {
    // A fund's weight in a file can state more than two decimals (3.2345%), so the fund bar is held to the same rule.
    const fourDp: StockFundSeriesPage = {
      ...series,
      funds: [
        {
          ...series.funds[0]!,
          points: [{ asAt: "2026-10-30", weightPct: 3.2345, valueAud: null }],
        },
      ],
    };
    const content = stockInspectorContent(
      panel({
        disclosed: [{ kind: "hedge_fund", pct: 13.131, holders: 2 }],
        disclosedPct: 13.131,
        largest: [
          { name: "Alpha Capital", slug: "alpha", holderKey: "alpha", kind: "hedge_fund", votingPowerPct: 19.4336, asAt: "2026-10-01" },
          { name: "Beta Super", slug: "beta", holderKey: "beta", kind: "super_fund", votingPowerPct: 5, asAt: "2026-09-01" },
        ],
        index: { pct: 3.2, asAt: "2026-10-30" },
      }),
      fourDp,
    );
    expect(content?.figure).toEqual({ value: "13.13%", caption: "Disclosed by notices" });
    expect(content?.rows).toEqual([{ label: "Index funds tracked", value: "3.20%" }]);
    const holders = content?.sections?.find((s) => s.title === "Reported interests");
    if (holders?.kind !== "bars") throw new Error("expected bars");
    expect(holders.items.map((b) => b.value)).toEqual(["19.43%", "5.00%"]);
    const kind = content?.sections?.find((s) => s.title === "By kind");
    if (kind?.kind !== "bars") throw new Error("expected bars");
    expect(kind.items[0]?.value).toBe("13.13%");
    const funds = content?.sections?.find((s) => s.title === "Fund contributions");
    if (funds?.kind !== "bars") throw new Error("expected bars");
    expect(funds.items[0]?.value).toBe("3.23% at 2026-10-30");
  });

  it("prints a measured zero in a bar as 0.00%, and n/a for a figure the panel does not hold", () => {
    const content = stockInspectorContent(
      panel({
        disclosed: [{ kind: "super_fund", pct: 0, holders: 1 }],
        largest: [{ name: "Gamma", slug: "gamma", holderKey: "gamma", kind: "super_fund", votingPowerPct: null, asAt: "" }],
      }),
      null,
    );
    const holders = content?.sections?.find((s) => s.title === "Reported interests");
    if (holders?.kind !== "bars") throw new Error("expected bars");
    expect(holders.items[0]?.value).toBe("n/a");
    const kind = content?.sections?.find((s) => s.title === "By kind");
    if (kind?.kind !== "bars") throw new Error("expected bars");
    expect(kind.items[0]?.value).toBe("0.00%");
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

describe("the By kind section (spec 14.10)", () => {
  it("draws the panel's disclosed segments as bars against the largest, labelled by kind and counted by holders", () => {
    const content = stockInspectorContent(
      panel({
        disclosed: [
          { kind: "hedge_fund", pct: 10, holders: 1 },
          { kind: "super_fund", pct: 5, holders: 2 },
        ],
      }),
      null,
    );
    const section = content?.sections?.find((s) => s.title === "By kind");
    if (section?.kind !== "bars") throw new Error("expected bars");
    expect(section.items.map((b) => b.share)).toEqual([1, 0.5]);
    expect(section.items[1]?.detail).toBe("2 holders");
    expect(section.items[0]?.detail).toBe("1 holder");
  });

  it("draws no By kind section when the panel discloses no segment", () => {
    const content = stockInspectorContent(panel({ disclosed: [] }), null);
    expect(content?.sections?.find((s) => s.title === "By kind")).toBeUndefined();
  });
});

describe("the fund contributions' change (spec 14.10)", () => {
  const withChange = (change: Partial<StockFundSeriesPage["funds"][number]["change"]>, points = series.funds[0]!.points) => ({
    ...series,
    funds: [{ ...series.funds[0]!, points, change: { ...NO_CHANGE, ...change } }],
  });

  it("prints the fund's value at its end file and its change in shares from its start file", () => {
    const content = stockInspectorContent(
      panel(),
      withChange(
        { startDate: "2026-09-30", startUnits: 1_000_000, endDate: "2026-10-30", endUnits: 1_400_000, unitsChange: 400_000, changeValueAud: 1e7 },
        [
          { asAt: "2026-09-30", weightPct: 2.5, valueAud: 5e7, units: 1_000_000 },
          { asAt: "2026-10-30", weightPct: 3.2, valueAud: 6e7, units: 1_400_000 },
        ],
      ),
    );
    const funds = content?.sections?.find((s) => s.title === "Fund contributions");
    if (funds?.kind !== "bars") throw new Error("expected bars");
    expect(funds.items[0]?.detail).toBe(`Value ${formatAmount(6e7, "AUD")} · +400,000 shares since 2026-09-30`);
  });

  it("prints n/a for a change the comparison does not state, never a figure the map did not compare", () => {
    const content = stockInspectorContent(panel(), withChange({ endDate: "2026-10-30", endUnits: 1_400_000 }));
    const funds = content?.sections?.find((s) => s.title === "Fund contributions");
    if (funds?.kind !== "bars") throw new Error("expected bars");
    expect(funds.items[0]?.detail).toBe("Value n/a · n/a");
  });

  it("prints A$0 for a position that has left the fund by its end file, beside its stated change", () => {
    const content = stockInspectorContent(
      panel(),
      withChange(
        { startDate: "2026-09-30", startUnits: 250_000, endDate: "2026-10-30", endUnits: 0, unitsChange: -250_000, changeValueAud: -1e7 },
        [{ asAt: "2026-09-30", weightPct: 2.5, valueAud: 1e7, units: 250_000 }],
      ),
    );
    const funds = content?.sections?.find((s) => s.title === "Fund contributions");
    if (funds?.kind !== "bars") throw new Error("expected bars");
    expect(funds.items[0]?.detail).toBe(`Value ${formatAmount(0, "AUD")} · −250,000 shares since 2026-09-30`);
  });

  it("values the end file the comparison names, not the fund's newest file", () => {
    const points = [
      { asAt: "2026-09-30", weightPct: 2.5, valueAud: 6e7, units: 1_400_000 },
      { asAt: "2026-10-30", weightPct: 3.2, valueAud: 9e7, units: 1_500_000 },
    ];
    const content = stockInspectorContent(
      panel(),
      withChange({ startDate: "2026-09-01", endDate: "2026-09-30", endUnits: 1_400_000, unitsChange: 1, startUnits: 1_399_999 }, points),
    );
    const funds = content?.sections?.find((s) => s.title === "Fund contributions");
    if (funds?.kind !== "bars") throw new Error("expected bars");
    expect(funds.items[0]?.detail).toContain(formatAmount(6e7, "AUD"));
    expect(funds.items[0]?.detail).not.toContain(formatAmount(9e7, "AUD"));
  });
});

/** A tracked fund with its own change over the window, for the reading's index change and mover. */
function trackedFund(overrides: Partial<StockFundSeriesPage["funds"][number]> = {}): StockFundSeriesPage["funds"][number] {
  return {
    institutionSlug: "ishares",
    institutionName: "iShares",
    fundName: "iShares Core S&P/ASX 200 ETF",
    fundCode: "IOZ",
    fundKey: "asx:IOZ",
    sourceKind: "etf",
    points: [
      { asAt: "2026-09-30", weightPct: 2.5, valueAud: null, units: 1000000 },
      { asAt: "2026-10-30", weightPct: 2.62, valueAud: null, units: 2200000 },
    ],
    change: {
      startDate: "2026-09-30",
      startUnits: 1000000,
      endDate: "2026-10-30",
      endUnits: 2200000,
      unitsChange: 1200000,
      changeValueAud: null,
    },
    ...overrides,
  };
}

function seriesWith(funds: StockFundSeriesPage["funds"]): StockFundSeriesPage {
  return { ok: true, error: "", stockCode: "PLS", fundFrom: "2026-09-30", fundTo: "2026-10-30", funds };
}

function noticeOn(announcedOn: string): StockPanelPage["notices"][number] {
  return { announcedOn, form: "604", ceased: false, holderName: "Alpha Capital" };
}

/** The desk's dated window: the 91 days ending 2026-10-31, as the desk counts a chip from the newest notice. */
const WINDOW_91: StockNoticeWindow = { since: "2026-08-03", until: "2026-10-31", days: 91 };

describe("stockReading (spec 14.1, backlog C1)", () => {
  it("leads with the index share, the largest fund move and the notices in the window", () => {
    const page = panel({
      index: { pct: 3.41, asAt: "2026-10-30" },
      notices: [noticeOn("2026-10-27"), noticeOn("2026-10-20"), noticeOn("2026-09-01")],
    });
    expect(stockReading(page, seriesWith([trackedFund()]), "index", WINDOW_91)).toBe(
      "Index funds hold 3.41%; iShares added 1,200,000 shares since 2026-09-30; 3 notices in 91 days, the last on 2026-10-27.",
    );
  });

  it("never prints a change in the index share, whatever the funds state (the fund weights are not that share)", () => {
    // Each fund's weight is its share of its own portfolio, which moves with every price in the index.
    // Its change is not the index's change in its share of the company, so no pp clause is printed.
    const page = panel({ index: { pct: 3.41, asAt: "2026-10-30" }, notices: [] });
    const reading = stockReading(page, seriesWith([trackedFund()]), "index", WINDOW_91);
    expect(reading).toBe("Index funds hold 3.41%; iShares added 1,200,000 shares since 2026-09-30.");
    expect(reading).not.toContain("pp");
    expect(reading).not.toContain("up ");
    expect(reading).not.toContain("down ");
  });

  it("states the disclosed share under the notices lens, and the same fund move", () => {
    const page = panel({
      disclosedPct: 19.43,
      index: { pct: 3.41, asAt: "2026-10-30" },
      notices: [noticeOn("2026-10-27"), noticeOn("2026-10-20"), noticeOn("2026-09-01")],
    });
    expect(stockReading(page, seriesWith([trackedFund()]), "disclosed", WINDOW_91)).toBe(
      "Notices disclose 19.43%; iShares added 1,200,000 shares since 2026-09-30; 3 notices in 91 days, the last on 2026-10-27.",
    );
  });

  it("says a fund that reduced its shares by the shares that left", () => {
    const fund = trackedFund({
      points: [
        { asAt: "2026-09-30", weightPct: 2.62, valueAud: null, units: 2200000 },
        { asAt: "2026-10-30", weightPct: 2.5, valueAud: null, units: 1700000 },
      ],
      change: { ...trackedFund().change, unitsChange: -500000 },
    });
    expect(
      stockReading(panel({ index: { pct: 3.41, asAt: "2026-10-30" }, notices: [] }), seriesWith([fund]), "index", WINDOW_91),
    ).toBe("Index funds hold 3.41%; iShares reduced by 500,000 shares since 2026-09-30.");
  });

  it("names the ticker when the fund has no manager on record", () => {
    expect(
      stockReading(
        panel({ index: { pct: 3.41, asAt: "" }, notices: [] }),
        seriesWith([trackedFund({ institutionName: "" })]),
        "index",
        WINDOW_91,
      ),
    ).toBe("Index funds hold 3.41%; IOZ added 1,200,000 shares since 2026-09-30.");
  });

  it("drops exactly the clause a figure it does not have leaves out", () => {
    const notices = [noticeOn("2026-10-27"), noticeOn("2026-10-20"), noticeOn("2026-09-01")];
    // No index share: the figure is the only thing it leads with, so the fund move and the notices lead.
    expect(
      stockReading(panel({ index: { pct: null, asAt: "" }, notices }), seriesWith([trackedFund()]), "index", WINDOW_91),
    ).toBe("iShares added 1,200,000 shares since 2026-09-30; 3 notices in 91 days, the last on 2026-10-27.");
    // No fund series: the figure and the notices remain.
    expect(stockReading(panel({ index: { pct: 3.41, asAt: "" }, notices }), null, "index", WINDOW_91)).toBe(
      "Index funds hold 3.41%; 3 notices in 91 days, the last on 2026-10-27.",
    );
    // A fund with no unit change drops the mover clause.
    expect(
      stockReading(
        panel({ index: { pct: 3.41, asAt: "" }, notices }),
        seriesWith([trackedFund({ change: { ...trackedFund().change, unitsChange: null } })]),
        "index",
        WINDOW_91,
      ),
    ).toBe("Index funds hold 3.41%; 3 notices in 91 days, the last on 2026-10-27.");
    // No notice in the window: the notices clause goes.
    expect(stockReading(panel({ index: { pct: 3.41, asAt: "" }, notices: [] }), seriesWith([trackedFund()]), "index", WINDOW_91)).toBe(
      "Index funds hold 3.41%; iShares added 1,200,000 shares since 2026-09-30.",
    );
  });

  it("names no notice clause when the stock's notices are all older than the desk's window", () => {
    // The window is the desk's, counted from the market's newest notice. A stock whose last notice is from
    // 2024 has none in it, even though that notice is its own newest.
    const stale = panel({ index: { pct: 3.41, asAt: "" }, notices: [noticeOn("2024-03-12")] });
    expect(stockReading(stale, null, "index", WINDOW_91)).toBe("Index funds hold 3.41%.");
  });

  it("names no notice clause when the desk could not date the window", () => {
    const page = panel({ index: { pct: 3.41, asAt: "" }, notices: [noticeOn("2026-10-27")] });
    expect(stockReading(page, null, "index", null)).toBe("Index funds hold 3.41%.");
  });

  it("counts the notices between the brushed pair when the link names one", () => {
    const page = panel({
      index: { pct: 3.41, asAt: "" },
      notices: [noticeOn("2026-10-27"), noticeOn("2026-10-20"), noticeOn("2026-09-01")],
    });
    expect(
      stockReading(page, null, "index", { since: "2026-10-01", until: "2026-10-31", days: null }),
    ).toBe("Index funds hold 3.41%; 2 notices between 2026-10-01 and 2026-10-31, the last on 2026-10-27.");
  });

  it("withholds the notice count when the panel's five latest may hide more notices in the window", () => {
    const listed = [noticeOn("2026-10-27"), noticeOn("2026-10-20"), noticeOn("2026-10-10"), noticeOn("2026-09-01"), noticeOn("2026-08-10")];
    // The oldest of the five is inside the window, so the list may be cut short: no count.
    expect(stockReading(panel({ index: { pct: 3.41, asAt: "" }, notices: listed }), null, "index", WINDOW_91)).toBe(
      "Index funds hold 3.41%.",
    );
    // The oldest is before the window, so the four in it are all there is: the count is complete.
    const older = [...listed.slice(0, 4), noticeOn("2026-06-01")];
    expect(stockReading(panel({ index: { pct: 3.41, asAt: "" }, notices: older }), null, "index", WINDOW_91)).toBe(
      "Index funds hold 3.41%; 4 notices in 91 days, the last on 2026-10-27.",
    );
  });

  it("has no reading when no figure is stated, and never prints n/a or a zero for a missing one", () => {
    expect(stockReading(panel({ disclosedPct: 0, notices: [] }), null, "disclosed", WINDOW_91)).toBeUndefined();
    expect(stockReading(panel({ ok: false }), null, "disclosed", WINDOW_91)).toBeUndefined();
    const withoutIndex = stockReading(panel({ index: { pct: null, asAt: "" }, disclosedPct: 0 }), null, "index", WINDOW_91);
    expect(withoutIndex).toBe("2 notices in 91 days, the last on 2026-10-01.");
    expect(withoutIndex).not.toMatch(/n\/a|\b0(\.0+)?%/);
  });

  it("is the reading the content carries first, from the window the page passes", () => {
    const content = stockInspectorContent(
      panel({ index: { pct: 3.41, asAt: "" }, notices: [noticeOn("2026-10-27")] }),
      null,
      "index",
      WINDOW_91,
    );
    expect(content?.reading).toBe("Index funds hold 3.41%; 1 notice in 91 days, the last on 2026-10-27.");
    const unread = stockInspectorContent(panel({ index: { pct: 3.41, asAt: "" }, notices: [noticeOn("2026-10-27")] }), null, "index", null);
    expect(unread?.reading).toBe("Index funds hold 3.41%.");
  });
});

describe("the notices by week section (backlog C6)", () => {
  const released = ["2026-10-20", "2026-10-21", "2026-08-03"];
  const weekly = { asOf: "2026-10-31", released };

  it("draws the strip after the fund contributions and before the recent activity, with a week per link", () => {
    const content = stockInspectorContent(panel(), series, "disclosed", null, weekly);
    expect(content?.sections?.map((section) => section.title)).toEqual([
      "Reported interests",
      "Fund contributions",
      "Notices by week",
      "Recent activity",
    ]);
    const strip = content?.sections?.find((section) => section.title === "Notices by week");
    expect(strip?.kind).toBe("weeks");
    if (strip?.kind !== "weeks") throw new Error("the strip is a weeks section");
    expect(strip.weeks).toHaveLength(26);
    const week = strip.weeks.find((w) => w.weekStart === "2026-10-19");
    expect(week?.count).toBe(2);
    expect(week?.href).toBe("/ownership/notices?stock=PLS&since=2026-10-19&until=2026-10-25");
  });

  it("names the feed for the company, the week's Monday and Sunday, in the link", () => {
    expect(stockWeekHref("PLS", "2026-10-26", "2026-11-01")).toBe(
      "/ownership/notices?stock=PLS&since=2026-10-26&until=2026-11-01",
    );
  });

  it("is absent when the notices did not read, so a failed read is never a quiet strip", () => {
    const content = stockInspectorContent(panel(), series, "disclosed", null, null);
    expect(content?.sections?.some((section) => section.title === "Notices by week")).toBe(false);
    expect(content?.sections?.map((section) => section.title)).toEqual([
      "Reported interests",
      "Fund contributions",
      "Recent activity",
    ]);
  });

  it("is absent when the desk has no date to end the strip on", () => {
    const content = stockInspectorContent(panel(), series, "disclosed", null, { asOf: "", released: [] });
    expect(content?.sections?.some((section) => section.title === "Notices by week")).toBe(false);
  });
});
