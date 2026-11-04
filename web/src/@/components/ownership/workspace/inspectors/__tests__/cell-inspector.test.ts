/// <reference types="jest" />

import type { NoticeFeedPage, NoticeFeedRow } from "~/@/components/ownership/notice-feed-explorer";
import { cellInspectorContent, cellNoticesHref, countWeek, measureSwitchHref, weekCountLine, cellReading } from "../cell-inspector";
import { OTHER_SECTOR } from "~/@/components/ownership/desk/map-layout";

function row(event: string, code = "BHP"): NoticeFeedRow {
  return {
    released: "2026-10-27",
    event,
    code,
    companyName: "Company",
    holder: "Holder",
    holderHref: null,
    votingPower: "5.00%",
    change: "",
    url: `https://www.asx.com.au/${code}.pdf`,
  };
}

function feed(rows: NoticeFeedRow[], total = rows.length): NoticeFeedPage {
  return { ok: true, activityOk: false, query: {}, rows, total, nextCursor: "", weeks: [] } as unknown as NoticeFeedPage;
}

describe("cell inspector (spec 14.3, Activity)", () => {
  it("counts the week's notices by what each did: new, changed (increases, decreases and changes), ceased", () => {
    const counts = countWeek([row("became"), row("increased"), row("decreased"), row("changed"), row("ceased"), row("nz")]);
    expect(counts).toEqual({ became: 1, changed: 3, ceased: 1, nz: 1 });
  });

  it("writes the count line in the wireframe's words, leaving zero counts out", () => {
    expect(weekCountLine({ became: 6, changed: 7, ceased: 1, nz: 0 })).toBe("6 new · 7 changed · 1 ceased");
    expect(weekCountLine({ became: 0, changed: 0, ceased: 0, nz: 0 })).toBe("No notices this week");
    expect(weekCountLine({ became: 0, changed: 0, ceased: 0, nz: 2 })).toBe("2 NZ disclosures");
  });

  it("links the feed to the sector and the seven days from the Monday", () => {
    expect(cellNoticesHref("Materials", "2026-10-26")).toBe(
      "/ownership/notices?industry=Materials&since=2026-10-26&until=2026-11-01",
    );
  });

  it("prints the week's total as the figure, and names the notices behind it", () => {
    const content = cellInspectorContent({
      sector: "Materials",
      weekStart: "2026-10-26",
      feed: feed([row("became", "BHP"), row("changed", "RIO")], 14),
    });
    expect(content.heading).toBe("Materials");
    expect(content.subtitle).toBe("Week of 26 Oct");
    const byKind = cellInspectorContent({ sector: "Materials", weekStart: "2026-10-26", feed: feed([], 0), kind: "super_fund" });
    expect(byKind.subtitle).toBe("Week of 26 Oct · Super funds");
    expect(content.figure?.value).toBe("14 notices");
    expect(content.primary).toEqual({ label: "View 14 notices →", href: cellNoticesHref("Materials", "2026-10-26") });
    const list = content.sections?.[0];
    expect(list?.kind).toBe("list");
    expect(list?.title).toBe("Selected week's notices");
    if (list?.kind !== "list") throw new Error("expected a list");
    expect(list.items[0]?.external).toBe(true);
    expect(content.note).toBe("The first 2 of 14 notices are listed; the feed has the rest.");
  });

  it("uses the singular for one notice and prints no section for an empty week", () => {
    const one = cellInspectorContent({ sector: "Materials", weekStart: "2026-10-26", feed: feed([row("became")], 1) });
    expect(one.figure?.value).toBe("1 notice");
    expect(one.primary?.label).toBe("View 1 notice →");
    const empty = cellInspectorContent({ sector: "Materials", weekStart: "2026-10-26", feed: feed([], 0) });
    expect(empty.figure?.value).toBe("0 notices");
    expect(empty.sections).toBeUndefined();
  });
});

describe("the Other row and a partial page", () => {
  it("does not filter the feed by the placeholder industry", () => {
    expect(cellNoticesHref(OTHER_SECTOR, "2026-10-26")).toBe(
      "/ownership/notices?since=2026-10-26&until=2026-11-01",
    );
  });

  it("labels the counts as the listed notices when the page is partial", () => {
    const rows = Array.from({ length: 2 }, (_, index) => ({
      released: "2026-10-27",
      code: `C${index}`,
      holder: "Holder",
      event: "became",
      url: "https://example.test/notice",
    })) as unknown as NoticeFeedRow[];
    const feed = { ok: true, rows, total: 5 } as unknown as NoticeFeedPage;
    const content = cellInspectorContent({ sector: "Materials", weekStart: "2026-10-26", feed });
    expect(content.rows?.[0]?.label).toBe("Events in the listed notices");
  });
});

describe("the Other row's count", () => {
  it("withholds the count and never reads the feed, so the market's week is not Other's", () => {
    const content = cellInspectorContent({ sector: OTHER_SECTOR, weekStart: "2026-10-26", feed: null });
    expect(content.figure?.value).toBe("n/a");
    expect(content.sections).toBeUndefined();
    expect(content.primary).toBeUndefined();
    expect(content.note).toBe("Other's notices are not filtered by sector, so the count is withheld.");
  });

  it("does not print a whole-week total for Other even when a feed row is supplied", () => {
    const rows = [row("became"), row("changed")];
    const content = cellInspectorContent({
      sector: OTHER_SECTOR,
      weekStart: "2026-10-26",
      feed: feed(rows, 9),
    });
    expect(content.figure?.value).toBe("n/a");
    expect(content.figure?.value).not.toBe("9 notices");
  });
});

