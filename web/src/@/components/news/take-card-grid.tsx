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

export async function TakeCardGrid({ limit = 6 }: { limit?: number }) {
  const resp = await listEditorialTakes(limit, 0, "").catch(() => undefined);
  const takes = resp?.takes ?? [];
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
        {takes.map((t) => (
          <Link
            key={t.id}
            href={`/news/${t.slug}`}
            className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-orange-500/40"
          >
            {t.heroImageUrl ? (
              <div className="aspect-[16/9] overflow-hidden bg-muted/20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={t.heroImageUrl}
                  alt={t.headline}
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                />
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
              </div>
            )}
            <div className="flex flex-1 flex-col p-4">
              <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="rounded border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 font-medium uppercase text-orange-300">
                  Take
                </span>
                {t.stockCode ? (
                  <span className="font-mono text-orange-300">${t.stockCode}</span>
                ) : null}
                <span className="ml-auto text-muted-foreground">
                  {fmtDate(t.publishedAt)}
                </span>
              </div>
              <h3 className="text-sm font-semibold leading-snug text-foreground">
                {t.headline}
              </h3>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
