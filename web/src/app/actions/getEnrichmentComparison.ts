"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import { SHORTS_API_URL } from "./config";
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
  const session = await auth();
  if (!session?.user?.email) {
    throw new Error("Unauthorized");
  }

  const transport = createConnectTransport({
    fetch,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);
  const internalSecret = process.env.INTERNAL_SECRET ?? "dev-internal-secret";

  const headers = {
    "X-Internal-Secret": internalSecret,
    "X-User-Email": session.user.email ?? "",
    "X-User-Id": session.user.id,
  };

  const [current, pendingResp] = await Promise.all([
    retryWithBackoff(
      () => client.getStockDetails({ productCode: stockCode }, { headers }),
      RETRY_OPTIONS,
    ),
    retryWithBackoff(
      () => client.getPendingEnrichment({ enrichmentId }, { headers }),
      RETRY_OPTIONS,
    ),
  ]);

  return {
    current,
    pending: pendingResp.pending,
  };
}
