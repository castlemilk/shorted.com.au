"use client";

import { type FC } from "react";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";

const items = [
  { title: "top shorted", href: "/top" },
  { title: "dashboard", href: "/dashboards", requiresAuth: true },
  { title: "portfolio", href: "/portfolio", requiresAuth: true },
  { title: "developer", href: "/developer", requiresAuth: true },
  { title: "reports", href: "/reports" },
  { title: "about", href: "/about" },
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
