import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getMarketDataApiUrl } from "~/app/actions/config";
import { rateLimit } from "@/lib/rate-limit";

const MARKET_DATA_API_URL = getMarketDataApiUrl();

export async function POST(request: NextRequest) {
  // Apply rate limiting: 30 requests/min for anonymous, 300 for authenticated
  const rateLimitResult = await rateLimit(request, {
    anonymousLimit: 30,
    authenticatedLimit: 300,
    windowSeconds: 60,
  });

  if (!rateLimitResult.success) {
    return rateLimitResult.response;
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;

    // Forward the request to the market data service
    const response = await fetch(
      `${MARKET_DATA_API_URL}/marketdata.v1.MarketDataService/GetMultipleStockPrices`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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
      return NextResponse.json({ prices: {} });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Market data proxy error:", error);
    return NextResponse.json(
      { error: "Failed to fetch stock quotes" },
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
