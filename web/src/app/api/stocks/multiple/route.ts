import { type NextRequest, NextResponse } from "next/server";
import { MARKET_DATA_API_URL } from "~/app/actions/config";

export const dynamic = "force-dynamic";

interface StockMultipleRequest {
  stockCodes: string[];
}

interface PriceDataItem {
  stock_code: string;
  change_percent?: number;
  close?: number;
}

interface PriceDataResponse {
  data?: PriceDataItem[];
}

interface ConnectRPCStockPrice {
  stock_code: string;
  date?: string;
  close?: number;
  change?: number;
  change_percent?: number;
}

interface ConnectRPCResponse {
  prices?: Record<string, ConnectRPCStockPrice>;
}

/**
 * Proxy endpoint for fetching multiple stock prices
 * Uses Connect RPC endpoint to avoid CORS issues
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as StockMultipleRequest;
    const { stockCodes } = body;

    if (!stockCodes || !Array.isArray(stockCodes)) {
      return NextResponse.json(
        { error: "stockCodes array is required" },
        { status: 400 }
      );
    }

    const marketDataUrl = MARKET_DATA_API_URL;
    
    // Use Connect RPC endpoint (protobuf over HTTP)
    const response = await fetch(
      `${marketDataUrl}/marketdata.v1.MarketDataService/GetMultipleStockPrices`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stock_codes: stockCodes }),
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      // If 404 or 400, return empty data (stocks might not exist)
      if (response.status === 404 || response.status === 400) {
        return NextResponse.json({ data: [] });
      }
      throw new Error(`Market data API returned ${response.status}`);
    }

    const connectData = (await response.json()) as ConnectRPCResponse;

    // Transform Connect RPC response format to expected format
    const data: PriceDataResponse = {
      data: [],
    };

    if (connectData.prices) {
      data.data = Object.entries(connectData.prices).map(([code, price]) => ({
        stock_code: code,
        close: price.close,
        change_percent: price.change_percent,
      }));
    }

    return NextResponse.json(data, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  } catch (error) {
    console.error("Error proxying stock data request:", error);
    // Return empty data instead of error to prevent UI issues
    return NextResponse.json(
      { data: [] },
      { status: 200 }
    );
  }
}

// Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

