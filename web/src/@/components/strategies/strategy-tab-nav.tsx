"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFocusClearance } from "~/@/hooks/use-focus-clearance";
import { cn, isPlainLeftClick } from "~/@/lib/utils";
import {
  activeStrategyTab,
  enabledStrategyTabs,
  strategyTabHref,
} from "~/@/lib/strategies/strategy-tabs";

// The bar is rendered on the server too, where a layout effect only warns.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

// The bar's `top-16` (the site header's h-16 row), for when its computed top
// cannot be read as a number.
const DEFAULT_STICKY_TOP = 64;

/**
 * The profile's tab bar. A focused copy of the stock page's tab bar
 * (components/company/stock-tab-nav.tsx), with the same three behaviours:
 *
 * - Prefetch is intent-driven (pointer enter, touch start or focus, once per
 *   href), never on viewport entry: each viewport prefetch would regenerate an
 *   ISR tab.
 * - Links pass `scroll={false}`, because Next's own scroll on a tab switch
 *   leaves the new tab's first rows under the two bars. A click sets a flag,
 *   and when the active tab changes a layout effect scrolls the page to where
 *   the new tab starts under the docked bar, only when the page was scrolled
 *   past that point. Back and forward keep the scroll the browser restores.
 * - Keyboard focus is kept out from under the docked bar.
 *
 * It lists only the tabs whose pages ship (enabledStrategyTabs). The stock
 * bar's edge fade and its horizontal scroll arrive with the second tab.
 */
export function StrategyTabNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const active = activeStrategyTab(pathname ?? "");
  const prefetched = useRef<Set<string>>(new Set());
  const navRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });

  /** Which edge of the bar can still scroll: the fade marks it, as the stock page's tab bar does. */
  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft > 1, end: max - el.scrollLeft > 1 });
  }, []);

  // The active tab is brought into the bar's view (on the bar only; the page does not scroll).
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    const link = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && link) {
      const target = link.offsetLeft - (el.clientWidth - link.offsetWidth) / 2;
      el.scrollLeft = Math.max(0, Math.min(target, el.scrollWidth - el.clientWidth));
    }
    updateEdges();
  }, [active, updateEdges]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Set by a click on a tab, consumed when the active tab changes.
  const pendingClick = useRef(false);
  const mounted = useRef(false);

  const warm = useCallback(
    (href: string, isActive: boolean) => {
      if (isActive || prefetched.current.has(href)) return;
      prefetched.current.add(href);
      router.prefetch(href);
    },
    [router],
  );

  useIsomorphicLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!pendingClick.current) return;
    pendingClick.current = false;

    const sentinel = sentinelRef.current;
    const nav = navRef.current;
    if (!sentinel || !nav) return;
    const stickyTop =
      parseFloat(getComputedStyle(nav).top) || DEFAULT_STICKY_TOP;
    const dockY =
      sentinel.getBoundingClientRect().top + window.scrollY - stickyTop;
    if (window.scrollY > dockY + 1) {
      window.scrollTo({ top: dockY, left: window.scrollX });
    }
  }, [active]);

  useFocusClearance(navRef, DEFAULT_STICKY_TOP);

  return (
    <>
      {/* Zero height and in flow: where the bar sits before it docks. */}
      <div ref={sentinelRef} aria-hidden="true" className="h-0" />
      <nav
        ref={navRef}
        aria-label="Strategy sections"
        className="sticky top-16 z-30 -mx-8 mb-4 border-b border-border bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75"
      >
        <div
          ref={scrollRef}
          onScroll={updateEdges}
          data-scroll-start={edges.start ? "" : undefined}
          data-scroll-end={edges.end ? "" : undefined}
          style={edgeMask(edges)}
          className="flex h-11 scroll-px-8 items-stretch gap-1 overflow-x-auto px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {enabledStrategyTabs().map((tab) => {
            const href = strategyTabHref(slug, tab.id);
            const isActive = tab.id === active;
            return (
              <Link
                key={tab.id}
                href={href}
                prefetch={false}
                scroll={false}
                aria-current={isActive ? "page" : undefined}
                onClick={(e) => {
                  if (!isActive && isPlainLeftClick(e))
                    pendingClick.current = true;
                }}
                onPointerEnter={() => warm(href, isActive)}
                onTouchStart={() => warm(href, isActive)}
                onFocus={() => warm(href, isActive)}
                className={cn(
                  "relative inline-flex shrink-0 items-center px-3 font-mono text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isActive
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                {isActive ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-primary"
                  />
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}

/** The fade that marks a scrollable edge: a 40px mask on the side that still scrolls. */
function edgeMask(edges: { start: boolean; end: boolean }): React.CSSProperties | undefined {
  if (!edges.start && !edges.end) return undefined;
  const left = edges.start ? "transparent, #000 40px" : "#000 0";
  const right = edges.end ? "#000 calc(100% - 40px), transparent" : "#000 100%";
  const mask = `linear-gradient(to right, ${left}, ${right})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}
