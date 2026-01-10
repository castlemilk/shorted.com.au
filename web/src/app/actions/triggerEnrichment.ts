"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import { SHORTS_API_URL } from "./config";
import { revalidatePath } from "next/cache";
import { retryWithBackoff } from "@/lib/retry";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

export async function triggerEnrichmentAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.email || !session?.user?.isAdmin) {
    throw new Error("Unauthorized: Admin access required");
  }

  const stockCode = formData.get("stockCode") as string;
  const force = formData.get("force") === "true";

  if (!stockCode || stockCode.trim().length === 0) {
    throw new Error("Stock code is required");
  }

  const transport = createConnectTransport({
    fetch,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  const internalSecret = process.env.INTERNAL_SECRET ?? "dev-internal-secret";

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
              "X-User-Email": session.user.email ?? "",
              "X-User-Id": session.user.id,
            },
          },
        ),
      RETRY_OPTIONS,
    );

    // Revalidate the enrichments page to show the new job
    revalidatePath("/admin/enrichments");

    // Return job_id instead of redirecting (async processing)
    return {
      success: true,
      jobId: resp.jobId || "",
      message: resp.message || `Enrichment job created: ${resp.jobId}`,
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
