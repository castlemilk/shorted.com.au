"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import { SHORTS_API_URL } from "./config";

export async function listEnrichmentJobs(limit = 100, offset = 0, status?: number) {
  const session = await auth();
  if (!session?.user?.email || !session?.user?.isAdmin) {
    throw new Error("Unauthorized: Admin access required");
  }

  const transport = createConnectTransport({
    fetch,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  const internalSecret = process.env.INTERNAL_SECRET ?? "dev-internal-secret";

  try {
    const resp = await client.listEnrichmentJobs(
      {
        limit,
        offset,
        status: status ?? 0, // 0 = UNSPECIFIED (all statuses)
      },
      {
        headers: {
          "X-Internal-Secret": internalSecret,
          "X-User-Email": session.user.email,
          "X-User-Id": session.user.id,
        },
      },
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

