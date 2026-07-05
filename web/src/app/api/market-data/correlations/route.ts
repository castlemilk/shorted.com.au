import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  buildApiUrl,
  getServerMarketDataApiUrl,
  serverFetchWithUserAgent,
} from "~/app/actions/config";
import { BROWSER_READ_RATE_LIMIT, rateLimit } from "~/@/lib/rate-limit";

const MARKET_DATA_API_URL = getServerMarketDataApiUrl();

export async function POST(request: NextRequest) {
  const rateLimitResult = await rateLimit(request, BROWSER_READ_RATE_LIMIT);

  if (!rateLimitResult.success) {
    return rateLimitResult.response;
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;

    // Forward the request to the market data service
    const response = await serverFetchWithUserAgent(
      buildApiUrl(
        MARKET_DATA_API_URL,
        "/marketdata.v1.MarketDataService/GetStockCorrelations",
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      throw new Error(
        `Market data API responded with status: ${response.status}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Handle empty response from market data service
    if (!data || Object.keys(data).length === 0) {
      return NextResponse.json({ correlations: {} });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Market data proxy error:", error);
    return NextResponse.json(
      { error: "Failed to fetch correlations" },
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
