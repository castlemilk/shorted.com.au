import { type NextRequest, NextResponse } from "next/server";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { getIndustryTreeMap } from "~/app/actions/getIndustryTreeMap";
import { isCacheWarmAuthorized } from "~/@/lib/cache-warm-auth";

// ViewMode enum value - using constant to avoid protobuf-es SSR issues
const VIEW_MODE_CURRENT_CHANGE = 0;

// Static on purpose. Production does not set CACHE_WARM_SECRET, so
// isCacheWarmAuthorized returns before it reads the request, and this route
// prerenders and revalidates once a day (86400 s, the HOMEPAGE_TTL that the
// connect reads below carry). Next 15 would render it per request instead, and
// with no secret that leaves its five data reads open to anyone. force-static
// empties the request's headers and query string, so once CACHE_WARM_SECRET is
// set this must become `dynamic = "force-dynamic"`: otherwise every call fails
// the check and gets a cached 401.
export const dynamic = "force-static";
export const revalidate = 86400;

/**
 * Cache warming endpoint for homepage data
 * Pre-populates KV cache with top shorts and treemap data
 * This dramatically improves LCP and FCP by ensuring data is ready instantly
 *
 * Can be called manually or via Vercel Cron Job
 */
export async function GET(request: NextRequest) {
  if (!isCacheWarmAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const startTime = Date.now();
  const results: Record<string, { success: boolean; error?: string }> = {};

  try {
    // Warm all caches in parallel — these are independent operations
    const settled = await Promise.allSettled([
      getTopShortsData("3m", 50, 0),
      getIndustryTreeMap("3m", 10, VIEW_MODE_CURRENT_CHANGE),
      getTopShortsData("1m", 50, 0),
      getTopShortsData("6m", 50, 0),
      getTopShortsData("1y", 50, 0),
    ]);

    const keys = ["top-shorts-3m", "treemap-3m", "top-shorts-1m", "top-shorts-6m", "top-shorts-1y"];
    settled.forEach((result, i) => {
      results[keys[i]!] = result.status === "fulfilled"
        ? { success: true }
        : { success: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
    });

    const duration = Date.now() - startTime;
    const successCount = Object.values(results).filter((r) => r.success).length;
    const totalCount = Object.keys(results).length;

    return NextResponse.json(
      {
        success: true,
        message: `Cache warmed: ${successCount}/${totalCount} successful`,
        results,
        duration: `${duration}ms`,
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
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
