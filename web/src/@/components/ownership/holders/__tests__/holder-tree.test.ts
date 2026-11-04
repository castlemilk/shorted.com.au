/// <reference types="jest" />

/**
 * The holders workspace's pure model (spec 14.3): the exposure estimate, the tree
 * by sector, the six-company fold, the ribbons' geometry, the inspector's content
 * and the URL codec. Nothing here reads a browser or a server.
 */

import {
  HOLDER_CHIPS,
  SECTOR_SHOWN,
  TREE_LAYOUT,
  buildHolderTree,
  chipCovers,
  connectionsPage,
  exposureOf,
  filterHolders,
  holderInspectorContent,
  holderPositions,
  holderRowFrom,
  layoutHolderTree,
  marketCapsOf,
  parseHolderParam,
  ribbonPath,
  ribbonThickness,
  SECTORS_SHOWN,
  fundSizeLabel,
  hasFoldedRows,
  holderFundRow,
  resolveHolderKey,
  sectorLabel,
  withSearch,
  type HolderPosition,
  type HolderRow,
} from "../holder-tree";

const EM_DASH = String.fromCharCode(0x2014);

const holder: HolderRow = {
  key: "vanguard",
  name: "Vanguard",
  kind: "index_manager",
  website: "https://www.vanguard.com.au",
  positions: 3,
  latestNoticeDate: "2026-11-02",
};

const position = (
  code: string,
  industry: string,
  votingPowerPct: number,
  marketCap: number | null,
): HolderPosition => ({
  stockCode: code,
  companyName: `${code} Limited`,
  industry,
  votingPowerPct,
  eventDate: "2026-10-14",
  announcementUrl: `https://www.asx.com.au/${code}.pdf`,
  marketCap,
});

describe("exposure (spec 13.1, 14.3)", () => {
  it("multiplies voting power by market cap, and is null without a cap, never zero", () => {
    expect(exposureOf(5, 1_000_000_000)).toBeCloseTo(50_000_000, 0);
    expect(exposureOf(5, null)).toBeNull();
    expect(exposureOf(5, 0)).toBeNull();
    expect(exposureOf(Number.NaN, 1e9)).toBeNull();
  });

  it("names a placeholder industry as Other, never as an industry", () => {
    expect(sectorLabel("Materials")).toBe("Materials");
    expect(sectorLabel("Not Applic")).toBe("Other");
    expect(sectorLabel("")).toBe("Other");
    expect(sectorLabel(null)).toBe("Other");
  });
});

