"use client";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type StockDetails, type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { getShortsApiUrl } from "../config";

/**
 * Client-side fetch for stock details.
 * Use this for client-side retries when SSR fails.
 */
export async function fetchStockDetailsClient(
  productCode: string,
): Promise<StockDetails | null> {
  try {
    const transport = createConnectTransport({
      baseUrl: getShortsApiUrl(),
    });
    const client = createClient(ShortedStocksService, transport);
    const response = await client.getStockDetails({ productCode });
    return response;
  } catch (error) {
    console.error(`Client-side fetchStockDetails failed for ${productCode}:`, error);
    throw error;
  }
}

/**
 * Client-side fetch for basic stock info.
 * Use this for client-side retries when SSR fails.
 */
export async function fetchStockClient(
  productCode: string,
): Promise<Stock | null> {
  try {
    const transport = createConnectTransport({
      baseUrl: getShortsApiUrl(),
    });
    const client = createClient(ShortedStocksService, transport);
    const response = await client.getStock({ productCode });
    return response;
  } catch (error) {
    console.error(`Client-side fetchStock failed for ${productCode}:`, error);
    throw error;
  }
}
