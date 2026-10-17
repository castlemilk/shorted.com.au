import Link from "next/link";
import { type EditorialTake } from "~/gen/shorts/v1alpha1/news_pb";
import { stockChipPalette } from "~/@/lib/stock-color";
import { cn } from "~/@/lib/utils";
import { eyebrow, sectionTitle } from "~/@/lib/typography";

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
      return { text: "Positive", className: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300 bg-emerald-500/10" };
    case "negative":
      return { text: "Negative", className: "border-rose-500/40 text-rose-700 dark:text-rose-300 bg-rose-500/10" };
    default:
      return { text: "Neutral", className: "border-orange-500/30 text-orange-700 dark:text-orange-300 bg-orange-500/10" };
  }
};

export function TakeHero({ take }: { take: EditorialTake }) {
  const sent = sentimentLabel(take.sentiment);
  const chip = stockChipPalette(take.stockCode);
  return (
    <Link
      href={`/news/${take.slug}`}
      className="group mt-4 block overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:transition-none md:grid md:grid-cols-5 md:items-center md:gap-0"
    >
      {take.heroImageUrl ? (
        <div className="relative aspect-video overflow-hidden border-b border-border bg-muted md:col-span-2 md:border-b-0 md:border-r">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={take.heroImageUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="eager"
              decoding="async"
            />
        </div>
      ) : (
        <div className="flex aspect-video items-center justify-center overflow-hidden border-b border-border bg-muted md:col-span-2 md:border-b-0 md:border-r">
          {take.stockCode ? (
            <span className="font-mono text-5xl font-semibold text-muted-foreground md:text-6xl">
              ${take.stockCode}
            </span>
          ) : <span className="font-mono text-sm text-muted-foreground">Shorted Take</span>}
        </div>
      )}

      <div className="flex flex-col justify-center gap-3 p-5 md:col-span-3 md:p-7">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs">
          <span className={cn(eyebrow, "font-medium text-primary")}>
            Shorted Take
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
          <span className="ml-auto tabular-nums text-muted-foreground">
            {fmtDate(take.publishedAt)}
          </span>
        </div>

        <h2 className={cn(sectionTitle, "leading-snug transition-colors group-hover:text-primary md:text-3xl")}>
          {take.headline}
        </h2>

        <p className="line-clamp-4 text-sm leading-relaxed text-muted-foreground md:text-base">
          {firstParagraph(take.bodyMd)}
        </p>

      </div>
    </Link>
  );
}
