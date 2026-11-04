"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { OWNERSHIP_GROUP, OWNERSHIP_TABS, activeOwnershipTab } from "./nav";

/**
 * The workspace's sub-navigation (spec 14.1), under the site header and sticky at
 * `top-16` as the stock tab bar is. Prefetch is by intent only (pointer, touch or
 * focus, once per href): a viewport prefetch would regenerate every ISR page the
 * bar names. The active tab reads the pathname, so this is a client island.
 */
export function OwnershipNav() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const active = activeOwnershipTab(pathname);
  const prefetched = useRef<Set<string>>(new Set());

  const warm = (href: string, isActive: boolean) => {
    if (isActive || prefetched.current.has(href)) return;
    prefetched.current.add(href);
    router.prefetch(href);
  };

  return (
    <nav
      aria-label={OWNERSHIP_GROUP}
      className="sticky top-16 z-30 border-b border-border bg-background/95 backdrop-blur"
    >
      <div className="mx-auto flex max-w-[1400px] items-center gap-6 overflow-x-auto px-4 sm:px-8">
        <p className="shrink-0 py-3 font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
          {OWNERSHIP_GROUP}
        </p>
        <ul className="flex shrink-0 items-center gap-1">
          {OWNERSHIP_TABS.map((tab) => {
            const isActive = tab.id === active;
            return (
              <li key={tab.id}>
                <Link
                  href={tab.href}
                  prefetch={false}
                  scroll
                  aria-current={isActive ? "page" : undefined}
                  onPointerEnter={() => warm(tab.href, isActive)}
                  onTouchStart={() => warm(tab.href, isActive)}
                  onFocus={() => warm(tab.href, isActive)}
                  className={cn(
                    "-mb-px inline-flex items-center border-b-2 px-2 py-3 font-mono text-sm transition-colors",
                    isActive
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
