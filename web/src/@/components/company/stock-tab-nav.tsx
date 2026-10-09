"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "~/@/lib/utils";
import {
  STOCK_TABS,
  activeStockTab,
  stockTabHref,
} from "~/@/lib/stocks/stock-tabs";

/**
 * The stock page's tab bar: seven plain links (crawlable, SSR'd by the server
 * layout that renders this). Prefetch is INTENT-driven — pointer enter, touch
 * start or focus, once per href — never on viewport entry: seven viewport
 * prefetches per page view would quietly regenerate seven ISR routes.
 */
export function StockTabNav({ stockCode }: { stockCode: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const active = activeStockTab(pathname ?? "");
  const prefetched = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const warm = useCallback(
    (href: string, isActive: boolean) => {
      if (isActive || prefetched.current.has(href)) return;
      prefetched.current.add(href);
      router.prefetch(href);
    },
    [router],
  );

  // Seven triggers overflow on a phone: keep the active one in view.
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !el) return;
    if (
      el.offsetLeft + el.offsetWidth > list.scrollLeft + list.clientWidth ||
      el.offsetLeft < list.scrollLeft
    ) {
      list.scrollTo({ left: el.offsetLeft - 16 });
    }
  }, [active]);

  return (
    <nav aria-label="Stock sections" className="mb-4">
      <div
        ref={listRef}
        className="flex w-full items-center gap-1 overflow-x-auto rounded-md bg-muted p-1 text-muted-foreground"
      >
        {STOCK_TABS.map((tab) => {
          const href = stockTabHref(stockCode, tab.id);
          const isActive = tab.id === active;
          return (
            <Link
              key={tab.id}
              href={href}
              prefetch={false}
              aria-current={isActive ? "page" : undefined}
              onPointerEnter={() => warm(href, isActive)}
              onTouchStart={() => warm(href, isActive)}
              onFocus={() => warm(href, isActive)}
              className={cn(
                "inline-flex shrink-0 items-center rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
