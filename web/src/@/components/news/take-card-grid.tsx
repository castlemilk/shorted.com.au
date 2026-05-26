import Link from "next/link";
import { listEditorialTakes } from "~/app/actions/getEditorialTake";

function fmtDate(ts: { seconds?: bigint | number } | undefined): string {
  if (!ts?.seconds) return "";
  const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : ts.seconds;
  return new Date(s * 1000).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
  });
}

const sentimentRing = (s: string | undefined) => {
  switch (s) {
    case "positive":
      return "ring-emerald-500/30 hover:ring-emerald-500/60";
    case "negative":
      return "ring-rose-500/30 hover:ring-rose-500/60";
    default:
      return "ring-orange-500/20 hover:ring-orange-500/50";
  }
};

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
            className={`group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card ring-1 ring-transparent transition-all hover:-translate-y-0.5 hover:border-orange-500/40 hover:shadow-lg hover:shadow-orange-950/40 ${sentimentRing(t.sentiment)}`}
          >
            {t.heroImageUrl ? (
              <div className="relative aspect-[16/9] overflow-hidden bg-muted/20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={t.heroImageUrl}
                  alt={t.headline}
                  loading={idx < 3 ? "eager" : "lazy"}
                  decoding="async"
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                />
                {/* Bottom gradient fade so the ticker chip reads against any image */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />
                {/* Ticker chip — bottom-left over the image */}
                {t.stockCode ? (
                  <span className="absolute bottom-2 left-2 rounded-md border border-orange-500/40 bg-zinc-950/80 px-2 py-0.5 font-mono text-xs font-semibold text-orange-300 backdrop-blur">
                    ${t.stockCode}
                  </span>
                ) : null}
                {/* Take stamp — top-right */}
                <span className="absolute right-2 top-2 rounded-md border border-orange-500/30 bg-zinc-950/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-orange-300 backdrop-blur">
                  Take
                </span>
              </div>
            ) : (
              <div className="relative flex aspect-[16/9] items-center justify-center overflow-hidden bg-gradient-to-br from-orange-950/40 via-zinc-950 to-zinc-950">
                <div
                  className="pointer-events-none absolute inset-0 opacity-30"
                  style={{
                    backgroundImage:
                      "radial-gradient(circle at 20% 30%, rgba(255,169,77,0.15), transparent 50%), radial-gradient(circle at 80% 70%, rgba(255,169,77,0.08), transparent 60%)",
                  }}
                />
                {t.stockCode ? (
                  <span className="relative font-mono text-4xl font-bold tracking-tight text-orange-300/80 md:text-5xl">
                    ${t.stockCode}
                  </span>
                ) : (
                  <span className="relative text-xs font-medium uppercase tracking-[0.2em] text-orange-300/70">
                    Shorted Take
                  </span>
                )}
                <span className="absolute right-2 top-2 rounded-md border border-orange-500/30 bg-zinc-950/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-orange-300 backdrop-blur">
                  Take
                </span>
              </div>
            )}
            <div className="flex flex-1 flex-col p-4">
              <h3 className="line-clamp-3 text-sm font-semibold leading-snug text-foreground transition-colors group-hover:text-orange-300 md:text-base">
                {t.headline}
              </h3>
              <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="uppercase tracking-wider">
                  Editorial commentary
                </span>
                <span>{fmtDate(t.publishedAt)}</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
