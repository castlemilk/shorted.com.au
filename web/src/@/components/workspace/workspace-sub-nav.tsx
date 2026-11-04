"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef } from "react";
import { useFocusClearance } from "~/@/hooks/use-focus-clearance";
import { cn } from "~/@/lib/utils";

// The workspace bar sticks under the site header, which is h-16 (64px) tall.
const WORKSPACE_STICKY_TOP = 64;

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
  /** The tab the current page belongs to, or null when none does. It is highlighted. */
  activeTab: Id | null;
  /**
   * The tab whose href is the page itself, marked `aria-current="page"`. Defaults to
   * `activeTab`. When it differs, `activeTab` is only the section the page sits in
   * (a changelog under Explore, a profile under Explore), so that tab is marked
   * `aria-current="location"` and the page's own link is named by the page's own bar.
   */
  currentTab?: Id | null;
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
  currentTab,
  sticky = true,
}: WorkspaceSubNavProps<Id>) {
  const current = currentTab === undefined ? activeTab : currentTab;
  const router = useRouter();
  const prefetched = useRef<Set<string>>(new Set());
  const navRef = useRef<HTMLElement>(null);

  const warm = (href: string, isActive: boolean) => {
    if (isActive || prefetched.current.has(href)) return;
    prefetched.current.add(href);
    router.prefetch(href);
  };

  // Keeps a control the keyboard focuses from scrolling under the bar while it sticks. A
  // non-sticky bar has no ref, so the hook has nothing to act on.
  useFocusClearance(navRef, WORKSPACE_STICKY_TOP);

  return (
    <nav
      ref={sticky ? navRef : undefined}
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
                  aria-current={tab.id === current ? "page" : isActive ? "location" : undefined}
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
