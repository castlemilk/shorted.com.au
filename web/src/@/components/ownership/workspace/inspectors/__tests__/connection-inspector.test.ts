/// <reference types="jest" />

import { COMPANY_LIMIT, connectionInspectorContent, connectionNoticesHref, connectionRegisterHref, hasMixedDates, type ConnectionCompany, connectionReading } from "../connection-inspector";
import { OTHER_SECTOR } from "~/@/components/ownership/desk/map-layout";
import { FOLDED_SECTOR_LABEL } from "~/@/lib/ownership/kinds";

const EM_DASH = String.fromCharCode(0x2014);

function company(code: string, pct: number | null, latestNotice = "2026-10-01"): ConnectionCompany {
  return { code, name: `${code} Ltd`, pct, latestNotice };
}

describe("connectionInspectorContent (spec 14.3, Connections; spec 14.7)", () => {
  it("heads the connection with the holder kind's plural and the sector", () => {
    const content = connectionInspectorContent({ holderKind: "index_manager", sector: "Materials", companies: [] });
    expect(content.heading).toBe("Index managers → Materials");
  });

  it("lists the band's companies as bars by the kind's own figure, the largest first", () => {
    const content = connectionInspectorContent({
      holderKind: "index_manager",
      sector: "Materials",
      companies: [company("BHP", 4), company("RIO", 8), company("FMG", 2)],
      total: 3,
    });
    const section = content.sections?.find((s) => s.title === "Companies on this connection");
    if (section?.kind !== "bars") throw new Error("expected bars");
    expect(section.items.map((item) => item.label)).toEqual(["RIO", "BHP", "FMG"]);
    expect(section.items.map((item) => item.value)).toEqual(["8.00%", "4.00%", "2.00%"]);
    expect(section.items.map((item) => item.share)).toEqual([1, 0.5, 0.25]);
  });

  it("prints each company's bar figure at two decimals, where the register states four (spec A4)", () => {
    const content = connectionInspectorContent({
      holderKind: "index_manager",
      sector: "Materials",
      companies: [company("BHP", 13.131), company("RIO", 19.4336), company("FMG", null)],
      total: 3,
    });
    const section = content.sections?.find((s) => s.title === "Companies on this connection");
    if (section?.kind !== "bars") throw new Error("expected bars");
    expect(section.items.map((item) => item.value)).toEqual(["19.43%", "13.13%", "n/a"]);
  });

  it("names the selected company, and opens the band's largest company from the primary action", () => {
    const content = connectionInspectorContent({
      holderKind: "index_manager",
      sector: "Materials",
      companies: [company("BHP", 4), company("RIO", 8)],
      total: 2,
      selectedCode: "BHP",
    });
    const section = content.sections?.find((s) => s.title === "Companies on this connection");
    if (section?.kind !== "bars") throw new Error("expected bars");
    expect(section.items[0]?.label).toBe("BHP (selected)");
    // The primary is the band's largest company (spec 14.8), not the selected one.
    expect(content.primary).toEqual({ label: "Open RIO →", href: "/ownership/stocks/RIO" });
  });

  it("links each company row to its register page", () => {
    const content = connectionInspectorContent({
      holderKind: "index_manager",
      sector: "Materials",
      companies: [company("BHP", 4), company("RIO", 8)],
      total: 2,
    });
    const section = content.sections?.find((s) => s.title === "Companies on this connection");
    if (section?.kind !== "bars") throw new Error("expected bars");
    expect(section.items.map((item) => item.href)).toEqual(["/ownership/stocks/RIO", "/ownership/stocks/BHP"]);
  });

  it("lists the window's notices in the Change view, and carries the window in its links", () => {
    const content = connectionInspectorContent({
      holderKind: "index_manager",
      sector: "Materials",
      companies: [company("BHP", 4)],
      total: 1,
      view: "changes",
      span: { window: "28", since: "", until: "" },
      notices: { rows: [{ released: "2026-10-30", code: "BHP", holder: "Alpha" }], total: 1 },
    });
    const section = content.sections?.find((s) => s.title === "Notices in this window");
    if (section?.kind !== "list") throw new Error("expected the notices");
    // Each notice links to its company's register page (spec 14.8).
    expect(section.items).toEqual([{ label: "2026-10-30 BHP · Alpha", href: "/ownership/stocks/BHP" }]);
    expect(content.links?.[0]?.href).toBe("/ownership/notices?kind=index_manager&industry=Materials&window=28");
  });

  it("omits the primary action when the band has no company", () => {
    const content = connectionInspectorContent({
      holderKind: "index_manager",
      sector: "Materials",
      companies: [],
      total: 0,
    });
    expect(content.primary).toBeUndefined();
  });

  it("caps the list at the ten largest and links the whole register for the connection", () => {
    const companies = Array.from({ length: 12 }, (_, i) => company(`C${i}`, 12 - i));
    const content = connectionInspectorContent({ holderKind: "super_fund", sector: "Banks", companies, total: 12 });
    const section = content.sections?.find((s) => s.title === "Companies on this connection");
    if (section?.kind !== "bars") throw new Error("expected bars");
    expect(section.items).toHaveLength(COMPANY_LIMIT);
    expect(content.links?.find((l) => l.label === "All 12 companies on the register →")?.href).toBe(
      connectionRegisterHref("super_fund", "Banks"),
    );
  });

  it("prints a served empty band as zero, and n/a only when the registers could not be read", () => {
    const content = connectionInspectorContent({ holderKind: "bank_broker", sector: "Banks", companies: [], total: 0 });
    expect(content.rows).toEqual([{ label: "Companies on this connection", value: "0" }]);
    const outage = connectionInspectorContent({ holderKind: "bank_broker", sector: "Banks", companies: null });
    expect(outage.rows).toEqual([{ label: "Companies on this connection", value: "n/a" }]);
  });

  it("says so when the underlying notices have different dates, and that interests may overlap", () => {
    const content = connectionInspectorContent({
      holderKind: "index_manager",
      sector: "Materials",
      companies: [company("BHP", 4, "2026-10-01"), company("RIO", 8, "2026-09-01")],
      total: 2,
    });
    expect(content.note).toBe("Underlying notices have different dates. Reported interests may overlap.");
    expect(hasMixedDates([company("A", 1, "2026-10-01"), company("B", 1, "2026-10-01")])).toBe(false);
  });

  it("links the holder notices through the feed filtered to the kind, the sector and the window", () => {
    const content = connectionInspectorContent({ holderKind: "index_manager", sector: "Materials", companies: [], total: 0 });
    expect(content.links?.[0]?.href).toBe(connectionNoticesHref("index_manager", "Materials"));
    expect(connectionNoticesHref("index_manager", "Materials")).toBe(
      "/ownership/notices?kind=index_manager&industry=Materials&window=91",
    );
  });

  it("writes no em dash anywhere in its copy", () => {
    const content = connectionInspectorContent({
      holderKind: "index_manager",
      sector: "Materials",
      companies: [company("BHP", 4)],
      total: 1,
    });
    expect(JSON.stringify(content)).not.toContain(EM_DASH);
  });
});

