/// <reference types="jest" />

import type { FlowChangeRow, FlowPositionRow } from "~/@/components/ownership/desk/flows-layout";
import { formatAmount, MINUS } from "~/@/lib/fundamentals/format";
import {
  sectorChangeRows,
  sectorConnectionHref,
  sectorHolders,
  sectorInspectorContent,
  sectorReading,
  type SectorFlows,
} from "../sector-inspector";
import { parseSelection } from "../../selection";

type Holder = [slug: string, name: string, exposure: number | null];

function band(kind: string, exposureAud: number | null, holders: Holder[], industry = "Materials"): FlowPositionRow {
  return {
    kind,
    industry,
    exposureAud,
    holdings: holders.length,
    largestCode: "BHP",
    largestPct: 9,
    topHolders: holders.map(([slug, name, exposure]) => ({ slug, name, exposureAud: exposure, holdings: 1 })),
  };
}

function change(
  kind: string,
  direction: "up" | "down",
  exposureAud: number | null,
  notices: number,
  industry = "Materials",
): FlowChangeRow {
  return { kind, industry, direction, exposureAud, notices };
}

const SPAN = { window: "91", since: "", until: "" };

/** The spec's example sector: index managers hold the most across four holders, Vanguard is the largest holder. */
function materials(overrides: Partial<SectorFlows> = {}): SectorFlows {
  return {
    from: "2026-08-07",
    to: "2026-11-04",
    positions: [
      band("index_manager", 3.2e9, [
        ["vanguard", "Vanguard", 1.1e9],
        ["blackrock", "BlackRock", 0.9e9],
        ["state-street", "State Street", 0.7e9],
        ["betashares", "Betashares", 0.5e9],
      ]),
      band("super_fund", 1.0e9, [
        ["aware", "Aware Super", 0.6e9],
        ["cbus", "Cbus", 0.4e9],
      ]),
    ],
    changes: [
      change("index_manager", "up", 0.6e9, 3),
      change("index_manager", "down", 0.2e9, 1),
    ],
    ...overrides,
  };
}

describe("sectorHolders (backlog C4)", () => {
  it("sums a holder that sits in two kinds' bands once, under its slug, and names it under the kind it is largest in", () => {
    const holders = sectorHolders(
      [
        band("index_manager", 2e9, [["aware", "Aware Super", 0.2e9]]),
        band("super_fund", 1e9, [["aware", "Aware Super", 0.5e9]]),
      ],
      "Materials",
    );
    expect(holders).toEqual([{ slug: "aware", name: "Aware Super", exposureAud: 0.7e9, holderKind: "super_fund" }]);
  });

  it("sorts the holders by exposure, largest first, a holder with none after the ranked ones", () => {
    const holders = sectorHolders(
      [band("super_fund", 1e9, [["cbus", "Cbus", null], ["aware", "Aware Super", 0.2e9], ["x", "X Fund", 0.9e9]])],
      "Materials",
    );
    expect(holders.map((holder) => holder.slug)).toEqual(["x", "aware", "cbus"]);
    expect(holders[2]?.exposureAud).toBeNull();
  });

  it("keeps a holder's figure null when no band states one, and sums only the bands that do", () => {
    const holders = sectorHolders(
      [
        band("index_manager", 1e9, [["a", "Alpha", null]]),
        band("super_fund", 1e9, [["a", "Alpha", 0.3e9]]),
        band("insurer", 1e9, [["b", "Beta", null]]),
      ],
      "Materials",
    );
    expect(holders.find((holder) => holder.slug === "a")?.exposureAud).toBe(0.3e9);
    expect(holders.find((holder) => holder.slug === "b")?.exposureAud).toBeNull();
  });

  it("names at most ten holders, the band's own limit", () => {
    const many: Holder[] = Array.from({ length: 12 }, (_, index) => [`h${index}`, `Holder ${index}`, (index + 1) * 1e8]);
    const holders = sectorHolders([band("index_manager", 9e9, many)], "Materials");
    expect(holders).toHaveLength(10);
    expect(holders[0]?.slug).toBe("h11");
  });

  it("reads only the bands of the sector it is asked about", () => {
    const holders = sectorHolders(
      [band("index_manager", 1e9, [["a", "Alpha", 1e9]], "Energy"), band("index_manager", 1e9, [["b", "Beta", 2e8]])],
      "Materials",
    );
    expect(holders.map((holder) => holder.slug)).toEqual(["b"]);
  });
});

describe("sectorChangeRows (backlog C4)", () => {
  it("draws one row per kind in the vocabulary's order, its rises and falls in the same row, with a true minus", () => {
    const rows = sectorChangeRows([
      change("super_fund", "down", 1e8, 2),
      change("index_manager", "up", 6e8, 3),
      change("index_manager", "down", 2e8, 1),
    ]);
    expect(rows).toEqual([
      {
        label: "Super funds",
        value: `${MINUS}${formatAmount(1e8, "AUD")} in 2 notices`,
      },
      {
        label: "Index managers",
        value: `+${formatAmount(6e8, "AUD")} in 3 notices · ${MINUS}${formatAmount(2e8, "AUD")} in 1 notice`,
      },
    ]);
  });

  it("omits a kind with neither a rise nor a fall in the window", () => {
    expect(sectorChangeRows([change("insurer", "up", 1e8, 1)]).map((row) => row.label)).toEqual(["Insurers"]);
    expect(sectorChangeRows([])).toEqual([]);
  });

  it("prints n/a for a kind whose rows state no exposure, never zero", () => {
    const rows = sectorChangeRows([change("index_manager", "up", null, 2)]);
    expect(rows).toEqual([{ label: "Index managers", value: "n/a in 2 notices" }]);
  });
});

