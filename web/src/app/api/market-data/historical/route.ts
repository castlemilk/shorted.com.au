import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import {
  buildApiUrl,
  getServerMarketDataApiUrl,
  serverFetchWithUserAgent,
} from "~/app/actions/config";
import { BROWSER_READ_RATE_LIMIT, rateLimit } from "~/@/lib/rate-limit";
import { recordProductEvent } from "~/@/lib/product-events";

const MARKET_DATA_API_URL = getServerMarketDataApiUrl();
const HISTORICAL_MARKET_DATA_CACHE_SECONDS = 86400;
const CACHE_HEADERS = {
  "Cache-Control": `public, s-maxage=${HISTORICAL_MARKET_DATA_CACHE_SECONDS}, stale-while-revalidate=${HISTORICAL_MARKET_DATA_CACHE_SECONDS}`,
  "X-Shorted-Market-Cache": "HITABLE",
};

interface HistoricalPricesRequest {
  stockCode: string;
  period: string;
}

async function fetchHistoricalPrices({
  stockCode,
  period,
}: HistoricalPricesRequest): Promise<Record<string, unknown>> {
  const response = await serverFetchWithUserAgent(
    buildApiUrl(
      MARKET_DATA_API_URL,
      "/marketdata.v1.MarketDataService/GetHistoricalPrices",
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({ stockCode, period }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    if (response.status === 400 || response.status === 404) {
      return { prices: [] };
    }
    throw new Error(
      `Market data API responded with status: ${response.status}`,
    );
  }

  const data = (await response.json()) as unknown;

  if (
    !data ||
    typeof data !== "object" ||
    Object.keys(data as Record<string, unknown>).length === 0
  ) {
    return { prices: [] };
  }

  return data as Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  const rateLimitResult = await rateLimit(request, BROWSER_READ_RATE_LIMIT);

  if (!rateLimitResult.success) {
    recordProductEvent({
      feature: "market_data",
      action: "historical_prices",
      status: "rate_limited",
      properties: {
        route_group: "/api/market-data/*",
        limit_kind: "per_minute",
        tier: rateLimitResult.tier,
      },
    });
    return rateLimitResult.response;
  }
  try {
    const body = (await request.json()) as {
      stockCode: string;
      period?: string;
    };

    // Pass the period directly to the market data service
    const requestBody = {
      stockCode: body.stockCode?.toUpperCase() ?? "",
      period: body.period?.toLowerCase() ?? "3m",
    };

    const data = await unstable_cache(
      () => fetchHistoricalPrices(requestBody),
      [
        "market-data",
        "historical",
        requestBody.stockCode,
        requestBody.period,
      ],
      {
        tags: [
          "market-data",
          `market-historical:${requestBody.stockCode}:${requestBody.period}`,
        ],
        revalidate: HISTORICAL_MARKET_DATA_CACHE_SECONDS,
      },
    )();

    return NextResponse.json(data, { headers: CACHE_HEADERS });
  } catch (error) {
    console.error("Market data proxy error:", error);
    return NextResponse.json(
      { error: "Failed to fetch historical data" },
      { status: 500 },
    );
  }
}

export async function OPTIONS(_request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
