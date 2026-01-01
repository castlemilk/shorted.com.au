"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import { SHORTS_API_URL } from "./config";

export async function getEnrichmentJobStatus(jobId: string) {
  const session = await auth();
  if (!session?.user?.email || !session?.user?.isAdmin) {
    throw new Error("Unauthorized: Admin access required");
  }

  if (!jobId || jobId.trim().length === 0) {
    throw new Error("Job ID is required");
  }

  const transport = createConnectTransport({
    fetch,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  const internalSecret = process.env.INTERNAL_SECRET ?? "dev-internal-secret";

  try {
    const resp = await client.getEnrichmentJobStatus(
      {
        jobId: jobId.trim(),
      },
      {
        headers: {
          "X-Internal-Secret": internalSecret,
          "X-User-Email": session.user.email,
          "X-User-Id": session.user.id,
        },
      },
    );

    return resp.job;
  } catch (error) {
    console.error("Failed to get enrichment job status:", error);
    throw new Error(
      error instanceof Error
        ? `Failed to get job status: ${error.message}`
        : "Failed to get job status",
    );
  }
}

