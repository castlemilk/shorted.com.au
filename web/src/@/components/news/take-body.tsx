"use client";

import React from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { type ReportCitation } from "~/app/actions/reports/getReportData";

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

// Citation markers ([ref-N] / [report-N]) collide with markdown link
// syntax, so before handing the body to the markdown parser we escape
// them to a sentinel ({{ref-N}}) that survives parsing untouched, then
// turn the sentinel back into a citation pill while rendering inline text.
const CODE_PATTERN = /\b([A-Z]{2,4})\b/g;
const MARKER_PATTERN = /\[((?:ref|report)-\d+)\]/g;
const SENTINEL_SPLIT = /(«cite:(?:ref|report)-\d+»)/g;
const SENTINEL_MATCH = /^«cite:(ref|report)-(\d+)»$/;

function escapeMarkers(md: string): string {
  return md.replace(MARKER_PATTERN, (_m, id: string) => `«cite:${id}»`);
}

/** Render a plain string: citation sentinels → pills, bare stock codes → links. */
function renderInlineString(
  str: string,
  citationMap: Map<string, ReportCitation>,
  codeSet: Set<string>,
  keyBase: string,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  str.split(SENTINEL_SPLIT).forEach((part, pi) => {
    if (!part) return;
    const m = SENTINEL_MATCH.exec(part);
    if (m) {
      const kind = m[1];
      const num = m[2]!;
      const refId = `${kind}-${num}`;
      const citation = citationMap.get(refId);
      if (!citation) {
        out.push(<span key={`${keyBase}-x${pi}`}>{`[${refId}]`}</span>);
        return;
      }
      const isReport = kind === "report" || citation.type === "report";
      const tooltip = [
        isReport ? "Financial report" : citation.source,
        citation.date ? `(${citation.date})` : "",
        citation.type ? `[${citation.type.replace(/_/g, " ")}]` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const pillClass = isReport
        ? "relative -top-1 inline-flex h-4 min-w-5 items-center justify-center rounded bg-amber-500/15 px-0.5 text-[10px] font-semibold text-amber-300 no-underline transition-colors hover:bg-amber-500/25"
        : "relative -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary/10 px-0.5 text-[10px] font-semibold text-primary no-underline transition-colors hover:bg-primary/20";
      out.push(
        <a key={`${keyBase}-c${pi}`} href={`#${refId}`} title={tooltip} className={pillClass}>
          {isReport ? `R${num}` : num}
        </a>,
      );
      return;
    }
    // Plain text — auto-link known stock codes.
    CODE_PATTERN.lastIndex = 0;
    let lastEnd = 0;
    let match: RegExpExecArray | null;
    let i = 0;
    while ((match = CODE_PATTERN.exec(part)) !== null) {
      const code = match[1]!;
      if (!codeSet.has(code)) continue;
      if (match.index > lastEnd) {
        out.push(<span key={`${keyBase}-${pi}-t${i++}`}>{part.slice(lastEnd, match.index)}</span>);
      }
      out.push(
        <Link
          key={`${keyBase}-${pi}-l${i++}`}
          href={`/shorts/${code}`}
          prefetch={false}
          className="font-semibold text-primary underline-offset-2 hover:underline"
        >
          {code}
        </Link>,
      );
      lastEnd = match.index + code.length;
    }
    if (lastEnd < part.length) {
      out.push(<span key={`${keyBase}-${pi}-t${i++}`}>{part.slice(lastEnd)}</span>);
    }
  });
  return out;
}

/** Apply the inline transform to a node tree's string children (recursing
 *  into nested markdown elements like <strong>/<em> is handled because
 *  those elements re-enter their own component override). */
function linkify(
  children: React.ReactNode,
  citationMap: Map<string, ReportCitation>,
  codeSet: Set<string>,
): React.ReactNode {
  return React.Children.map(children, (child, i) => {
    if (typeof child === "string") {
      return renderInlineString(child, citationMap, codeSet, `n${i}`);
    }
    return child;
  });
}

function buildComponents(
  citationMap: Map<string, ReportCitation>,
  codeSet: Set<string>,
): Components {
  const inline = (children: React.ReactNode) => linkify(children, citationMap, codeSet);
  return {
    h1: ({ children }) => <h2 className="mb-2 mt-8 text-2xl font-bold tracking-tight text-foreground">{inline(children)}</h2>,
    h2: ({ children }) => <h2 className="mb-2 mt-8 text-xl font-bold tracking-tight text-foreground">{inline(children)}</h2>,
    h3: ({ children }) => <h3 className="mb-1.5 mt-6 text-lg font-semibold tracking-tight text-foreground">{inline(children)}</h3>,
    h4: ({ children }) => <h4 className="mb-1 mt-4 text-base font-semibold text-foreground">{inline(children)}</h4>,
    p: ({ children }) => <p className="text-foreground/90">{inline(children)}</p>,
    ul: ({ children }) => <ul className="ml-5 list-disc space-y-1 text-foreground/90">{children}</ul>,
    ol: ({ children }) => <ol className="ml-5 list-decimal space-y-1 text-foreground/90">{children}</ol>,
    li: ({ children }) => <li>{inline(children)}</li>,
    strong: ({ children }) => <strong className="font-semibold text-foreground">{inline(children)}</strong>,
    em: ({ children }) => <em>{inline(children)}</em>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-orange-400/50 pl-4 italic text-foreground/80">{children}</blockquote>
    ),
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
        {children}
      </a>
    ),
    code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">{children}</code>,
    hr: () => <hr className="my-6 border-border" />,
  };
}