describe("sectorReading (backlog C1 pattern)", () => {
  it("names the kind that holds the most, its largest holder and the window's net change", () => {
    const flows = materials();
    const holders = sectorHolders(flows.positions, "Materials");
    expect(sectorReading({ positions: flows.positions, holders, changes: flows.changes })).toBe(
      `Index managers hold the most, ${formatAmount(3.2e9, "AUD")} estimated across 4 holders; Vanguard largest at ${formatAmount(1.1e9, "AUD")}; net +${formatAmount(0.4e9, "AUD")} in the window.`,
    );
  });

  it("drops the net clause when a change row states no exposure, and keeps the rest", () => {
    const flows = materials({ changes: [change("index_manager", "up", null, 3)] });
    const reading = sectorReading({
      positions: flows.positions,
      holders: sectorHolders(flows.positions, "Materials"),
      changes: flows.changes,
    });
    expect(reading).not.toContain("net");
    expect(reading).toContain("Vanguard largest at");
  });

  it("drops the net clause when the window holds no change at all, since no change is not a zero", () => {
    const flows = materials({ changes: [] });
    expect(sectorReading({ positions: flows.positions, holders: sectorHolders(flows.positions, "Materials"), changes: [] })).not.toContain(
      "net",
    );
  });

  it("drops the kind clause when no band states an exposure, and the holder clause when the largest holder has none", () => {
    const positions = [band("index_manager", null, [["a", "Alpha", null]])];
    expect(sectorReading({ positions, holders: sectorHolders(positions, "Materials"), changes: [] })).toBeUndefined();
  });

  it("reads 'across N holders' from the band's own holders, and says so when the band is at the limit", () => {
    const many: Holder[] = Array.from({ length: 10 }, (_, index) => [`h${index}`, `Holder ${index}`, 1e8]);
    const positions = [band("super_fund", 2e9, many)];
    const reading = sectorReading({ positions, holders: sectorHolders(positions, "Materials"), changes: [] });
    expect(reading).toContain("across 10 or more holders");
  });

  it("names a single holder in the singular", () => {
    const positions = [band("super_fund", 2e9, [["a", "Alpha", 2e9]])];
    const reading = sectorReading({ positions, holders: sectorHolders(positions, "Materials"), changes: [] });
    expect(reading).toContain("across 1 holder;");
  });
});

describe("sectorConnectionHref (backlog C4)", () => {
  it("links the connection with the sector's zoom and the window the reader chose, never sel=sector", () => {
    const href = sectorConnectionHref("index_manager", "Materials", { window: "28", since: "", until: "" });
    expect(href.startsWith("?")).toBe(true);
    const params = new URLSearchParams(href.slice(1));
    expect(params.get("sector")).toBe("Materials");
    expect(params.get("sel")).toBe("connection:index_manager>Materials");
    expect(params.get("window")).toBe("28");
    expect(params.has("since")).toBe(false);
    expect(parseSelection(params.get("sel") ?? "")).toEqual({ kind: "connection", holderKind: "index_manager", sector: "Materials" });
  });

  it("carries the reader's kept parameters into the link, and writes none that is empty", () => {
    const params = new URLSearchParams(
      sectorConnectionHref("index_manager", "Materials", { window: "28", since: "", until: "" }, {
        lens: "flow",
        view: "",
        from: "2026-10-01",
        to: "2026-10-31",
      }).slice(1),
    );
    expect(params.get("lens")).toBe("flow");
    expect(params.get("from")).toBe("2026-10-01");
    expect(params.get("to")).toBe("2026-10-31");
    expect(params.has("view")).toBe(false);
    expect(params.get("sel")).toBe("connection:index_manager>Materials");
  });

  it("keeps a brushed pair in place of the chip", () => {
    const params = new URLSearchParams(
      sectorConnectionHref("super_fund", "Materials", { window: "91", since: "2026-10-01", until: "2026-10-31" }).slice(1),
    );
    expect(params.get("since")).toBe("2026-10-01");
    expect(params.get("until")).toBe("2026-10-31");
  });
});