describe("the Other connection and the rail's window", () => {
  it("withholds the count and companies for Other, which the register cannot filter", () => {
    const content = connectionInspectorContent({ holderKind: "index_manager", sector: "Other", companies: null });
    expect(content.rows).toEqual([{ label: "Companies on this connection", value: "n/a" }]);
    expect(content.sections).toBeUndefined();
  });

  it("names the folded tail without a register filter, and asks for Expand Other +", () => {
    const content = connectionInspectorContent({ holderKind: "index_manager", sector: "Other sectors", companies: null });
    expect(content.heading).toBe("Index managers → Other sectors");
    expect(content.rows).toEqual([{ label: "Companies on this connection", value: "n/a" }]);
    expect(content.note).toContain("Expand Other +");
  });

  it("withholds the count when the registers could not be read", () => {
    const content = connectionInspectorContent({ holderKind: "index_manager", sector: "Materials", companies: null });
    expect(content.rows[0]?.value).toBe("n/a");
  });
});

describe("connection companies ranked by estimated exposure (spec 14.7)", () => {
  it("ranks by the kind's share times market cap, not by the share alone", () => {
    const big = { ...company("BIG", 4), marketCap: 100_000_000_000 };
    const small = { ...company("SML", 9), marketCap: 1_000_000_000 };
    const content = connectionInspectorContent({
      holderKind: "index_manager",
      sector: "Materials",
      companies: [small, big],
      total: 2,
    });
    const section = content.sections?.find((s) => s.title === "Companies on this connection");
    if (section?.kind !== "bars") throw new Error("expected bars");
    expect(section.items.map((item) => item.label)).toEqual(["BIG", "SML"]);
    expect(section.items[1]?.share).toBeCloseTo(0.09e9 / 4e9, 6);
  });

  it("links the whole register when the list is the first page of more companies", () => {
    const companies = Array.from({ length: 10 }, (_, i) => company(`C${i}`, 10 - i));
    const content = connectionInspectorContent({ holderKind: "super_fund", sector: "Banks", companies, total: 10 });
    expect(content.links?.some((l) => l.label.startsWith("All 10 companies"))).toBe(false);
    const more = connectionInspectorContent({
      holderKind: "super_fund",
      sector: "Banks",
      companies: [...companies, company("X", 1)],
      total: 11,
    });
    expect(more.links?.some((l) => l.label === "All 11 companies on the register →")).toBe(true);
  });
});

