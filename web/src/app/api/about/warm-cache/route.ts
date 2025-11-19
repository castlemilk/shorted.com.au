import { type NextRequest, NextResponse } from "next/server";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { CACHE_KEYS, setCached } from "~/@/lib/kv-cache";
import { fetchAndCacheStatistics } from "~/lib/statistics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * API route to warm the cache for about page data
 * Can be called via cron job or webhook to pre-populate cache
 * 
 * Usage:
 * - Cron: Set up Vercel Cron to call this endpoint every 5 minutes
 * - Manual: GET /api/about/warm-cache?secret=YOUR_SECRET
 */
export async function GET(request: NextRequest) {
  // Optional: Add authentication/secret check for security
  const secret = process.env.CACHE_WARM_SECRET;
  const url = new URL(request.url);
  const providedSecret = url.searchParams.get("secret");

  if (secret && providedSecret !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = {
    statistics: false,
    topStocks: false,
    errors: [] as string[],
  };

  // Check if backend services are available (skip in development if not running)
  const isDevelopment = process.env.NODE_ENV === "development";
  const backendUrl = process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? "http://localhost:9091";
  
  // In development, check if backend is available before attempting to warm cache
  if (isDevelopment) {
    try {
      const healthCheck = await fetch(`${backendUrl.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(2000),
      }).catch(() => null);
      
      if (!healthCheck || !healthCheck.ok) {
        return NextResponse.json({
          success: false,
          message: "Backend services not available - skipping cache warm",
          results,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      return NextResponse.json({
        success: false,
        message: "Backend services not available - skipping cache warm",
        results,
        timestamp: new Date().toISOString(),
      });
    }
  }

  try {
    // Warm statistics cache using shared library
    try {
      const stats = await fetchAndCacheStatistics();
      // Consider success if we got some data
      results.statistics = stats.companyCount > 0 || stats.industryCount > 0;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("Error warming statistics cache:", errorMsg);
      results.errors.push(`Statistics cache: ${errorMsg}`);
    }

    // Warm top stocks cache (for animated ticker)
    try {
      const topStocksResponse = await getTopShortsData("3m", 5, 0);
      results.topStocks = await setCached(
        CACHE_KEYS.topStocks(5),
        topStocksResponse,
        300, // 5 minutes
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("Error warming top stocks cache:", errorMsg);
      results.errors.push(`Top stocks cache: ${errorMsg}`);
    }

    return NextResponse.json({
      success: results.statistics || results.topStocks,
      results,
      errors: results.errors.length > 0 ? results.errors : undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Error warming cache:", errorMsg);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to warm cache",
        message: errorMsg,
        results,
        errors: results.errors,
      },
      { status: 500 },
    );
  }
}

// Also support POST for webhook/cron
export const POST = GET;