describe("sectorInspectorContent (backlog C4)", () => {
  it("heads the rail with the sector's short name, its full name beneath, and the sector icon", () => {
    const content = sectorInspectorContent({ sector: "Health Care Equipment & Services", flows: materials(), window: SPAN });
    expect(content.heading).toBe("Health care");
    expect(content.subtitle).toBe("Health Care Equipment & Services");
    expect(content.logo).toEqual({ kind: "sector", industry: "Health Care Equipment & Services" });
  });

  it("draws no subtitle when the short name is the sector's own name", () => {
    const content = sectorInspectorContent({ sector: "Materials", flows: materials(), window: SPAN });
    expect(content.heading).toBe("Materials");
    expect(content.subtitle).toBeUndefined();
  });

  it("draws the largest holders as bars, each linking to its connection and titled with its kind", () => {
    const content = sectorInspectorContent({ sector: "Materials", flows: materials(), window: SPAN });
    const bars = content.sections?.find((section) => section.title === "Largest holders by disclosed exposure");
    expect(bars?.kind).toBe("bars");
    if (bars?.kind !== "bars") throw new Error("expected bars");
    expect(bars.items.map((bar) => bar.label)).toEqual(["Vanguard", "BlackRock", "State Street", "Aware Super", "Betashares", "Cbus"]);
    expect(bars.items[0]).toMatchObject({
      label: "Vanguard",
      value: formatAmount(1.1e9, "AUD"),
      title: "Index manager",
      share: 1,
    });
    expect(bars.items[0]?.href).toBe(sectorConnectionHref("index_manager", "Materials", SPAN));
    expect(bars.items[3]?.title).toBe("Super fund");
    expect(bars.items[3]?.share).toBeCloseTo(0.6e9 / 1.1e9);
  });

  it("gives each holder bar the selection of its connection as params, so the page's whole query survives the click", () => {
    const content = sectorInspectorContent({ sector: "Materials", flows: materials(), window: SPAN });
    const bars = content.sections?.find((section) => section.title === "Largest holders by disclosed exposure");
    if (bars?.kind !== "bars") throw new Error("expected bars");
    expect(bars.items.map((bar) => bar.params)).toEqual([
      { sel: "connection:index_manager>Materials" },
      { sel: "connection:index_manager>Materials" },
      { sel: "connection:index_manager>Materials" },
      { sel: "connection:super_fund>Materials" },
      { sel: "connection:index_manager>Materials" },
      { sel: "connection:super_fund>Materials" },
    ]);
    // The fallback href stays on the bar beside the params.
    expect(bars.items[3]?.href).toBe(sectorConnectionHref("super_fund", "Materials", SPAN));
  });

  it("keeps the reader's lens and fund dates on each holder's link, not the sort", () => {
    const content = sectorInspectorContent({
      sector: "Materials",
      flows: materials(),
      window: SPAN,
      keep: { lens: "flow", view: "", from: "2026-10-01", to: "2026-10-31" },
    });
    const bars = content.sections?.find((section) => section.title === "Largest holders by disclosed exposure");
    if (bars?.kind !== "bars") throw new Error("expected bars");
    const params = new URLSearchParams(bars.items[0]?.href?.slice(1) ?? "");
    expect(params.get("lens")).toBe("flow");
    expect(params.get("from")).toBe("2026-10-01");
    expect(params.get("to")).toBe("2026-10-31");
    expect(params.has("sort")).toBe(false);
    expect(params.get("sel")).toBe("connection:index_manager>Materials");
  });

  it("draws the window's net change beneath, by holder type, with the true minus", () => {
    const content = sectorInspectorContent({ sector: "Materials", flows: materials(), window: SPAN });
    const rows = content.sections?.find((section) => section.title === "Net change in the window, by holder type");
    expect(rows).toEqual({
      title: "Net change in the window, by holder type",
      kind: "rows",
      items: [
        {
          label: "Index managers",
          value: `+${formatAmount(0.6e9, "AUD")} in 3 notices · ${MINUS}${formatAmount(0.2e9, "AUD")} in 1 notice`,
        },
      ],
    });
  });

  it("links the registers of the sector, nofollow, and states the disclosure as the footnote", () => {
    const content = sectorInspectorContent({ sector: "Materials", flows: materials(), window: SPAN });
    expect(content.primary).toEqual({
      label: "View the registers →",
      href: "/ownership/stocks?industry=Materials",
      nofollow: true,
    });
    expect(content.footnote).toBe("Disclosed exposure, estimated: voting power x market cap; what the notices disclose.");
  });

  it("states the span the flows were read over as its one row, and nothing when the span is unknown", () => {
    expect(sectorInspectorContent({ sector: "Materials", flows: materials(), window: SPAN }).rows).toEqual([
      { label: "Notices released", value: "2026-08-07 to 2026-11-04" },
    ]);
    expect(sectorInspectorContent({ sector: "Materials", flows: materials({ from: "", to: "" }), window: SPAN }).rows).toEqual([]);
  });

  it("draws a sector with no band as its heading and a note, with no reading and no list", () => {
    const content = sectorInspectorContent({
      sector: "Materials",
      flows: materials({ positions: [], changes: [] }),
      window: SPAN,
    });
    expect(content.heading).toBe("Materials");
    expect(content.reading).toBeUndefined();
    expect(content.sections).toBeUndefined();
    expect(content.note).toBe("No holder disclosed in this sector in the window.");
  });

  it("withholds the register link for Other, which no register filters by", () => {
    const content = sectorInspectorContent({ sector: "Other", flows: materials(), window: SPAN });
    expect(content.primary).toBeUndefined();
  });
});