describe("the tree by sector (spec 14.3)", () => {
  const positions = [
    position("BHP", "Materials", 6, 200e9),
    position("RIO", "Materials", 4, 100e9),
    position("CBA", "Banks", 5, 150e9),
    position("CSL", "Pharmaceuticals, Biotechnology & Life Sciences", 3, 120e9),
    position("NEW", "Not Applic", 5, null),
  ];
  const tree = buildHolderTree(positions);

  it("orders sectors by exposure, with a sector with no priced company last", () => {
    expect(tree.sectors.map((s) => s.label)).toEqual([
      "Materials",
      "Banks",
      "Pharmaceuticals, Biotechnology & Life Sciences",
      "Other",
    ]);
    expect(tree.sectors[3]?.exposureAud).toBe(0);
  });

  it("orders companies by exposure inside a sector, unpriced last", () => {
    const materials = tree.sectors.find((s) => s.label === "Materials");
    expect(materials?.companies.map((c) => c.code)).toEqual(["BHP", "RIO"]);
    expect(tree.sectors[3]?.companies[0]?.exposureAud).toBeNull();
  });

  it("sums the priced exposures and counts the unpriced interests", () => {
    expect(tree.unpricedCount).toBe(1);
    const sum = positions
      .map((p) => exposureOf(p.votingPowerPct, p.marketCap) ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(tree.totalExposureAud).toBeCloseTo(sum, 0);
  });

  it("joins market caps from the map, and a missing stock has none", () => {
    const caps = marketCapsOf([
      { code: "BHP", marketCap: 200e9 },
      { code: "ZERO", marketCap: 0 },
    ]);
    const rows = holderPositions(
      [
        { stockCode: "BHP", companyName: "BHP", industry: "Materials", votingPowerPct: 5, eventDate: "", announcementUrl: "" },
        { stockCode: "ZERO", companyName: "Zero", industry: "", votingPowerPct: 5, eventDate: "", announcementUrl: "" },
        { stockCode: "GONE", companyName: "Gone", industry: "", votingPowerPct: 5, eventDate: "", announcementUrl: "" },
      ],
      caps,
    );
    expect(rows.map((r) => r.marketCap)).toEqual([200e9, null, null]);
    expect(holderPositions(rows.slice(0, 1), null)[0]?.marketCap).toBeNull();
  });

  it("reads the holder row from an institution's fields and reports the map's absence", () => {
    const row = holderRowFrom({
      slug: "vanguard",
      name: "Vanguard",
      kind: "index_manager",
      website: "https://www.vanguard.com.au",
      substantialPositions: 157,
      latestNoticeDate: "2026-11-02",
    });
    expect(row.key).toBe("vanguard");
    expect(row.positions).toBe(157);
    const page = connectionsPage(row, [], null);
    expect(page.ok).toBe(true);
    expect(page.capsOk).toBe(false);
  });
});

describe("the layout (spec 14.2, 14.3)", () => {
  it("folds all but the six largest companies of a sector under Other companies", () => {
    const many = Array.from({ length: SECTOR_SHOWN + 3 }, (_, i) =>
      position(`C${String(i).padStart(2, "0")}`, "Materials", 5 - i * 0.1, 1e9 * (20 - i)),
    );
    const tree = buildHolderTree(many);
    const folded = layoutHolderTree(tree, { expanded: false });
    const nodes = folded.sectors[0]?.companies ?? [];
    expect(nodes).toHaveLength(SECTOR_SHOWN + 1);
    expect(nodes[SECTOR_SHOWN]?.code).toBeNull();
    expect(nodes[SECTOR_SHOWN]?.members).toHaveLength(3);
    expect(nodes[SECTOR_SHOWN]?.title).toContain("3 other companies in Materials");

    const expanded = layoutHolderTree(tree, { expanded: true });
    expect(expanded.sectors[0]?.companies).toHaveLength(SECTOR_SHOWN + 3);
    expect(expanded.sectors[0]?.companies.every((n) => n.code !== null)).toBe(true);
  });

  it("collapses the sectors past the first five into one Other sectors node that opens them", () => {
    const industries = ["Materials", "Banks", "Energy", "Health Care", "Utilities", "Industrials", "Real Estate"];
    const tree = buildHolderTree(industries.map((industry, i) => position(`C${i}`, industry, 5, 1e9 * (20 - i))));
    expect(hasFoldedRows(tree)).toBe(true);

    const collapsed = layoutHolderTree(tree, { expanded: false });
    expect(collapsed.sectors).toHaveLength(SECTORS_SHOWN + 1);
    const other = collapsed.sectors[SECTORS_SHOWN];
    expect(other?.label).toBe("Other sectors");
    expect(other?.folded).toBe(true);
    expect(other?.companies[0]?.code).toBeNull();
    expect(other?.companies[0]?.members.map((m) => m.code)).toEqual(["C5", "C6"]);

    const expanded = layoutHolderTree(tree, { expanded: true });
    expect(expanded.sectors).toHaveLength(industries.length);
    expect(expanded.sectors.some((s) => s.folded)).toBe(false);
  });

  it("bounds the map's height for a large holder, so its holder node stays within reach", () => {
    const industries = ["Materials", "Banks", "Energy", "Health Care", "Utilities", "Industrials", "Real Estate"];
    const positions = industries.flatMap((industry, s) =>
      Array.from({ length: 22 }, (_, i) => position(`S${s}C${i}`, industry, 1, 1e9 * (30 - i))),
    );
    const tree = buildHolderTree(positions);
    const collapsed = layoutHolderTree(tree, { expanded: false });
    // Five sectors of six companies and a fold row, one fold row for the rest, and the gaps: 1700 px.
    expect(collapsed.height).toBeLessThanOrEqual(1800);
    expect(layoutHolderTree(tree, { expanded: true }).height).toBeGreaterThan(collapsed.height);
  });

  it("stacks the holder's ribbons so their widths add up on the holder node", () => {
    const tree = buildHolderTree([position("BHP", "Materials", 6, 200e9), position("CBA", "Banks", 5, 150e9)]);
    const layout = layoutHolderTree(tree, { expanded: false });
    const holderRibbons = layout.ribbons.filter((r) => r.id.startsWith("ribbon:holder>"));
    const total = holderRibbons.reduce((s, r) => s + r.thickness, 0);
    expect(holderRibbons).toHaveLength(2);
    expect(holderRibbons.every((r) => r.priced)).toBe(true);
    expect(total).toBeLessThanOrEqual(TREE_LAYOUT.maxRibbon + TREE_LAYOUT.minRibbon * 2);
    expect(layout.holderY).toBeCloseTo(layout.height / 2, 5);
  });

  it("draws an unpriced company as a hairline and says so in its title", () => {
    const tree = buildHolderTree([position("BHP", "Materials", 6, 200e9), position("NEW", "Materials", 5, null)]);
    const layout = layoutHolderTree(tree, { expanded: false });
    const hairline = layout.ribbons.find((r) => r.code === "NEW");
    expect(hairline?.thickness).toBe(TREE_LAYOUT.hairline);
    expect(hairline?.priced).toBe(false);
    expect(hairline?.title).toContain("market cap not available");
    expect(hairline?.title).toContain("not estimated");
  });

  it("returns an empty layout for a holder with no positions", () => {
    const layout = layoutHolderTree(buildHolderTree([]), { expanded: false });
    expect(layout.height).toBe(0);
    expect(layout.sectors).toEqual([]);
    expect(layout.ribbons).toEqual([]);
  });

  it("gives a ribbon the thickness of its exposure against the whole, never less than the minimum", () => {
    expect(ribbonThickness(null, 100)).toBe(TREE_LAYOUT.hairline);
    expect(ribbonThickness(0, 100)).toBe(TREE_LAYOUT.hairline);
    expect(ribbonThickness(100, 100)).toBe(TREE_LAYOUT.maxRibbon);
    expect(ribbonThickness(1, 1e12)).toBe(TREE_LAYOUT.minRibbon);
  });

  it("writes a closed cubic ribbon with rounded coordinates", () => {
    const d = ribbonPath(24, 10, 38, 30, 4);
    expect(d.startsWith("M24 8 C31 8 31 28 38 28")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).not.toMatch(/\d\.\d{3,}/);
  });
});

describe("the inspector's content (spec 14.3)", () => {
  const positions = [position("BHP", "Materials", 6, 200e9), position("CBA", "Banks", 5, 150e9)];

  it("names the holder, its kind and its positions, and links the holder's profile", () => {
    const content = holderInspectorContent(holder, positions, null);
    expect(content.heading).toBe("Vanguard");
    expect(content.badges).toEqual(["Index manager"]);
    expect(content.summary).toEqual(["3 disclosed positions", "Latest notice: 2 Nov 2026"]);
    expect(content.primary).toEqual({ label: "Open holder profile →", href: "/ownership/vanguard" });
    expect(content.footnote).toContain("Manager-level notices are separate");
  });

  it("shows a company's selected connection, titled by its code and sector, with its notice as an external link", () => {
    const content = holderInspectorContent(holder, positions, { kind: "stock", code: "BHP" });
    const connection = content.sections?.find((s) => s.title === "BHP · Materials");
    expect(connection?.kind).toBe("rows");
    expect(connection?.items.find((i) => i.label === "Voting power")?.value).toBe("6.00%");
    expect(content.connectionLink).toEqual({
      label: "View the underlying notice",
      href: "https://www.asx.com.au/BHP.pdf",
      external: true,
    });
  });

  it("heads a selected company's card as a selected connection, and dates its notice as the page's date format", () => {
    const content = holderInspectorContent(holder, positions, { kind: "stock", code: "BHP" });
    expect(content.selectionHeading).toBe("Selected connection");
    const connection = content.sections?.find((s) => s.title === "BHP · Materials");
    const date = connection?.items.find((i) => i.label === "Notice date")?.value;
    expect(date).toBe("14 Oct 2026");
    expect(JSON.stringify(content)).not.toContain("2026-10-14");
    expect(holderInspectorContent(holder, positions, null).selectionHeading).toBeUndefined();
  });

  it("falls back to the release date when a notice has no event date, and n/a when it has neither", () => {
    const released = { ...position("BHP", "Materials", 6, 200e9), eventDate: "", announcedOn: "2026-10-13" };
    const dated = holderInspectorContent(holder, [released], { kind: "stock", code: "BHP" });
    const rows = dated.sections?.find((s) => s.title === "BHP · Materials")?.items ?? [];
    expect(rows.find((i) => i.label === "Release date")?.value).toBe("13 Oct 2026");
    expect(rows.some((i) => i.label === "Notice date")).toBe(false);

    const bare = { ...position("BHP", "Materials", 6, 200e9), eventDate: "", announcedOn: "" };
    const none = holderInspectorContent(holder, [bare], { kind: "stock", code: "BHP" });
    const noneRows = none.sections?.find((s) => s.title === "BHP · Materials")?.items ?? [];
    expect(noneRows.find((i) => i.label === "Notice date")?.value).toBe("n/a");
  });

  it("links a notice only when its URL is an absolute http or https URL, never a javascript URL", () => {
    const unsafe = { ...position("BHP", "Materials", 6, 200e9), announcementUrl: "javascript:alert(1)" };
    const link = holderInspectorContent(holder, [unsafe], { kind: "stock", code: "BHP" }).connectionLink;
    expect(link).toEqual({ label: "View the underlying notice", href: "", external: true });
    const relative = { ...position("BHP", "Materials", 6, 200e9), announcementUrl: "/notices/BHP.pdf" };
    expect(holderInspectorContent(holder, [relative], { kind: "stock", code: "BHP" }).connectionLink?.href).toBe("");
  });

  it("draws no notice line at all when the notice states no URL", () => {
    const none = { ...position("BHP", "Materials", 6, 200e9), announcementUrl: "" };
    expect(holderInspectorContent(holder, [none], { kind: "stock", code: "BHP" }).connectionLink).toBeNull();
  });

  it("says a company the holder does not hold is not among its interests", () => {
    const content = holderInspectorContent(holder, positions, { kind: "stock", code: "WES" });
    expect(content.note).toContain("WES is not among Vanguard");
    expect(content.sections?.some((s) => s.title.includes(" · "))).toBe(false);
    expect(content.connectionLink).toBeNull();
  });

  it("lists a sector's companies by exposure for a connection of the holder's own kind", () => {
    const content = holderInspectorContent(holder, positions, {
      kind: "connection",
      holderKind: "index_manager",
      sector: "Materials",
    });
    const bars = content.sections?.find((s) => s.kind === "bars");
    expect(bars?.kind === "bars" && bars.items.map((b) => b.label)).toEqual(["BHP BHP Limited"]);
    expect(bars?.kind === "bars" && bars.items[0]?.share).toBe(1);
  });

  it("ignores a connection of another kind, and notes the interests drawn without a width", () => {
    const content = holderInspectorContent(holder, [...positions, position("NEW", "Banks", 4, null)], {
      kind: "connection",
      holderKind: "bank_broker",
      sector: "Banks",
    });
    expect(content.sections).toEqual([]);
    expect(content.note).toContain("1 interest is drawn without a width");
    expect(content.note).not.toContain(EM_DASH);
  });
});

describe("the funds and products (spec 14.3)", () => {
  it("keeps each fund with its code, and states no size as n/a, never zero", () => {
    const fund = holderFundRow({
      fundKey: "VAS",
      name: "Vanguard Australian",
      asxCode: "VAS",
      fundType: "etf",
      hasSize: false,
      sizeAud: 0,
    });
    expect(fund).toEqual({ key: "VAS", name: "Vanguard Australian", asxCode: "VAS", fundType: "etf", sizeAud: null });
    expect(fundSizeLabel(fund)).toBe("n/a");
    const content = holderInspectorContent(holder, [], null, [fund]);
    expect(content.funds).toEqual([fund]);
    expect(content.connectionLink).toBeNull();
  });
});

describe("the URL codec (spec 13.1, 14.1)", () => {
  it("resolves the holder every island shows: the named slug, else the default, never a raw value", () => {
    expect(resolveHolderKey("vanguard", "aus-super")).toBe("vanguard");
    expect(resolveHolderKey("Vanguard", "aus-super")).toBe("aus-super");
    expect(resolveHolderKey("asx:BHP", "aus-super")).toBe("aus-super");
    expect(resolveHolderKey(null, "aus-super")).toBe("aus-super");
  });

  it("accepts an institution slug and refuses anything else", () => {
    expect(parseHolderParam("vanguard")).toBe("vanguard");
    expect(parseHolderParam("asx:BHP")).toBeNull();
    expect(parseHolderParam("name:someone")).toBeNull();
    expect(parseHolderParam("")).toBeNull();
    expect(parseHolderParam(null)).toBeNull();
  });

  it("writes and clears parameters, keeping the rest in order", () => {
    expect(withSearch("/ownership/holders", "holder=a&sel=stock:BHP", { sel: null })).toBe(
      "/ownership/holders?holder=a",
    );
    expect(withSearch("/ownership/holders", "", { holder: "vanguard", sel: null })).toBe(
      "/ownership/holders?holder=vanguard",
    );
    expect(withSearch("/p", "x=1", { holder: "b" })).toBe("/p?x=1&holder=b");
  });
});

describe("the kind chips (spec 14.3)", () => {
  const holders: HolderRow[] = [
    holder,
    { ...holder, key: "aus-super", name: "AustralianSuper", kind: "super_fund" },
    { ...holder, key: "regal", name: "Regal Partners", kind: "active_manager" },
    { ...holder, key: "ubs", name: "UBS", kind: "bank_broker" },
    { ...holder, key: "norges", name: "Norges Bank", kind: "sovereign_public" },
  ];

  it("names the wireframe's chips, with Other taking every kind the named chips leave out", () => {
    expect(HOLDER_CHIPS.map((c) => c.label)).toEqual([
      "All holders",
      "Index managers",
      "Super funds",
      "Active managers",
      "Hedge funds",
      "Banks and brokers",
      "Other",
    ]);
    expect(chipCovers("other", "sovereign_public")).toBe(true);
    expect(chipCovers("other", "index_manager")).toBe(false);
  });

  it("filters the directory by chip and by name, keeping its order", () => {
    expect(filterHolders(holders, "all", "").map((h) => h.key)).toEqual([
      "vanguard",
      "aus-super",
      "regal",
      "ubs",
      "norges",
    ]);
    expect(filterHolders(holders, "other", "").map((h) => h.key)).toEqual(["norges"]);
    expect(filterHolders(holders, "all", "  RE").map((h) => h.key)).toEqual(["regal"]);
    expect(filterHolders(holders, "super_fund", "zzz")).toEqual([]);
  });
});
