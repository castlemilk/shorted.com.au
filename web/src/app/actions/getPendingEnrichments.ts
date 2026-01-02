"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import { SHORTS_API_URL } from "./config";

export async function getPendingEnrichments(limit = 100, offset = 0) {
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

  const resp = await client.listPendingEnrichments(
    { limit, offset },
    {
      headers: {
        "X-Internal-Secret": internalSecret,
        "X-User-Email": session.user.email,
        "X-User-Id": session.user.id,
      },
    },
  );

  return resp.enrichments ?? [];
}


