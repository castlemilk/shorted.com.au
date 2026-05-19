import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "~/server/admin";
import { getEditorialTake } from "~/app/actions/getEditorialTake";
import { AdminTakeEditor } from "./editor";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ slug: string }>;
}

function fmtDate(ts: { seconds?: bigint | number } | undefined): string {
  if (!ts?.seconds) return "—";
  const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : ts.seconds;
  return new Date(s * 1000).toLocaleString("en-AU");
}

export default async function AdminTakeDetailPage({ params }: Params) {
  await requireAdmin();
  const { slug } = await params;
  // getEditorialTake filters published_at IS NOT NULL, so drafts won't
  // load through it. Use the admin RPC instead.
  // Inline import to avoid pulling Connect into module scope at SSR.
  const { listTakesAdmin } = await import("~/app/actions/admin/takes");
  const all = await listTakesAdmin();
  const take = all.find((t) => t.slug === slug);
  if (!take) {
    // Fall back to published lookup just in case.
    const pubResp = await getEditorialTake(slug);
    if (!pubResp?.take) return notFound();
    return <AdminTakeEditor takeJSON={JSON.stringify(serialize(pubResp.take))} />;
  }
  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/admin/takes" className="text-sm text-orange-400 hover:text-orange-300">
          ← All takes
        </Link>
        <div className="text-xs text-muted-foreground">
          Created {fmtDate(take.createdAt)} · Published {fmtDate(take.publishedAt)} · Tweeted{" "}
          {fmtDate(take.tweetPublishedAt)}
        </div>
      </div>
      <AdminTakeEditor takeJSON={JSON.stringify(serialize(take))} />
    </div>
  );
}

// Convert protobuf Timestamps (BigInt seconds) into plain JSON so we can
// safely pass through the server → client boundary. Per memory: raw
// protobuf responses with BigInt fields cannot be JSON.stringify'd.
function serialize(take: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(take)) {
    if (v && typeof v === "object" && "seconds" in (v as Record<string, unknown>)) {
      const s = (v as { seconds?: bigint | number }).seconds;
      out[k] =
        typeof s === "bigint" ? Number(s) : typeof s === "number" ? s : null;
    } else if (typeof v === "bigint") {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
