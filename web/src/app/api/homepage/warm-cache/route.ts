import { type NextRequest, NextResponse } from "next/server";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { getIndustryTreeMap } from "~/app/actions/getIndustryTreeMap";
import { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";

/**
 * Cache warming endpoint for homepage data
 * Pre-populates KV cache with top shorts and treemap data
 * This dramatically improves LCP and FCP by ensuring data is ready instantly
 *
 * Can be called manually or via Vercel Cron Job
 */
export async function GET(request: NextRequest) {
  // Optional: Protect endpoint with secret
  const secret = request.nextUrl.searchParams.get("secret");
  const expectedSecret = process.env.CACHE_WARM_SECRET;

  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const startTime = Date.now();
  const results: Record<string, { success: boolean; error?: string }> = {};

  try {
    // Warm top shorts cache for default period (3m)
    try {
      await getTopShortsData("3m", 50, 0);
      results["top-shorts-3m"] = { success: true };
    } catch (error) {
      results["top-shorts-3m"] = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Warm treemap cache for default period and view mode
    try {
      await getIndustryTreeMap("3m", 10, ViewMode.CURRENT_CHANGE);
      results["treemap-3m"] = { success: true };
    } catch (error) {
      results["treemap-3m"] = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Also warm other common periods
    const periods = ["1m", "6m", "1y"];
    for (const period of periods) {
      try {
        await getTopShortsData(period, 50, 0);
        results[`top-shorts-${period}`] = { success: true };
      } catch (error) {
        results[`top-shorts-${period}`] = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

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

