"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { EnrichmentService } from "~/gen/shorts/v1alpha1/enrichment_pb";
import { requireAdmin } from "~/server/admin";
import { internalServiceSecret } from "~/server/internal-service-secret";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { retryWithBackoff } from "@/lib/retry";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

export async function listEnrichmentJobs(
  limit = 100,
  offset = 0,
  status?: number,
) {
  // Gate in-action. Server actions are addressable by action-id, so the
  // session flag a caller checks in the UI is not authorization on its own.
  const admin = await requireAdmin();

  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(EnrichmentService, transport);

  const internalSecret = internalServiceSecret();

  try {
    const resp = await retryWithBackoff(
      () =>
        client.listEnrichmentJobs(
          {
            limit,
            offset,
            status: status ?? 0, // 0 = UNSPECIFIED (all statuses)
          },
          {
            headers: {
              "X-Internal-Secret": internalSecret,
              "X-User-Email": admin.email,
              "X-User-Id": admin.userId,
              // Asserted only because requireAdmin() above just passed.
              "X-User-Roles": "admin",
            },
          },
        ),
      RETRY_OPTIONS,
    );

    return {
      jobs: resp.jobs ?? [],
      totalCount: resp.totalCount ?? 0,
    };
  } catch (error) {
    console.error("Failed to list enrichment jobs:", error);
    throw new Error(
      error instanceof Error
        ? `Failed to list jobs: ${error.message}`
        : "Failed to list jobs",
    );
  }
}
