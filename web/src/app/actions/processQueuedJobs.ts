"use server";

import { auth } from "~/server/auth";
import { revalidatePath } from "next/cache";

/**
 * Triggers processing of queued enrichment jobs by calling the enrichment-processor Cloud Run Service
 */
export async function processQueuedJobsAction() {
  const session = await auth();
  if (!session?.user?.email || !session?.user?.isAdmin) {
    throw new Error("Unauthorized: Admin access required");
  }

  // Get the enrichment-processor service URL from environment
  // This should be set via ENRICHMENT_PROCESSOR_URL or NEXT_PUBLIC_ENRICHMENT_PROCESSOR_URL
  // For preview environments, this will be something like:
  // https://enrichment-processor-pr-{PR_NUMBER}-{hash}.australia-southeast2.run.app
  const enrichmentProcessorUrl =
    process.env.ENRICHMENT_PROCESSOR_URL ??
    process.env.NEXT_PUBLIC_ENRICHMENT_PROCESSOR_URL ??
    // Local dev fallback
    (process.env.NODE_ENV === "development" ? "http://localhost:8080" : undefined);

  if (!enrichmentProcessorUrl) {
    throw new Error(
      "ENRICHMENT_PROCESSOR_URL environment variable is not set. Please configure it in your environment.",
    );
  }

  try {
    const response = await fetch(`${enrichmentProcessorUrl}/process-queued`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      // Add timeout
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Failed to trigger processing: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const result = await response.text();

    // Revalidate the enrichments page to show updated job status
    revalidatePath("/admin/enrichments");

    return {
      success: true,
      message: result || "Processing queued jobs triggered successfully",
    };
  } catch (error) {
    console.error("Failed to trigger processing of queued jobs:", error);
    throw new Error(
      error instanceof Error
        ? `Failed to trigger processing: ${error.message}`
        : "Failed to trigger processing",
    );
  }
}
