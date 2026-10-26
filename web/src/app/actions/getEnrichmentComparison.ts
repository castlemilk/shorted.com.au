"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { EnrichmentService } from "~/gen/shorts/v1alpha1/enrichment_pb";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import { requireAdmin } from "~/server/admin";
import { internalServiceSecret } from "~/server/internal-service-secret";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { retryWithBackoff } from "@/lib/retry";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

export async function getEnrichmentComparison(
  stockCode: string,
  enrichmentId: string,
) {
  // Admin-only (enrichment review); gate in-action, not just via /admin middleware.
  const admin = await requireAdmin();

  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  const enrichmentClient = createClient(EnrichmentService, transport);
  const stockClient = createClient(StockService, transport);
  const internalSecret = internalServiceSecret();

  const headers = {
    "X-Internal-Secret": internalSecret,
    "X-User-Email": admin.email,
    "X-User-Id": admin.userId,
    // Asserted only because requireAdmin() above just passed. The API grants
    // admin from this header and from nothing else.
    "X-User-Roles": "admin",
  };

  const [current, pendingResp] = await Promise.all([
    retryWithBackoff(
      () => stockClient.getStockDetails({ productCode: stockCode }, { headers }),
      RETRY_OPTIONS,
    ),
    retryWithBackoff(
      () => enrichmentClient.getPendingEnrichment({ enrichmentId }, { headers }),
      RETRY_OPTIONS,
    ),
  ]);

  return {
    current,
    pending: pendingResp.pending,
  };
}
