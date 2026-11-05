"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { WorkspaceSubNav } from "~/@/components/workspace/workspace-sub-nav";
import { OWNERSHIP_GROUP, OWNERSHIP_TABS, activeOwnershipTab, tabHref } from "./nav";

/**
 * The workspace's sub-navigation (spec 14.1), under the site header and sticky at
 * `top-16` as the stock tab bar is. The shared bar prefetches by intent only
 * (pointer, touch or focus, once per href): a viewport prefetch would regenerate every
 * ISR page the bar names. The active tab reads the pathname, so this is a client island.
 *
 * The reader's selection and sector (backlog C2) ride on each tab's link, so a page
 * change keeps the place the reader is in. The URL read sits under its own Suspense,
 * as `useSearchParams` requires: the fallback is the bare links, which is the markup
 * the server renders, so the first paint and the static page carry the same bar.
 */
export function OwnershipNav() {
  return (
    <Suspense fallback={<OwnershipNavBar place={null} />}>
      <OwnershipNavLive />
    </Suspense>
  );
}

function OwnershipNavLive() {
  const params = useSearchParams();
  return <OwnershipNavBar place={{ sel: params?.get("sel") ?? "", sector: params?.get("sector") ?? "" }} />;
}

/** The reader's place on the page: the selection and the zoomed sector, as the link carries them. */
interface NavPlace {
  sel: string;
  sector: string;
}

function OwnershipNavBar({ place }: { place: NavPlace | null }) {
  const pathname = usePathname() ?? "";
  const tabs = OWNERSHIP_TABS.map((tab) => ({ ...tab, href: place === null ? tab.href : tabHref(tab, place) }));
  return <WorkspaceSubNav group={OWNERSHIP_GROUP} tabs={tabs} activeTab={activeOwnershipTab(pathname)} />;
}
