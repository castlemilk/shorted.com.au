import { NextRequest, NextResponse } from "next/server";
import { getMarketDataApiUrl } from "~/app/actions/config";

const MARKET_DATA_API_URL = getMarketDataApiUrl();

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      stockCode: string;
      period?: string;
    };

    // Pass the period directly to the market data service
    const requestBody = {
      stockCode: body.stockCode?.toUpperCase() || "",
      period: body.period?.toLowerCase() || "3m",
    };

    // Forward the request to the market data service
    const response = await fetch(
      `${MARKET_DATA_API_URL}/marketdata.v1.MarketDataService/GetHistoricalPrices`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );

    // If the market data service returns 400/404, the stock doesn't have data
    // Return empty array instead of erroring
    if (!response.ok) {
      if (response.status === 400 || response.status === 404) {
        return NextResponse.json({ prices: [] });
      }
      throw new Error(
        `Market data API responded with status: ${response.status}`,
      );
    }

    const data = await response.json();

    // Handle empty response from market data service (stock not found)
    if (!data || Object.keys(data).length === 0) {
      return NextResponse.json({ prices: [] });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Market data proxy error:", error);
    return NextResponse.json(
      { error: "Failed to fetch historical data" },
      { status: 500 },
    );
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
