"use client";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  toSnapshot,
  type IndustryIntelligenceSnapshot,
} from "~/@/lib/industry-intelligence-snapshot";
import { getShortsApiUrl } from "../config";

/**
 * Client-side fetch of the industry-intelligence evidence snapshot.
 *
 * Used by the stock page's dossier panel, which is authenticated-only: the
 * data is fetched from the browser AFTER the session resolves, so it never
 * ships in the (shared, ISR-cached) page payload to signed-out visitors.
 */
export async function fetchIndustryIntelligenceSnapshotClient(
  industry: string,
  recordLimit = 50,
  stockCode = "",
): Promise<IndustryIntelligenceSnapshot | null> {
  try {
    // Relative URL in the browser so the call flows through Next rewrites.
    const transport = createConnectTransport({
      baseUrl: typeof window !== "undefined" ? "" : getShortsApiUrl(),
    });
    const client = createClient(ShortedStocksService, transport);
    const response = await client.getIndustryIntelligence({
      industry,
      recordLimit,
      stockCode,
    });
    return toSnapshot(response);
  } catch (error) {
    console.error("Client-side industry intelligence fetch failed:", error);
    return null;
  }
}
