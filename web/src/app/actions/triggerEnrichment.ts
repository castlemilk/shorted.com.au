"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { EnrichmentService } from "~/gen/shorts/v1alpha1/enrichment_pb";
import { requireAdmin } from "~/server/admin";
import { internalServiceSecret } from "~/server/internal-service-secret";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { revalidatePath } from "next/cache";
import { retryWithBackoff } from "@/lib/retry";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

export async function triggerEnrichmentAction(formData: FormData) {
  // Gate in-action. Server actions are addressable by action-id, so the
  // session flag a caller checks in the UI is not authorization on its own.
  const admin = await requireAdmin();

  const stockCode = formData.get("stockCode") as string;
  const force = formData.get("force") === "true";

  if (!stockCode || stockCode.trim().length === 0) {
    throw new Error("Stock code is required");
  }

  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(EnrichmentService, transport);

  const internalSecret = internalServiceSecret();

  try {
    const resp = await retryWithBackoff(
      () =>
        client.enrichStock(
          {
            stockCode: stockCode.trim().toUpperCase(),
            force,
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

    // Revalidate the enrichments page to show the new job
    revalidatePath("/admin/enrichments");

    // Return job_id instead of redirecting (async processing)
    // Add defensive checks for resp
    if (!resp) {
      throw new Error("Received empty response from enrichment service");
    }
    
    return {
      success: true,
      jobId: resp?.jobId || "",
      message: resp?.message || `Enrichment job created: ${resp?.jobId || "unknown"}`,
    };
  } catch (error) {
    console.error("Failed to trigger enrichment:", error);
    throw new Error(
      error instanceof Error
        ? `Failed to trigger enrichment: ${error.message}`
        : "Failed to trigger enrichment",
    );
  }
}
