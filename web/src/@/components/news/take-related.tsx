import Link from "next/link";
import { getStock } from "~/app/actions/getStock";
import { getStockNews } from "~/app/actions/getStockNews";
import { listEditorialTakes } from "~/app/actions/getEditorialTake";
import { normalizedLogoUrl } from "~/@/lib/logo";

interface TakeRelatedProps {
  stockCode: string;
  excludeSlug: string;
}

function fmtDate(ts: { seconds?: bigint | number } | string | undefined): string {
  if (!ts) return "";
  if (typeof ts === "string") return new Date(ts).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : (ts.seconds ?? 0);
  if (!s) return "";
  return new Date(s * 1000).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export async function TakeRelated({ stockCode, excludeSlug }: TakeRelatedProps) {
  // Three parallel fetches. Each soft-fails so a transient backend hiccup
  // doesn't blank the whole related section.
  const [stock, news, takes] = await Promise.all([
    getStock(stockCode).catch(() => undefined),
    getStockNews(stockCode, 6).catch(() => undefined),
    listEditorialTakes(10, 0, stockCode).catch(() => undefined),
  ]);

  const otherTakes = (takes?.takes ?? []).filter((t) => t.slug !== excludeSlug).slice(0, 4);
  const recentNews = news?.articles ?? [];

  return (
    <aside className="mt-12 grid gap-6 border-t border-border pt-8 md:grid-cols-3">
      {/* Stock context */}
      <section className="md:col-span-1">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-orange-400">
          About ${stockCode}
        </h2>
        {stock ? (
          <Link
            href={`/shorts/${stockCode}`}
            className="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-orange-500/40"
          >
            <div className="mb-3 flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={normalizedLogoUrl(stockCode)}
                alt={`${stock.name} logo`}
                width={64}
                height={64}
                className="h-16 w-16 flex-shrink-0 rounded-lg border border-border bg-card object-contain"
              />
              <div className="min-w-0 flex-1">
                <div className="text-base font-semibold leading-tight text-foreground">
                  {stock.name || stockCode}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {stock.industry || "—"}
                </div>
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-orange-300">
                {stock.percentageShorted?.toFixed(2) ?? "—"}%
              </span>
              <span className="text-xs text-muted-foreground">shorted</span>
            </div>
            <div className="mt-3 text-xs text-orange-400">
              See full position →
            </div>
          </Link>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            Stock info unavailable.{" "}
            <Link href={`/shorts/${stockCode}`} className="text-orange-400 hover:text-orange-300">
              View ${stockCode}
            </Link>
          </div>
        )}
      </section>

      {/* Recent news for the stock */}
      <section className="md:col-span-2">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-orange-400">
          More on ${stockCode}
        </h2>
        {recentNews.length > 0 ? (
          <ul className="space-y-3">
            {recentNews.map((a) => (
              <li key={a.id} className="rounded-lg border border-border bg-card p-3 transition-colors hover:border-orange-500/30">
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="uppercase">{a.source}</span>
                    {a.isPriceSensitive ? (
                      <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                        PRICE SENSITIVE
                      </span>
                    ) : null}
                    {a.sentiment ? (
                      <span className={`text-[10px] uppercase ${
                        a.sentiment === "positive" ? "text-emerald-400" :
                        a.sentiment === "negative" ? "text-red-400" : "text-muted-foreground"
                      }`}>
                        {a.sentiment}
                      </span>
                    ) : null}
                    <span className="ml-auto">{fmtDate(a.publishedAt)}</span>
                  </div>
                  <div className="text-sm leading-snug text-foreground">
                    {a.headline}
                  </div>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No recent articles indexed for ${stockCode}.
          </p>
        )}
        <div className="mt-3 text-right text-xs">
          <Link href={`/shorts/${stockCode}/news`} className="text-orange-400 hover:text-orange-300">
            All ${stockCode} news →
          </Link>
        </div>
      </section>

      {/* Other Takes about same stock */}
      {otherTakes.length > 0 ? (
        <section className="md:col-span-3">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-orange-400">
            More Shorted Takes on ${stockCode}
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {otherTakes.map((t) => (
              <li key={t.id} className="rounded-lg border border-border bg-card p-3 transition-colors hover:border-orange-500/30">
                <Link href={`/news/${t.slug}`} className="block">
                  <div className="mb-1 text-xs text-muted-foreground">
                    {fmtDate(t.publishedAt)}
                  </div>
                  <div className="text-sm leading-snug text-foreground">
                    {t.headline}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}
