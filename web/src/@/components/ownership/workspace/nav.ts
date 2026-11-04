/**
 * The workspace's sub-navigation (spec 14.1): one group, "Ownership", and its
 * seven pages in the order the wireframes give. A pure module, so the active
 * tab and the link set are tested without a DOM.
 */

export interface OwnershipTab {
  id: "overview" | "map" | "connections" | "activity" | "funds" | "holders" | "changes";
  label: string;
  href: string;
}

export const OWNERSHIP_GROUP = "Ownership";

export const OWNERSHIP_TABS: readonly OwnershipTab[] = [
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
export function activeOwnershipTab(pathname: string): OwnershipTab["id"] | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/ownership") return "overview";
  for (const tab of OWNERSHIP_TABS) {
    if (tab.id === "overview") continue;
    if (path === tab.href || path.startsWith(`${tab.href}/`)) return tab.id;
  }
  return null;
}
