"use server";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { revalidatePath } from "next/cache";
import { ShortedStocksService, TakeStatus } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "~/app/actions/config";
import { requireAdmin } from "~/server/admin";

function adminClient() {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  return createClient(ShortedStocksService, transport);
}

export async function listTakesAdmin(filter?: "draft" | "published" | "tweeted") {
  await requireAdmin();
  const client = adminClient();
  const statusFilter =
    filter === "draft"
      ? TakeStatus.DRAFT
      : filter === "published"
        ? TakeStatus.PUBLISHED
        : filter === "tweeted"
          ? TakeStatus.TWEETED
          : TakeStatus.UNSPECIFIED;
  const resp = await client.listEditorialTakesAdmin({
    limit: 100,
    offset: 0,
    statusFilter,
  });
  return resp.takes;
}

export async function publishTake(slug: string) {
  await requireAdmin();
  const client = adminClient();
  await client.publishEditorialTake({ slug });
  revalidatePath("/admin/takes");
  revalidatePath(`/admin/takes/${slug}`);
  revalidatePath(`/news/${slug}`);
  revalidatePath("/sitemap.xml");
}

export async function deleteTake(slug: string) {
  await requireAdmin();
  const client = adminClient();
  await client.deleteEditorialTake({ slug });
  revalidatePath("/admin/takes");
  revalidatePath(`/news/${slug}`);
  revalidatePath("/sitemap.xml");
}

export async function updateTake(
  slug: string,
  fields: { bodyMd?: string; headline?: string; heroImageUrl?: string; sentiment?: string },
) {
  await requireAdmin();
  const client = adminClient();
  await client.updateEditorialTake({
    slug,
    bodyMd: fields.bodyMd ?? "",
    headline: fields.headline ?? "",
    heroImageUrl: fields.heroImageUrl ?? "",
    sentiment: fields.sentiment ?? "",
  });
  revalidatePath(`/admin/takes/${slug}`);
  revalidatePath(`/news/${slug}`);
}