describe("connectionReading (spec 14.1, backlog C1)", () => {
  const BHP = { code: "BHP", name: "BHP Group", pct: 10, marketCap: 134e9, latestNotice: "2026-10-27" };
  const RIO = { code: "RIO", name: "Rio Tinto", pct: 2, marketCap: 50e9, latestNotice: "2026-10-27" };

  it("says how many companies the band holds in its sector, and the largest by exposure", () => {
    expect(connectionReading({ holderKind: "index_manager", sector: "Materials", companies: [RIO, BHP] })).toBe(
      "Index managers hold 2 companies in Materials, BHP largest at $13.40B.",
    );
  });

  it("names the register's count when it is larger than the companies carried, and a singular noun for one", () => {
    expect(connectionReading({ holderKind: "index_manager", sector: "Materials", companies: [BHP, RIO], total: 14 })).toBe(
      "Index managers hold 14 companies in Materials, BHP largest at $13.40B.",
    );
    expect(connectionReading({ holderKind: "index_manager", sector: "Materials", companies: [BHP] })).toBe(
      "Index managers hold 1 company in Materials, BHP largest at $13.40B.",
    );
  });

  it("drops the largest clause when no company has a market cap to estimate an exposure from", () => {
    const unpriced = [
      { ...BHP, marketCap: null },
      { ...RIO, marketCap: null },
    ];
    expect(connectionReading({ holderKind: "index_manager", sector: "Materials", companies: unpriced })).toBe(
      "Index managers hold 2 companies in Materials.",
    );
  });

  it("counts the notices in the window in the Change view, then their net change", () => {
    const notices = {
      total: 2,
      rows: [
        { released: "2026-10-27", code: "BHP", holder: "A", changePp: 0.4 },
        { released: "2026-10-20", code: "RIO", holder: "B", changePp: -0.1 },
      ],
    };
    const reading = connectionReading({
      holderKind: "index_manager",
      sector: "Materials",
      companies: [BHP, RIO],
      view: "changes",
      notices,
    });
    expect(reading).toBe("2 notices in the window, net +0.30 pp.");
  });

  it("drops only the net when one notice states no change in points", () => {
    const notices = {
      total: 2,
      rows: [
        { released: "2026-10-27", code: "BHP", holder: "A", changePp: 0.4 },
        { released: "2026-10-20", code: "RIO", holder: "B", changePp: null },
      ],
    };
    expect(
      connectionReading({ holderKind: "index_manager", sector: "Materials", companies: [BHP, RIO], view: "changes", notices }),
    ).toBe("2 notices in the window.");
  });

  it("prints the window's count when the rows are partial, and no net for a sum that is not the window's", () => {
    const partial = {
      total: 3,
      rows: [
        { released: "2026-10-27", code: "BHP", holder: "A", changePp: 0.4 },
        { released: "2026-10-20", code: "RIO", holder: "B", changePp: -0.1 },
      ],
    };
    expect(
      connectionReading({ holderKind: "index_manager", sector: "Materials", companies: [BHP, RIO], view: "changes", notices: partial }),
    ).toBe("3 notices in the window.");
  });

  it("has no reading for a band whose registers were not read, or whose companies are withheld", () => {
    expect(connectionReading({ holderKind: "index_manager", sector: "Materials", companies: null })).toBeUndefined();
    expect(connectionReading({ holderKind: "index_manager", sector: OTHER_SECTOR, companies: [BHP] })).toBeUndefined();
    expect(connectionReading({ holderKind: "index_manager", sector: FOLDED_SECTOR_LABEL, companies: [BHP] })).toBeUndefined();
    expect(connectionReading({ holderKind: "index_manager", sector: "Materials", companies: [] })).toBeUndefined();
  });

  it("is the reading the connection's content carries", () => {
    const content = connectionInspectorContent({ holderKind: "index_manager", sector: "Materials", companies: [BHP, RIO] });
    expect(content.reading).toBe("Index managers hold 2 companies in Materials, BHP largest at $13.40B.");
  });
});
