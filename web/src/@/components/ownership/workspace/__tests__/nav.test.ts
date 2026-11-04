/// <reference types="jest" />

import { OWNERSHIP_TABS, activeOwnershipTab, tabHref, zoomedSector } from "../nav";

const NONE = { sel: "", sector: "" };
const tab = (id: (typeof OWNERSHIP_TABS)[number]["id"]) => OWNERSHIP_TABS.find((t) => t.id === id)!;

describe("ownership workspace nav (spec 14.1)", () => {
  it("lists the seven pages in the wireframes' order", () => {
    expect(OWNERSHIP_TABS.map((t) => t.label)).toEqual([
      "Overview",
      "Market map",
      "Connections",
      "Activity",
      "Funds",
      "Holders",
      "Changes",
    ]);
  });

  it("makes Overview active only on its own path", () => {
    expect(activeOwnershipTab("/ownership")).toBe("overview");
    expect(activeOwnershipTab("/ownership/")).toBe("overview");
    expect(activeOwnershipTab("/ownership/map")).toBe("map");
  });

  it("keeps a tab active for the pages nested under it", () => {
    expect(activeOwnershipTab("/ownership/funds/A200")).toBe("funds");
    expect(activeOwnershipTab("/ownership/holders/vanguard")).toBe("holders");
  });

  it("has no active tab outside the workspace", () => {
    expect(activeOwnershipTab("/ownership/vanguard")).toBeNull();
    expect(activeOwnershipTab("/ownership/stocks/BHP")).toBeNull();
    expect(activeOwnershipTab("/shorts/BHP")).toBeNull();
  });

  it("does not match a page that only shares a prefix", () => {
    expect(activeOwnershipTab("/ownership/mapping")).toBeNull();
  });
});

describe("tabHref (spec 14.1, backlog C2)", () => {
  it("is the bare page with no selection and no sector", () => {
    for (const t of OWNERSHIP_TABS) expect(tabHref(t, NONE)).toBe(t.href);
  });

  // Every selection kind, against each page: the page carries it only when it can show that kind.
  // A holder is carried by no page: the Overview's resolver has none and Holders reads ?holder=.
  const shows: Record<string, string[]> = {
    overview: ["stock"],
    map: ["stock"],
    connections: ["connection"],
    activity: ["cell"],
    funds: ["fund", "holding"],
    holders: [],
    changes: ["holding"],
  };
  const samples: Record<string, string> = {
    stock: "stock:BHP",
    holder: "holder:vanguard",
    connection: "connection:index_manager>Materials",
    cell: "cell:Materials@2026-10-26",
    fund: "fund:asx:A200",
    holding: "holding:asx:A200/BHP",
  };

  for (const [id, kinds] of Object.entries(shows)) {
    for (const kind of Object.keys(samples)) {
      it(`${kinds.includes(kind) ? "carries" : "drops"} a ${kind} selection on ${id}`, () => {
        const href = tabHref(tab(id as never), { sel: samples[kind]!, sector: "" });
        if (kinds.includes(kind)) {
          expect(href).toBe(`${tab(id as never).href}?sel=${encodeURIComponent(samples[kind]!)}`);
        } else {
          expect(href).toBe(tab(id as never).href);
        }
      });
    }
  }

  it("carries a holding that names a super option's fund, split at the last slash", () => {
    const sel = "holding:aware/High Growth/BHP";
    // The query is written as the desk writes its own links (URLSearchParams: a space is "+").
    expect(tabHref(tab("changes"), { sel, sector: "" })).toBe("/ownership/changes?sel=holding%3Aaware%2FHigh+Growth%2FBHP");
  });

  it("carries a zoomed sector on the Overview and the map only", () => {
    expect(tabHref(tab("map"), { sel: "", sector: "Materials" })).toBe("/ownership/map?sector=Materials");
    expect(tabHref(tab("overview"), { sel: "", sector: "Materials" })).toBe("/ownership?sector=Materials");
    for (const id of ["connections", "activity", "funds", "holders", "changes"] as const) {
      expect(tabHref(tab(id), { sel: "", sector: "Materials" })).toBe(tab(id).href);
    }
  });

  it("carries the selection and the sector together on the map", () => {
    expect(tabHref(tab("map"), { sel: "stock:BHP", sector: "Materials" })).toBe(
      "/ownership/map?sel=stock%3ABHP&sector=Materials",
    );
  });

  it("drops a sector the desk would not read, and a selection it cannot parse", () => {
    expect(tabHref(tab("map"), { sel: "", sector: "   " })).toBe("/ownership/map");
    expect(tabHref(tab("map"), { sel: "", sector: "x".repeat(65) })).toBe("/ownership/map");
    expect(tabHref(tab("map"), { sel: "stock:bhp", sector: "" })).toBe("/ownership/map");
    expect(tabHref(tab("map"), { sel: "stock:BHP\nevil", sector: "" })).toBe("/ownership/map");
  });

  it("accepts a tab id as well as the tab", () => {
    expect(tabHref("map", { sel: "stock:BHP", sector: "" })).toBe("/ownership/map?sel=stock%3ABHP");
  });
});

describe("zoomedSector", () => {
  it("trims a sector and reads anything empty, long or control-bearing as none", () => {
    expect(zoomedSector(" Materials ")).toBe("Materials");
    expect(zoomedSector(null)).toBe("");
    expect(zoomedSector("")).toBe("");
    expect(zoomedSector("a\tb")).toBe("");
    expect(zoomedSector("y".repeat(64))).toHaveLength(64);
    expect(zoomedSector("y".repeat(65))).toBe("");
  });
});