describe("stored notice URLs (spec 14.7)", () => {
  it("draws a notice whose URL is not an absolute http(s) link as its label, never as a link", () => {
    const hostile = { ...row("became", "BHP"), url: "javascript:alert(1)" };
    const content = cellInspectorContent({
      sector: "Materials",
      weekStart: "2026-10-26",
      feed: feed([hostile, row("changed", "RIO")], 2),
    });
    const list = content.sections?.find((section) => section.kind === "list");
    if (list?.kind !== "list") throw new Error("expected the safe notice in a list");
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.href).toBe("https://www.asx.com.au/RIO.pdf");
    const unlinked = content.sections?.find((section) => section.kind === "rows");
    if (unlinked?.kind !== "rows") throw new Error("expected the unsafe notice as a text row");
    expect(unlinked.items[0]?.label).toContain("BHP");
    expect(JSON.stringify(content)).not.toContain("javascript:");
  });
});

describe("measureSwitchHref (spec 14.3, Activity: Switch to reported voting-power change)", () => {
  it("names the cell and its holder type, and asks the grid for the voting-power measure", () => {
    const params = new URLSearchParams(measureSwitchHref("Materials", "2026-10-26", "hedge_fund").slice(1));
    expect(params.get("sel")).toBe("cell:Materials@2026-10-26:hedge_fund");
    expect(params.get("measure")).toBe("pp");
  });

  it("leaves the holder type out for every kind", () => {
    const params = new URLSearchParams(measureSwitchHref("Materials", "2026-10-26").slice(1));
    expect(params.get("sel")).toBe("cell:Materials@2026-10-26");
  });
});

describe("cellReading (spec 14.1, backlog C1)", () => {
  type ChangedRow = NoticeFeedRow & { changePp: number | null };
  const withChange = (event: string, change: string, changePp: number | null): ChangedRow => ({
    ...row(event),
    change,
    changePp,
  });
  /**
   * Eight notices of the week of 26 Oct: five rises (two new, three increases) and three falls. Each row states
   * its change in points as the grid sums it: 2.00 + 1.50 + 1.00 + 0.50 + 0.20 - 0.50 - 0.30 - 0.20 = +4.20.
   */
  const week: ChangedRow[] = [
    withChange("became", "+2.00 pp", 2),
    withChange("increased", "+1.50 pp", 1.5),
    withChange("increased", "+1.00 pp", 1),
    withChange("became", "+0.50 pp", 0.5),
    withChange("increased", "+0.20 pp", 0.2),
    withChange("decreased", "−0.50 pp", -0.5),
    withChange("ceased", "−0.30 pp", -0.3),
    withChange("decreased", "−0.20 pp", -0.2),
  ];

  it("counts the week's notices, its rises and falls, then the week's net change", () => {
    expect(cellReading({ sector: "Materials", weekStart: "2026-10-26", feed: feed(week) })).toBe(
      "8 notices in the week of 26 Oct, 5 rises and 3 falls, net +4.20 pp.",
    );
  });

  it("drops only the net when one row states no change in points", () => {
    const unstated = [withChange("became", "+2.00 pp", null), ...week.slice(1)];
    expect(cellReading({ sector: "Materials", weekStart: "2026-10-26", feed: feed(unstated) })).toBe(
      "8 notices in the week of 26 Oct, 5 rises and 3 falls.",
    );
    expect(cellReading({ sector: "Materials", weekStart: "2026-10-26", feed: feed(unstated) })).not.toContain("net");
  });

  it("prints a negative net with the true minus", () => {
    const falling = [withChange("decreased", "−0.50 pp", -0.5), withChange("ceased", "−1.00 pp", -1)];
    expect(cellReading({ sector: "Materials", weekStart: "2026-10-26", feed: feed(falling) })).toBe(
      "2 notices in the week of 26 Oct, 0 rises and 2 falls, net −1.50 pp.",
    );
  });

  it("names the holder kind the cell is of", () => {
    expect(cellReading({ sector: "Materials", weekStart: "2026-10-26", feed: feed(week), kind: "hedge_fund" })).toBe(
      "8 hedge fund notices in the week of 26 Oct, 5 rises and 3 falls, net +4.20 pp.",
    );
    expect(cellReading({ sector: "Materials", weekStart: "2026-10-26", feed: feed(week.slice(0, 1)), kind: "hedge_fund" })).toBe(
      "1 hedge fund notice in the week of 26 Oct, 1 rise and 0 falls, net +2.00 pp.",
    );
  });

  it("keeps the count alone for a partial page, with no rises, falls or net", () => {
    expect(cellReading({ sector: "Materials", weekStart: "2026-10-26", feed: feed(week.slice(0, 3), 8) })).toBe(
      "8 notices in the week of 26 Oct.",
    );
  });

  it("counts rises and falls by the event, and does not read the printed change text", () => {
    const textOnly = week.map((notice) => ({ ...notice, change: "", changePp: null }));
    expect(cellReading({ sector: "Materials", weekStart: "2026-10-26", feed: feed(textOnly) })).toBe(
      "8 notices in the week of 26 Oct, 5 rises and 3 falls.",
    );
  });

  it("says a week with no notice in words, never a count of zero", () => {
    expect(cellReading({ sector: "Materials", weekStart: "2026-10-26", feed: feed([], 0) })).toBe(
      "No notices in the week of 26 Oct.",
    );
  });

  it("has no reading for Other, whose count is withheld, or for an unread week", () => {
    expect(cellReading({ sector: OTHER_SECTOR, weekStart: "2026-10-26", feed: feed(week) })).toBeUndefined();
    expect(cellReading({ sector: "Materials", weekStart: "2026-10-26", feed: null })).toBeUndefined();
  });
});
