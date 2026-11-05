/**
 * The workspace's sub-navigation (spec 14.1): one group, "Ownership", and its
 * seven pages in the order the wireframes give. A pure module, so the active
 * tab and the link set are tested without a DOM.
 */

import { cleanSelection, parseSelection, type SelectionKind } from "./selection";
import type { WorkspaceTab } from "~/@/components/workspace/workspace-sub-nav";

export type OwnershipTabId = "overview" | "map" | "connections" | "activity" | "funds" | "holders" | "changes";

/** One tab of the workspace's sub-navigation, as the shared bar takes it. */
export type OwnershipTab = WorkspaceTab<OwnershipTabId>;

export const OWNERSHIP_GROUP = "Ownership";

export const OWNERSHIP_TABS: readonly WorkspaceTab<OwnershipTabId>[] = [
  { id: "overview", label: "Overview", href: "/ownership" },
  { id: "map", label: "Market map", href: "/ownership/map" },
  { id: "connections", label: "Connections", href: "/ownership/connections" },
  { id: "activity", label: "Activity", href: "/ownership/activity" },
  { id: "funds", label: "Funds", href: "/ownership/funds" },
  { id: "holders", label: "Holders", href: "/ownership/holders" },
  { id: "changes", label: "Changes", href: "/ownership/changes" },
];

/**
 * The tab a pathname belongs to. Overview is active only on its own path; every
 * other tab also covers its nested pages (a fund page is under Funds). A path
 * outside the workspace (an institution, a register page) has no active tab.
 */
export function activeOwnershipTab(pathname: string): OwnershipTabId | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/ownership") return "overview";
  for (const tab of OWNERSHIP_TABS) {
    if (tab.id === "overview") continue;
    if (path === tab.href || path.startsWith(`${tab.href}/`)) return tab.id;
  }
  return null;
}

/**
 * The selection kinds each page can show (spec 14.1, backlog C2). A link to a page
 * carries the reader's selection only when the page has something to draw it with;
 * otherwise the link is the bare page, so nothing lands on a rail that reads nothing.
 * A holder is not carried anywhere yet: the Overview's resolver has no holder, and the
 * Holders page reads its holder from ?holder=, not ?sel=. Add it back with either.
 */
const SHOWABLE_SELECTIONS: Readonly<Record<OwnershipTab["id"], readonly SelectionKind[]>> = {
  overview: ["stock"],
  map: ["stock"],
  connections: ["connection"],
  activity: ["cell"],
  funds: ["fund", "holding"],
  holders: [],
  changes: ["holding"],
};

/** The pages that take a zoomed sector: the whole-market desk on the map and the Overview. */
const SECTOR_PAGES: readonly OwnershipTab["id"][] = ["overview", "map"];

/** The longest sector name the desk carries (desk-state.ts SECTOR_MAX); a longer one is no zoom. */
const SECTOR_MAX = 64;
/** Any control character: a sector is printed, never a line break. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A zoomed sector as the link carries it, trimmed, or "" for none. The same cleaning as
 * the desk's own read, so a sector that the desk would drop is not carried to another page.
 */
export function zoomedSector(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const sector = raw.trim();
  if (sector.length === 0 || sector.length > SECTOR_MAX || CONTROL.test(sector)) return "";
  return sector;
}

/**
 * A tab's link with the reader's place carried over (spec 14.1, backlog C2): `?sel=` when
 * the page can show the selection's kind, and `?sector=` on the Overview and the map when a
 * sector is zoomed. Anything the page cannot show is left out, and with nothing left the
 * link is the bare page. The selection is read through the codec, so a malformed value is
 * dropped and never reaches a link.
 */
export function tabHref(tab: OwnershipTab | OwnershipTab["id"], params: { sel: string; sector: string }): string {
  const resolved = typeof tab === "string" ? OWNERSHIP_TABS.find((t) => t.id === tab) : tab;
  if (resolved === undefined) return "/ownership";
  const search = new URLSearchParams();
  const selection = parseSelection(params.sel ?? "");
  if (selection !== null && SHOWABLE_SELECTIONS[resolved.id].includes(selection.kind)) {
    search.set("sel", cleanSelection(params.sel));
  }
  const sector = zoomedSector(params.sector);
  if (sector !== "" && SECTOR_PAGES.includes(resolved.id)) search.set("sector", sector);
  const query = search.toString();
  return query === "" ? resolved.href : `${resolved.href}?${query}`;
}
