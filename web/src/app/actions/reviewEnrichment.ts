"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { EnrichmentService } from "~/gen/shorts/v1alpha1/enrichment_pb";
import { requireAdmin } from "~/server/admin";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { retryWithBackoff } from "@/lib/retry";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

export async function reviewEnrichmentAction(formData: FormData) {
  // Admin-only. Authorize the caller in-action (not just via route middleware):
  // server actions are globally addressable by action-id and can be POSTed to a
  // route outside the /admin matcher, so the middleware gate alone is bypassable.
  const admin = await requireAdmin();

  const enrichmentId = String(formData.get("enrichmentId") ?? "");
  const stockCode = String(formData.get("stockCode") ?? "");
  const reviewNotes = String(formData.get("reviewNotes") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const approve = decision === "approve";

  if (!enrichmentId) {
    throw new Error("Missing enrichmentId");
  }
  if (!stockCode) {
    throw new Error("Missing stockCode");
  }

  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(EnrichmentService, transport);
  const internalSecret = process.env.INTERNAL_SECRET ?? "dev-internal-secret";

  await retryWithBackoff(
    () =>
      client.reviewEnrichment(
        {
          stockCode,
          enrichmentId,
          approve,
          reviewNotes,
        },
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

  revalidatePath("/admin/enrichments");
  redirect("/admin/enrichments");
}
