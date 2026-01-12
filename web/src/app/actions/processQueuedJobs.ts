"use server";

import { auth } from "~/server/auth";
import { revalidatePath } from "next/cache";

/**
 * Triggers processing of queued enrichment jobs by republishing them to Pub/Sub
 * This is a workaround when ENRICHMENT_PROCESSOR_URL is not available
 */
export async function processQueuedJobsAction() {
  const session = await auth();
  if (!session?.user?.email || !session?.user?.isAdmin) {
    throw new Error("Unauthorized: Admin access required");
  }

  // First, try to call enrichment-processor service directly if URL is available
  const enrichmentProcessorUrl =
    process.env.ENRICHMENT_PROCESSOR_URL ??
    process.env.NEXT_PUBLIC_ENRICHMENT_PROCESSOR_URL ??
    // Local dev fallback
    (process.env.NODE_ENV === "development" ? "http://localhost:8080" : undefined);

  if (enrichmentProcessorUrl) {
    const endpoint = `${enrichmentProcessorUrl}/process-queued`;
    console.log(`Triggering enrichment processor at: ${endpoint}`);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        // Add timeout
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        const errorMsg = `Failed to trigger processing: ${response.status} ${response.statusText} - ${errorText}`;
        console.error(`Enrichment processor error: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const result = await response.text();

      // Revalidate the enrichments page to show updated job status
      revalidatePath("/admin/enrichments");

      return {
        success: true,
        message: result ?? "Processing queued jobs triggered successfully",
      };
    } catch (error) {
      // Handle timeout errors specifically
      if (error instanceof Error && error.name === "TimeoutError") {
        const errorMsg = "Request timed out after 30 seconds. The service may be starting up (cold start).";
        console.error(`Enrichment processor timeout: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      // Handle network errors - fall through to republish method
      if (error instanceof TypeError && error.message.includes("fetch")) {
        console.warn(`Failed to connect to enrichment processor at ${endpoint}, falling back to republish method`);
        // Fall through to republish method below
      } else {
        // Re-throw other errors
        throw error;
      }
    }
  }

  // If enrichment-processor URL is not available, provide helpful error message
  const errorMsg =
    "ENRICHMENT_PROCESSOR_URL environment variable is not set. " +
    "Please configure ENRICHMENT_PROCESSOR_URL or NEXT_PUBLIC_ENRICHMENT_PROCESSOR_URL in your environment. " +
    "The enrichment-processor Cloud Run Service URL is required to trigger processing of queued jobs. " +
    `Current NODE_ENV: ${process.env.NODE_ENV ?? "undefined"}`;
  console.error(errorMsg);
  throw new Error(errorMsg);
}
