import Link from "next/link";
import { type EditorialTake } from "~/gen/shorts/v1alpha1/shorts_pb";
import { stockChipPalette } from "~/@/lib/stock-color";

function fmtDate(ts: { seconds?: bigint | number } | undefined): string {
  if (!ts?.seconds) return "";
  const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : ts.seconds;
  return new Date(s * 1000).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function firstParagraph(body: string): string {
  const para = body.split(/\n\s*\n/)[0] ?? body;
  return para.trim().slice(0, 280);
}

const sentimentLabel = (s: string | undefined) => {
  switch (s) {
    case "positive":
      return { text: "Positive", className: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10" };
    case "negative":
      return { text: "Negative", className: "border-rose-500/40 text-rose-300 bg-rose-500/10" };
    default:
      return { text: "Neutral", className: "border-orange-500/30 text-orange-300 bg-orange-500/10" };
  }
};

export function TakeHero({ take }: { take: EditorialTake }) {
  const sent = sentimentLabel(take.sentiment);
  const chip = stockChipPalette(take.stockCode);
  return (
    <Link
      href={`/news/${take.slug}`}
      className="group mt-4 block overflow-hidden rounded-xl border border-border bg-card transition-all hover:border-orange-500/40 hover:shadow-lg hover:shadow-orange-950/40 md:grid md:grid-cols-5 md:gap-0"
    >
      {take.heroImageUrl ? (
        <div className="relative overflow-hidden bg-muted/20 md:col-span-2 md:aspect-auto">
          <div className="aspect-[16/9] md:aspect-auto md:h-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={take.heroImageUrl}
              alt={take.headline}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
              loading="eager"
              decoding="async"
            />
          </div>
          {/* Take stamp */}
          <span className="absolute right-3 top-3 rounded-md border border-orange-500/40 bg-zinc-950/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-orange-300 backdrop-blur">
            Shorted Take
          </span>
          {take.stockCode ? (
            <span className={`absolute bottom-3 left-3 rounded-md border px-2.5 py-1 font-mono text-sm font-bold backdrop-blur ${chip.onImage}`}>
              ${take.stockCode}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="relative flex items-center justify-center overflow-hidden bg-gradient-to-br from-orange-950/40 via-zinc-950 to-zinc-950 md:col-span-2">
          <div className="aspect-[16/9] w-full md:aspect-auto md:h-full" />
          {take.stockCode ? (
            <span className={`absolute font-mono text-5xl font-bold md:text-6xl ${chip.onImage.split(" ").find((c) => c.startsWith("text-")) ?? "text-orange-300/80"}`}>
              ${take.stockCode}
            </span>
          ) : null}
          <span className="absolute right-3 top-3 rounded-md border border-orange-500/40 bg-zinc-950/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-orange-300 backdrop-blur">
            Shorted Take
          </span>
        </div>
      )}

      <div className="flex flex-col justify-center gap-3 p-5 md:col-span-3 md:p-7">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 font-medium uppercase tracking-wider text-orange-300">
            Editorial
          </span>
          {take.stockCode ? (
            <span className={`rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${chip.onCard}`}>
              ${take.stockCode}
            </span>
          ) : null}
          <span
            className={`rounded border px-2 py-0.5 font-medium ${sent.className}`}
          >
            {sent.text}
          </span>
          <span className="ml-auto text-muted-foreground">
            {fmtDate(take.publishedAt)}
          </span>
        </div>

        <h2 className="text-2xl font-bold leading-tight tracking-tight transition-colors group-hover:text-orange-300 md:text-3xl">
          {take.headline}
        </h2>

        <p className="line-clamp-4 text-sm leading-relaxed text-muted-foreground md:text-base">
          {firstParagraph(take.bodyMd)}
        </p>

        <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-orange-300/90 transition-colors group-hover:text-orange-300">
          Read the Take
          <span aria-hidden>→</span>
        </span>
      </div>
    </Link>
  );
}
