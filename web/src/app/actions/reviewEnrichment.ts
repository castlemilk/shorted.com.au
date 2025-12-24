"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { auth } from "~/server/auth";
import { SHORTS_API_URL } from "./config";

export async function reviewEnrichmentAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.email) {
    throw new Error("Unauthorized");
  }

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
    fetch,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);
  const internalSecret = process.env.INTERNAL_SECRET ?? "dev-internal-secret";

  await client.reviewEnrichment(
    {
      stockCode,
      enrichmentId,
      approve,
      reviewNotes,
    },
    {
      headers: {
        "X-Internal-Secret": internalSecret,
        "X-User-Email": session.user.email,
        "X-User-Id": session.user.id,
      },
    },
  );

  revalidatePath("/admin/enrichments");
  redirect("/admin/enrichments");
}


