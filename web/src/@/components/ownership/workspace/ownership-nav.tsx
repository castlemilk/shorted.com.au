"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef } from "react";
import { cn } from "@/lib/utils";
import { OWNERSHIP_GROUP, OWNERSHIP_TABS, activeOwnershipTab, tabHref } from "./nav";

/**
 * The workspace's sub-navigation (spec 14.1), under the site header and sticky at
 * `top-16` as the stock tab bar is. Prefetch is by intent only (pointer, touch or
 * focus, once per href): a viewport prefetch would regenerate every ISR page the
 * bar names. The active tab reads the pathname, so this is a client island.
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
            const href = place === null ? tab.href : tabHref(tab, place);
            return (
              <li key={tab.id}>
                <Link
                  href={href}
                  prefetch={false}
                  scroll
                  aria-current={isActive ? "page" : undefined}
                  onPointerEnter={() => warm(href, isActive)}
                  onTouchStart={() => warm(href, isActive)}
                  onFocus={() => warm(href, isActive)}
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
