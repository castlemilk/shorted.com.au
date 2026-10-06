import Link from "next/link";
import { listEditorialTakes } from "~/app/actions/getEditorialTake";
import { stockChipPalette } from "~/@/lib/stock-color";

function fmtDate(ts: { seconds?: bigint | number } | undefined): string {
  if (!ts?.seconds) return "";
  const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : ts.seconds;
  return new Date(s * 1000).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
  });
}

export async function TakeCardGrid({
  limit = 6,
  excludeSlug,
}: {
  limit?: number;
  excludeSlug?: string;
}) {
  // Pull more than `limit` so that after deduplication by stock_code +
  // optional excludeSlug we still have enough cards to fill the grid.
  const resp = await listEditorialTakes(limit * 4, 0, "").catch(() => undefined);
  const all = resp?.takes ?? [];

  // Dedupe: keep the newest take per ticker. Untickered ("market" /
  // null) takes are kept individually since they don't share a slot.
  const seenStocks = new Set<string>();
  const takes: typeof all = [];
  for (const t of all) {
    if (excludeSlug && t.slug === excludeSlug) continue;
    const key = (t.stockCode ?? "").trim().toUpperCase();
    if (key) {
      if (seenStocks.has(key)) continue;
      seenStocks.add(key);
    }
    takes.push(t);
    if (takes.length >= limit) break;
  }
  if (takes.length === 0) return null;

  return (
    <section className="mt-8">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">
          Latest Shorted Takes
        </h2>
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          Editorial commentary
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {takes.map((t, idx) => (
          <Link
            key={t.id}
            href={`/news/${t.slug}`}
            className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:transition-none"
          >
            {t.heroImageUrl ? (
              <div className="relative aspect-video overflow-hidden border-b border-border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={t.heroImageUrl}
                  alt=""
                  loading={idx < 3 ? "eager" : "lazy"}
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </div>
            ) : (
              <div className="flex aspect-video items-center justify-center overflow-hidden border-b border-border bg-muted">
                {t.stockCode ? (
                  <span className="font-mono text-4xl font-semibold tracking-tight text-muted-foreground md:text-5xl">
                    ${t.stockCode}
                  </span>
                ) : (
                  <span className="font-mono text-sm text-muted-foreground">
                    Shorted Take
                  </span>
                )}
              </div>
            )}
            <div className="flex flex-1 flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-muted-foreground">
                {t.stockCode ? (
                  <span className={`rounded px-2 py-0.5 font-semibold ${stockChipPalette(t.stockCode).onCard}`}>
                    ${t.stockCode}
                  </span>
                ) : null}
                <span className="ml-auto tabular-nums">{fmtDate(t.publishedAt)}</span>
              </div>
              <h3 className="line-clamp-3 text-sm font-semibold leading-snug text-foreground transition-colors group-hover:text-primary md:text-base">
                {t.headline}
              </h3>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
