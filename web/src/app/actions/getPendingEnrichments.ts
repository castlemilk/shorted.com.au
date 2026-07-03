"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { requireAdmin } from "~/server/admin";
import { SHORTS_API_URL } from "./config";
import { retryWithBackoff } from "@/lib/retry";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

export async function getPendingEnrichments(limit = 100, offset = 0) {
  // Admin-only (enrichment review); gate in-action, not just via /admin middleware.
  const admin = await requireAdmin();

  const transport = createConnectTransport({
    fetch,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  const internalSecret = process.env.INTERNAL_SECRET ?? "dev-internal-secret";

  const resp = await retryWithBackoff(
    () =>
      client.listPendingEnrichments(
        { limit, offset },
        {
          headers: {
            "X-Internal-Secret": internalSecret,
            "X-User-Email": admin.email,
            "X-User-Id": admin.userId,
          },
        },
      ),
    RETRY_OPTIONS,
  );

  return resp.enrichments ?? [];
}
