"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { cn } from "~/@/lib/utils";

/** One tab of a workspace's sub-navigation: a page the group links to. */
export interface WorkspaceTab<Id extends string = string> {
  id: Id;
  label: string;
  href: string;
}

export interface WorkspaceSubNavProps<Id extends string = string> {
  /** The group's name: the bar's label on the left and, unless `label` is given, its accessible name. */
  group: string;
  /**
   * The bar's accessible name when it differs from the visible group name. A page
   * with its own in-page navigation under the same name gives the bar a distinct one,
   * so screen readers can tell the two landmarks apart.
   */
  label?: string;
  tabs: readonly WorkspaceTab<Id>[];
  /** The tab the current page belongs to, or null when none does. */
  activeTab: Id | null;
  /**
   * Sticks under the site header at `top-16`. A profile route passes false, so its own
   * tab bar is the one sticky bar and this one scrolls away above it.
   */
  sticky?: boolean;
}

/**
 * A workspace's sub-navigation (ownership explorer design, section 14.1), the bar under the site header. The
 * caller says which tab is active and whether the bar sticks, so the registry and
 * the pathname rule stay with the workspace that owns them.
 *
 * Prefetch is by intent only (pointer, touch or focus, once per href): a viewport
 * prefetch would regenerate every ISR page the bar names. The bar takes its
 * router, so it is a client module.
 */
export function WorkspaceSubNav<Id extends string>({
  group,
  label,
  tabs,
  activeTab,
  sticky = true,
}: WorkspaceSubNavProps<Id>) {
  const router = useRouter();
  const prefetched = useRef<Set<string>>(new Set());

  const warm = (href: string, isActive: boolean) => {
    if (isActive || prefetched.current.has(href)) return;
    prefetched.current.add(href);
    router.prefetch(href);
  };

  return (
    <nav
      aria-label={label ?? group}
      className={cn(sticky && "sticky top-16 z-30", "border-b border-border bg-background/95 backdrop-blur")}
    >
      <div className="mx-auto flex max-w-[1400px] items-center gap-6 overflow-x-auto px-4 sm:px-8">
        <p className="shrink-0 py-3 font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">{group}</p>
        <ul className="flex shrink-0 items-center gap-1">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;
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
