"use client";

import { type FC } from "react";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";
import { type NavItem } from "~/@/types/nav";

export interface NavItemWithGroup extends NavItem {
  /** If true, item shows directly in the nav bar. If false, it goes in "More" dropdown. */
  primary?: boolean;
}

const items: NavItemWithGroup[] = [
  // Primary — always visible in desktop nav
  // Anchor text matches the head query the /top hub targets.
  { title: "most shorted", href: "/top", primary: true },
  { title: "screener", href: "/screener", primary: true },
  { title: "battlegrounds", href: "/battlegrounds", primary: true },
  { title: "housing", href: "/housing", primary: true },
  { title: "economy", href: "/economy", primary: true },
  // Visible with a lock when signed out — the intel workspace is the
  // flagship signed-in surface, so it stays discoverable on every page.
  { title: "politicians", href: "/politicians" },
    { title: "industry intel", href: "/industry-intelligence", requiresAuth: true, primary: true },
  // Secondary — grouped under "More" dropdown
  { title: "dashboard", href: "/dashboards", requiresAuth: true },
  { title: "AI chat", href: "/chat", requiresAuth: true },
  { title: "reports", href: "/reports" },
  { title: "statistics", href: "/statistics" },
  { title: "scans", href: "/scans" },
  { title: "news", href: "/news" },
  { title: "portfolio", href: "/portfolio", requiresAuth: true },
  { title: "about", href: "/about" },
  { title: "technology", href: "/technology" },
  { title: "metrics", href: "/metrics" },
  { title: "blog", href: "/blog" },
];

const SiteHeader: FC = () => {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl saturate-150 supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center w-full px-3 sm:px-4 md:px-6">
        <MainNav items={items} modeToggle={<ModeToggle />} />
      </div>
    </header>
  );
};

export default SiteHeader;
