import { type NextRequest, NextResponse } from "next/server";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { CACHE_KEYS, setCached } from "~/@/lib/kv-cache";
import type { AboutPageStatistics } from "~/app/about/actions/get-statistics";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import type { Timestamp } from "@bufbuild/protobuf/wkt";

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
    // Warm statistics cache
    try {
      const response = await getTopShortsData("max", 1000, 0);
      
      const timeSeries = response.timeSeries ?? [];
      const uniqueCompanies = new Set(
        timeSeries.map((ts: TimeSeriesData) => ts.productCode).filter(Boolean)
      );
      
      const companyCount = uniqueCompanies.size;
      const industryCount = Math.min(35, Math.max(25, Math.floor(companyCount / 15)));
      
      let latestUpdateDate: Date | null = null;
      if (timeSeries.length > 0) {
        for (const ts of timeSeries) {
          if (ts.points && ts.points.length > 0) {
            const latestPoint = ts.points[ts.points.length - 1];
            if (latestPoint?.timestamp) {
              const timestamp: Timestamp = latestPoint.timestamp;
              const seconds = timestamp.seconds ? Number(timestamp.seconds) : 0;
              const nanos = timestamp.nanos ? Number(timestamp.nanos) / 1_000_000_000 : 0;
              const pointDate = new Date((seconds + nanos) * 1000);
              if (!latestUpdateDate || pointDate > latestUpdateDate) {
                latestUpdateDate = pointDate;
              }
            }
          }
        }
      }

      // Serialize date for cache storage
      const statistics: AboutPageStatistics = {
        companyCount,
        industryCount,
        latestUpdateDate: latestUpdateDate ? latestUpdateDate : null,
      };

      results.statistics = await setCached(
        CACHE_KEYS.statistics,
        statistics,
        300, // 5 minutes
      );
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

