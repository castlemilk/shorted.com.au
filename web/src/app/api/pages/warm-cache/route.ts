import { type NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getTopShortsData } from "~/app/actions/getTopShorts";

// Warming fetches happen serially in small batches; allow enough wall time.
export const maxDuration = 300;

const STOCK_PAGES_TO_WARM = 30;
const FETCH_BATCH_SIZE = 5;

// Cloudflare's bot protection rejects non-browser user agents, so the
// self-fetches that re-prime the ISR cache must present a browser UA.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * ISR page-cache warming endpoint.
 *
 * The existing warm-cache crons only warm the data layer (Redis/unstable_cache).
 * This route refreshes the rendered HTML itself: it revalidates the homepage and
 * the top shorted stock pages, then fetches each one so the ISR cache is
 * re-primed with fresh data. Scheduled daily after the 2am AEST data sync so
 * real users never pay the blocking-MISS render cost.
 *
 * Can be called manually or via Vercel Cron Job.
 */
export async function GET(request: NextRequest) {
  // Optional: Protect endpoint with secret (same pattern as other warm-cache routes)
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.CACHE_WARM_SECRET;

  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const results: Record<string, { success: boolean; error?: string; ms?: number }> = {};

  try {
    // Resolve the top shorted stocks to decide which pages are worth warming.
    const topShorts = await getTopShortsData("max", STOCK_PAGES_TO_WARM, 0);
    const stockCodes = (topShorts?.timeSeries ?? [])
      .map((ts) => ts.productCode)
      .filter((code): code is string => !!code && /^[A-Z0-9]{1,4}$/.test(code));

    const paths = ["/", "/top", ...stockCodes.map((code) => `/shorts/${code}`)];

    // Invalidate first so the warming fetch regenerates with post-sync data
    // instead of just touching the existing stale entry.
    for (const path of paths) {
      revalidatePath(path);
    }

    // Re-prime in small batches to stay under Cloudflare's burst rate limit
    // (>20 req/min from one client trips bot protection).
    const origin = request.nextUrl.origin;
    for (let i = 0; i < paths.length; i += FETCH_BATCH_SIZE) {
      const batch = paths.slice(i, i + FETCH_BATCH_SIZE);
      await Promise.allSettled(
        batch.map(async (path) => {
          const pageStart = Date.now();
          try {
            const res = await fetch(`${origin}${path}`, {
              headers: { "User-Agent": BROWSER_UA },
              cache: "no-store",
            });
            results[path] = {
              success: res.ok,
              ms: Date.now() - pageStart,
              ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
            };
          } catch (error) {
            results[path] = {
              success: false,
              ms: Date.now() - pageStart,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      // Brief pause between batches to spread the burst.
      if (i + FETCH_BATCH_SIZE < paths.length) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    const successCount = Object.values(results).filter((r) => r.success).length;
    const totalCount = Object.keys(results).length;

    return NextResponse.json(
      {
        success: true,
        message: `ISR pages warmed: ${successCount}/${totalCount} successful`,
        results,
        duration: `${Date.now() - startTime}ms`,
        timestamp: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        results,
        duration: `${Date.now() - startTime}ms`,
      },
      { status: 500 },
    );
  }
}
