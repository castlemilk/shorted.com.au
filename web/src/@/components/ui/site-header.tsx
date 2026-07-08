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
  { title: "top shorted", href: "/top", primary: true },
  { title: "screener", href: "/screener", primary: true },
  { title: "battlegrounds", href: "/battlegrounds", primary: true },
  { title: "housing", href: "/housing", primary: true },
  { title: "dashboard", href: "/dashboards", requiresAuth: true, primary: true },
  { title: "AI chat", href: "/chat", requiresAuth: true, primary: true },
  { title: "reports", href: "/reports", primary: true },
  { title: "news", href: "/news", primary: true },
  // Secondary — grouped under "More" dropdown
  { title: "industry intel", href: "/industry-intelligence" },
  { title: "portfolio", href: "/portfolio", requiresAuth: true },
  { title: "about", href: "/about" },
  { title: "technology", href: "/technology" },
  { title: "metrics", href: "/metrics" },
  { title: "blog", href: "/blog" },
];

const SiteHeader: FC = () => {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl saturate-150 supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center w-full px-4 md:px-6">
        <MainNav items={items} modeToggle={<ModeToggle />} />
      </div>
    </header>
  );
};

export default SiteHeader;