/**
 * Renders an editorial Take body as markdown (headings, lists, emphasis,
 * blockquotes, …) with inline [ref-N] citation pills and auto-linked
 * stock codes preserved. The body is split on blank lines into blocks so
 * inline images can be woven between them; each block is rendered with
 * react-markdown. The Sources list renders below, keyed by ref id.
 */
export function TakeBody({ bodyMd, citations, inlineImages = [], stockCode }: TakeBodyProps) {
  const blocks = bodyMd.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  // LinkifiedNarrative-style citation lookup (ReportCitation shape).
  const citationMap = new Map<string, ReportCitation>();
  for (const c of citations) {
    citationMap.set(c.refId, { id: c.refId, source: c.source, date: c.date, url: c.url, type: c.type } as ReportCitation);
  }
  const codeSet = new Set((stockCode ? [stockCode] : []).map((c) => c.toUpperCase()));
  const components = buildComponents(citationMap, codeSet);

  // Distribute inline images evenly between blocks (never after the last).
  const imageAfterIdx = new Set<number>();
  if (inlineImages.length > 0 && blocks.length >= 2) {
    const slots = inlineImages.length;
    const step = Math.max(1, Math.floor(blocks.length / (slots + 1)));
    for (let i = 1; i <= slots; i++) {
      const idx = i * step - 1;
      if (idx >= 0 && idx < blocks.length - 1) imageAfterIdx.add(idx);
    }
  }

  return (
    <div>
      <div className="space-y-5 text-base leading-relaxed">
        {blocks.flatMap((block, i) => {
          const nodes: React.ReactNode[] = [
            <ReactMarkdown key={`b-${i}`} remarkPlugins={[remarkGfm]} components={components}>
              {escapeMarkers(block)}
            </ReactMarkdown>,
          ];
          if (imageAfterIdx.has(i)) {
            const slotIndex = [...imageAfterIdx].sort((a, b) => a - b).indexOf(i);
            const img = inlineImages[slotIndex];
            if (img) {
              nodes.push(
                <figure key={`img-${i}`} className="my-2 overflow-hidden rounded-xl border border-border bg-zinc-950">
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
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-orange-400">Sources</h2>
          <ol className="space-y-3">
            {citations.map((c) => {
              const isReport = c.type === "report";
              const label = isReport ? c.refId.replace("report-", "R") : c.refId.replace("ref-", "");
              const pillClass = isReport
                ? "h-5 min-w-6 rounded bg-amber-500/15 px-1 text-amber-300"
                : "h-5 min-w-5 rounded bg-primary/10 px-1 text-primary";
              return (
                <li key={c.refId} id={c.refId} className="flex gap-3 scroll-mt-20">
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
