import { Page } from "@playwright/test";

export interface PageMetrics {
  ttfb: number;
  fcp: number;
  lcp: number;
  cls: number;
}

/**
 * Injects PerformanceObserver scripts BEFORE navigation so we catch
 * early paint events (FCP, LCP) that fire before page.evaluate() could
 * register observers. Stores results on window.__cwv.
 */
export async function injectCWVCollector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__cwv = {
      fcp: 0,
      lcp: 0,
      cls: 0,
      ttfb: 0,
    };

    // First Contentful Paint
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") {
          (window as any).__cwv.fcp = entry.startTime;
        }
      }
    }).observe({ type: "paint", buffered: true });

    // Largest Contentful Paint (takes last entry — the actual LCP)
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length > 0) {
        (window as any).__cwv.lcp = entries[entries.length - 1].startTime;
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });

    // Cumulative Layout Shift
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!(entry as any).hadRecentInput) {
          (window as any).__cwv.cls += (entry as any).value;
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

/**
 * Collects CWV metrics after the page has loaded and settled.
 * Call this after navigation + waiting for meaningful content.
 *
 * @param page - Playwright page (must have had injectCWVCollector called before navigation)
 * @param settleMs - Extra time to wait for late LCP/CLS entries (default 2000ms)
 */
export async function collectCWV(
  page: Page,
  settleMs = 2000,
): Promise<PageMetrics> {
  // Let late layout shifts and LCP candidates settle
  await page.waitForTimeout(settleMs);

  const metrics = await page.evaluate(() => {
    const cwv = (window as any).__cwv || {
      fcp: 0,
      lcp: 0,
      cls: 0,
      ttfb: 0,
    };

    // TTFB from Navigation Timing API
    const nav = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming;
    if (nav) {
      cwv.ttfb = nav.responseStart - nav.fetchStart;
    }

    return {
      ttfb: Math.round(cwv.ttfb),
      fcp: Math.round(cwv.fcp),
      lcp: Math.round(cwv.lcp),
      cls: Math.round(cwv.cls * 1000) / 1000, // 3 decimal places
    };
  });

  return metrics;
}

/**
 * Formats a metrics object into a readable summary line.
 */
export function formatMetrics(label: string, m: PageMetrics): string {
  return `${label} — TTFB: ${m.ttfb}ms, FCP: ${m.fcp}ms, LCP: ${m.lcp}ms, CLS: ${m.cls}`;
}
