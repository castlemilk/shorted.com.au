import { NextResponse } from "next/server";
import { getStatisticsWithCache } from "~/lib/statistics";

export const dynamic = "force-dynamic";
export const revalidate = 60; // Revalidate every minute (cache handles longer TTL)

export async function GET() {
  try {
    // Try to get from cache first using shared library
    const { data, isCacheHit } = await getStatisticsWithCache();
    
    if (isCacheHit) {
      // getStatisticsWithCache owns the TTL: a valid hit needs no refresh.
      // Concurrent visitors must not each launch another backend request.
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
