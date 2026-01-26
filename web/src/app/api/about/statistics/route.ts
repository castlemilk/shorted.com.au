import { NextResponse } from "next/server";
import { fetchAndCacheStatistics, getStatisticsWithCache } from "~/lib/statistics";

export const dynamic = "force-dynamic";
export const revalidate = 60; // Revalidate every minute (cache handles longer TTL)

/**
 * Background cache refresh function
 * Fetches fresh data and updates cache without blocking the response
 */
async function refreshCacheInBackground(): Promise<void> {
  try {
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Background refresh timeout")), 10000);
    });
    
    await Promise.race([
      fetchAndCacheStatistics(),
      timeoutPromise,
    ]);
  } catch (error) {
    // Silently fail - this is background refresh, don't log errors that might spam logs
    // Only log if it's not a timeout or connection error
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (!errorMsg.includes("timeout") && !errorMsg.includes("ECONNREFUSED") && !errorMsg.includes("fetch failed")) {
      console.error("Background cache refresh error:", errorMsg);
    }
  }
}

export async function GET() {
  try {
    // Try to get from cache first using shared library
    const { data, isCacheHit } = await getStatisticsWithCache();
    
    if (isCacheHit) {
      // Trigger background refresh (don't await)
      refreshCacheInBackground().catch((error) => {
        console.error("Background cache refresh failed:", error);
      });
      
      return NextResponse.json(data, {
        headers: {
          "X-Cache": "HIT",
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600", // 1 hour stale window
        },
      });
    }

    // Cache miss - data was already fetched fresh by getStatisticsWithCache
    console.log("Serving fresh statistics...");
    
    // Validate fetched data
    if (data.companyCount === 0 && data.industryCount === 0) {
      console.warn("Fetched statistics are all zeros - this might indicate a data issue");
    }
    
    return NextResponse.json(data, {
      headers: {
        "X-Cache": "MISS",
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600", // 1 hour stale window
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Error fetching statistics:", errorMsg);
    console.error("Full error:", error);
    // Return safe defaults on error
    return NextResponse.json(
      {
        companyCount: 0,
        industryCount: 0,
        latestUpdateDate: null,
        error: errorMsg, // Include error in response for debugging
      },
      { status: 500 }
    );
  }
}
