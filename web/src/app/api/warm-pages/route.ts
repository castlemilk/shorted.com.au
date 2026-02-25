import { type NextRequest, NextResponse } from "next/server";

/**
 * ISR page warming endpoint.
 *
 * Makes self-referential fetch() calls to critical pages, which populates
 * the Vercel edge CDN cache (ISR). This eliminates cold hits after deploys.
 *
 * Called by:
 *  - Vercel Cron (every hour) to keep pages warm
 *  - Post-deploy script (scripts/warm-pages-after-deploy.sh) for immediate warming
 *
 * With 24-hour ISR revalidation, hourly cron ensures pages are never stale
 * and the edge cache stays populated across all active edge locations.
 */

// Core pages that should always be warm
const CORE_PAGES = [
  "/",
  "/top",
  "/industry",
  "/market",
  "/about",
];

// High-traffic stock pages (blue chips + most shorted)
const TOP_STOCK_PAGES = [
  "/shorts/BHP",
  "/shorts/CBA",
  "/shorts/CSL",
  "/shorts/NAB",
  "/shorts/WBC",
  "/shorts/ANZ",
  "/shorts/WES",
  "/shorts/MQG",
  "/shorts/WOW",
  "/shorts/TLS",
  "/shorts/RIO",
  "/shorts/FMG",
  "/shorts/GMG",
  "/shorts/TCL",
  "/shorts/WDS",
  "/shorts/NCM",
  "/shorts/ALL",
  "/shorts/COL",
  "/shorts/REA",
  "/shorts/QBE",
];

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.CACHE_WARM_SECRET;

  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve origin from the incoming request (works on Vercel and locally)
  const origin = request.nextUrl.origin;
  const startTime = Date.now();
  const results: Array<{ path: string; status: number; ms: number; cache?: string }> = [];

  const allPages = [...CORE_PAGES, ...TOP_STOCK_PAGES];

  // Warm pages in batches of 5 to avoid overwhelming the function
  const BATCH_SIZE = 5;
  for (let i = 0; i < allPages.length; i += BATCH_SIZE) {
    const batch = allPages.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (path) => {
        const fetchStart = Date.now();
        try {
          const res = await fetch(`${origin}${path}`, {
            headers: {
              // Identify warming requests in logs
              "User-Agent": "Shorted-CacheWarmer/1.0",
              // Prevent this request from being served from Next.js internal cache
              "x-no-cache": "1",
            },
            // Don't follow redirects — just warm the exact path
            redirect: "manual",
          });
          return {
            path,
            status: res.status,
            ms: Date.now() - fetchStart,
            cache: res.headers.get("x-vercel-cache") ?? undefined,
          };
        } catch (error) {
          return {
            path,
            status: 0,
            ms: Date.now() - fetchStart,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      }
    }
  }

  const duration = Date.now() - startTime;
  const succeeded = results.filter((r) => r.status === 200).length;

  return NextResponse.json(
    {
      success: true,
      message: `Warmed ${succeeded}/${allPages.length} pages in ${duration}ms`,
      pages: results,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
