import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  buildApiUrl,
  getServerMarketDataApiUrl,
  serverFetchWithUserAgent,
} from "~/app/actions/config";
import { BROWSER_READ_RATE_LIMIT, rateLimit } from "~/@/lib/rate-limit";
import { recordProductEvent } from "~/@/lib/product-events";
import {
  getSharedStockQuotes,
  normalizeQuoteCodes,
} from "~/@/lib/shared-stock-quotes";

const MARKET_DATA_API_URL = getServerMarketDataApiUrl();

// Valid batch quote responses can take over 30 seconds at the origin.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const rateLimitResult = await rateLimit(request, BROWSER_READ_RATE_LIMIT);

  if (!rateLimitResult.success) {
    recordProductEvent({
      feature: "market_data",
      action: "multiple_quotes",
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
    let codes: string[];
    try {
      codes = normalizeQuoteCodes(await request.json());
    } catch {
      return NextResponse.json(
        { error: "Provide 1–50 stock codes of 3–4 letters" },
        { status: 400 },
      );
    }
    const result = await getSharedStockQuotes(
      codes,
      request.signal,
      async (stockCodes, signal) => {
        const response = await serverFetchWithUserAgent(
          buildApiUrl(
            MARKET_DATA_API_URL,
            "/marketdata.v1.MarketDataService/GetMultipleStockPrices",
          ),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Connect-Protocol-Version": "1",
            },
            body: JSON.stringify({ stockCodes }),
            cache: "no-store",
            signal,
          },
        );

        if (!response.ok)
          throw new Error(
            `Market data API responded with status: ${response.status}`,
          );
        return response.json();
      },
    );
    return NextResponse.json(
      { prices: result.prices },
      {
        headers: { "Cache-Control": "no-store", "X-Quote-Cache": result.cache },
      },
    );
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
