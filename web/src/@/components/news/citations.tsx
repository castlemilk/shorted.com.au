import React from "react";

/**
 * Shared citation rendering for editorial Take bodies.
 *
 * Both render paths use this module:
 *  - the legacy markdown path (`take-body.tsx`, react-markdown) turns
 *    [ref-N] / [report-N] markers into pills while walking inline text;
 *  - the MDX path (`mdx-take-body.tsx`, next-mdx-remote) pre-processes
 *    markers into `<Cite refId="ref-N" />` elements before compiling.
 *
 * Keep this module server-safe: no hooks, no event handlers, no
 * `@connectrpc/connect` imports (see SSR gotchas in CLAUDE.md).
 */

/** Citation shape carried by EditorialTake (proto TakeCitation). */
export interface TakeCitation {
  refId: string;
  url: string;
  source: string;
  headline: string;
  date: string;
  type: string;
}

/** Minimal fields the inline pill needs to render its tooltip + colour. */
export interface CitationInfo {
  source: string;
  date?: string;
  type?: string;
}

/** Matches inline citation markers: [ref-1], [report-3], … */
export const MARKER_PATTERN = /\[((?:ref|report)-\d+)\]/g;

const REF_ID_PATTERN = /^(ref|report)-(\d+)$/;

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

export function prettySource(raw: string, isReport: boolean): string {
  if (isReport) return SOURCE_LABELS[raw] ?? "Financial report";
  return SOURCE_LABELS[raw] ?? raw;
}

// Strip protocol + "www." and trim long URLs so the source line stays compact.
export function shortHost(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

export interface ResolvedCitation<C extends { refId: string }> {
  citation: C;
  /** The N in ref-N / report-N — the number shown in the pill. */
  displayIndex: number;
  isReport: boolean;
  /** Pill text: "3" for refs, "R3" for reports. */
  label: string;
}

/**
 * Map a refId ("ref-3" / "report-1") to its citation and display index.
 * Returns null when the id is malformed or no matching citation exists.
 */
export function resolveCitation<C extends { refId: string; type?: string }>(
  refId: string,
  citations: readonly C[],
): ResolvedCitation<C> | null {
  const m = REF_ID_PATTERN.exec(refId);
  if (!m) return null;
  const citation = citations.find((c) => c.refId === refId);
  if (!citation) return null;
  const num = m[2]!;
  const isReport = m[1] === "report" || citation.type === "report";
  return {
    citation,
    displayIndex: Number(num),
    isReport,
    label: isReport ? `R${num}` : num,
  };
}

/**
 * Replace [ref-N]/[report-N] markers with <Cite refId="…" /> elements so
 * the MDX compiler renders them via the Cite component. Markers inside
 * fenced code blocks or inline code spans are left untouched (editorial
 * takes generally contain no code, but this keeps the transform safe).
 */
export function preprocessCitationMarkers(source: string): string {
  // Capturing split: odd indices are code segments, even indices prose.
  const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`)/g;
  return source
    .split(CODE_SEGMENT)
    .map((segment, i) =>
      i % 2 === 1
        ? segment
        : segment.replace(MARKER_PATTERN, '<Cite refId="$1" />'),
    )
    .join("");
}

const REF_PILL_CLASS =
  "relative -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary/10 px-0.5 text-[10px] font-semibold text-primary no-underline transition-colors hover:bg-primary/20";
const REPORT_PILL_CLASS =
  "relative -top-1 inline-flex h-4 min-w-5 items-center justify-center rounded bg-amber-500/15 px-0.5 text-[10px] font-semibold text-amber-300 no-underline transition-colors hover:bg-amber-500/25";

/**
 * Numbered inline citation pill — links to the matching entry in the
 * Sources list. Reports render amber ("R3"); news refs render in the
 * primary colour ("3"). Falls back to the literal "[ref-N]" text when
 * the citation is unknown.
 */
export function CitationPill({
  refId,
  citation,
}: {
  refId: string;
  citation: CitationInfo | undefined;
}) {
  const m = REF_ID_PATTERN.exec(refId);
  if (!m || !citation) {
    return <span>{`[${refId}]`}</span>;
  }
  const num = m[2]!;
  const isReport = m[1] === "report" || citation.type === "report";
  const tooltip = [
    isReport ? "Financial report" : citation.source,
    citation.date ? `(${citation.date})` : "",
    citation.type ? `[${citation.type.replace(/_/g, " ")}]` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <a
      href={`#${refId}`}
      title={tooltip}
      className={isReport ? REPORT_PILL_CLASS : REF_PILL_CLASS}
    >
      {isReport ? `R${num}` : num}
    </a>
  );
}

/** The "Sources" footnote list rendered under a Take body. */
export function CitationSources({ citations }: { citations: TakeCitation[] }) {
  if (citations.length === 0) return null;
  return (
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
  );
}
