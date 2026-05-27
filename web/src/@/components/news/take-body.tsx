"use client";

import { LinkifiedNarrative } from "~/@/components/reports/linkified-narrative";

// Friendly display name for raw source slugs from the news aggregator.
const SOURCE_LABELS: Record<string, string> = {
  motleyfool: "Motley Fool",
  stockhead: "Stockhead",
  kalkine: "Kalkine",
  smallcaps: "Small Caps",
  googlenews: "Google News",
  abc: "ABC News",
  marketindex: "Market Index",
  sharecafe: "Sharecafe",
  half_year_results: "Half-year results",
  annual_results: "Annual report",
  quarterly_report: "Quarterly report",
  report: "Report",
};

function prettySource(raw: string, isReport: boolean): string {
  if (isReport) return SOURCE_LABELS[raw] ?? "Financial report";
  return SOURCE_LABELS[raw] ?? raw;
}

// Strip protocol + "www." and trim long URLs so the source line stays compact.
function shortHost(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

export interface TakeCitation {
  refId: string;
  url: string;
  source: string;
  headline: string;
  date: string;
  type: string;
}

export interface TakeInlineImage {
  url: string;
  topic?: string;
  alt?: string;
}

interface TakeBodyProps {
  bodyMd: string;
  citations: TakeCitation[];
  inlineImages?: TakeInlineImage[];
  stockCode?: string;
}

/**
 * Renders an editorial Take body with inline [ref-N] citations and an
 * auto-linked stock code. Reuses LinkifiedNarrative's ref-pill rendering
 * (originally built for weekly reports) by adapting our TakeCitation
 * shape to the ReportCitation shape it expects.
 *
 * The body is split on blank lines into paragraphs; each paragraph is
 * wrapped in <p> with brand-mono prose styling so it picks up the
 * IBM_Plex_Mono variable + generous line height we use elsewhere.
 *
 * The Sources list renders below the body in a compact ordered list
 * keyed by ref id; clicking a ref pill in the prose anchors here.
 */
export function TakeBody({ bodyMd, citations, inlineImages = [], stockCode }: TakeBodyProps) {
  const paragraphs = bodyMd.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  // LinkifiedNarrative expects ReportCitation with `id` not `refId`.
  // Adapt; map our TakeCitation.source+date+url onto its shape.
  const adapted = citations.map((c) => ({
    id: c.refId,
    source: c.source,
    date: c.date,
    url: c.url,
    type: c.type,
  }));
  const validCodes = stockCode ? [stockCode] : [];

  // Decide which paragraph indices get an inline image AFTER them.
  // With 4 paragraphs and 2 images: after p[0] and after p[2]
  // (evenly distributed, never at the very end).
  const imageAfterIdx = new Set<number>();
  if (inlineImages.length > 0 && paragraphs.length >= 2) {
    const slots = inlineImages.length;
    const step = Math.max(1, Math.floor(paragraphs.length / (slots + 1)));
    for (let i = 1; i <= slots; i++) {
      const idx = i * step - 1;
      if (idx >= 0 && idx < paragraphs.length - 1) imageAfterIdx.add(idx);
    }
  }

  return (
    <div>
      <div className="space-y-5 text-base leading-relaxed">
        {paragraphs.flatMap((para, i) => {
          const nodes: React.ReactNode[] = [
            <p key={`p-${i}`} className="text-foreground/90">
              <LinkifiedNarrative
                text={para}
                citations={adapted}
                validCodes={validCodes}
              />
            </p>,
          ];
          if (imageAfterIdx.has(i)) {
            // Position derived from the imageAfterIdx Set membership;
            // count how many image slots have already passed.
            const slotIndex = [...imageAfterIdx].sort((a, b) => a - b).indexOf(i);
            const img = inlineImages[slotIndex];
            if (img) {
              nodes.push(
                <figure
                  key={`img-${i}`}
                  className="my-2 overflow-hidden rounded-xl border border-border bg-zinc-950"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.url}
                    alt={img.alt ?? img.topic ?? "Editorial illustration"}
                    className="h-auto w-full"
                    loading="lazy"
                    decoding="async"
                  />
                </figure>,
              );
            }
          }
          return nodes;
        })}
      </div>

      {citations.length > 0 ? (
        <aside className="mt-12 border-t border-border pt-6">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-orange-400">
            Sources
          </h2>
          <ol className="space-y-3">
            {citations.map((c) => {
              const isReport = c.type === "report";
              const label = isReport ? c.refId.replace("report-", "R") : c.refId.replace("ref-", "");
              const pillClass = isReport
                ? "h-5 min-w-6 rounded bg-amber-500/15 px-1 text-amber-300"
                : "h-5 min-w-5 rounded bg-primary/10 px-1 text-primary";
              return (
                <li
                  key={c.refId}
                  id={c.refId}
                  className="flex gap-3 scroll-mt-20"
                >
                  <span className={`flex flex-shrink-0 items-center justify-center font-mono text-[11px] font-semibold ${pillClass}`}>
                    {label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-foreground hover:text-orange-300"
                    >
                      {c.headline}
                    </a>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      {isReport ? (
                        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] font-medium uppercase tracking-wider text-amber-300">
                          Report
                        </span>
                      ) : null}
                      <span>{prettySource(c.source, isReport)}</span>
                      {c.date ? <span>· {c.date}</span> : null}
                      <span className="text-muted-foreground/60">· {shortHost(c.url)}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </aside>
      ) : null}
    </div>
  );
}
