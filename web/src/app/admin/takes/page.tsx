import Link from "next/link";
import { requireAdmin } from "~/server/admin";
import { listTakesAdmin } from "~/app/actions/admin/takes";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ filter?: string }>;
}

function statusBadge(take: {
  publishedAt?: { seconds?: bigint | number } | undefined;
  tweetPublishedAt?: { seconds?: bigint | number } | undefined;
}): { label: string; className: string } {
  const hasPub = !!take.publishedAt;
  const hasTweet = !!take.tweetPublishedAt;
  if (hasTweet) return { label: "Tweeted", className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" };
  if (hasPub) return { label: "Published", className: "bg-blue-500/10 text-blue-400 border-blue-500/30" };
  return { label: "Draft", className: "bg-amber-500/10 text-amber-400 border-amber-500/30" };
}

function fmtDate(ts: { seconds?: bigint | number } | undefined): string {
  if (!ts?.seconds) return "—";
  const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : ts.seconds;
  return new Date(s * 1000).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function AdminTakesPage({ searchParams }: PageProps) {
  await requireAdmin();
  const { filter } = await searchParams;
  const valid = filter === "draft" || filter === "published" || filter === "tweeted" ? filter : undefined;
  const takes = await listTakesAdmin(valid);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-3xl font-bold">Editorial Takes</h1>
        <span className="text-sm text-muted-foreground">{takes.length} shown</span>
      </div>

      <nav className="mb-6 flex gap-2 text-sm">
        {[
          { key: undefined, label: "All" },
          { key: "draft", label: "Drafts" },
          { key: "published", label: "Published (awaiting tweet)" },
          { key: "tweeted", label: "Tweeted" },
        ].map((tab) => (
          <Link
            key={tab.label}
            href={tab.key ? `/admin/takes?filter=${tab.key}` : "/admin/takes"}
            className={`rounded-md border px-3 py-1.5 transition-colors ${
              valid === tab.key
                ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                : "border-border text-muted-foreground hover:border-border/60 hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {takes.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-muted-foreground">
          No takes match this filter.
        </div>
      ) : (
        <div className="space-y-2">
          {takes.map((take) => {
            const badge = statusBadge(take);
            const created = fmtDate(take.createdAt);
            const published = fmtDate(take.publishedAt);
            return (
              <Link
                key={take.id}
                href={`/admin/takes/${take.slug}`}
                className="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-orange-500/30 hover:bg-orange-500/5"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                    {badge.label}
                  </span>
                  {take.stockCode ? (
                    <span className="font-mono text-xs text-orange-300">${take.stockCode}</span>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {take.publishedAt ? `Published ${published}` : `Created ${created}`}
                  </span>
                </div>
                <h2 className="text-base font-semibold leading-tight">{take.headline}</h2>
                {take.wordCount ? (
                  <div className="mt-1 text-xs text-muted-foreground">{take.wordCount} words</div>
                ) : null}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
