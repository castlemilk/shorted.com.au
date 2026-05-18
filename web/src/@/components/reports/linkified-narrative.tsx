"use client";

import Link from "next/link";
import { type ReportCitation } from "~/app/actions/reports/getReportData";

interface LinkifiedNarrativeProps {
  text: string;
  citations: ReportCitation[];
  /**
   * Stock codes considered "mentioned" in this report — only these will
   * be auto-linked when they appear in the narrative prose. Restricting
   * to a known set avoids false-positives on words like "WAS", "ARE",
   * "FOR" that look like ASX tickers.
   */
  validCodes: string[];
  className?: string;
}

const CODE_PATTERN = /\b([A-Z]{2,4})\b/g;
const CITATION_PATTERN = /\[ref-\d+\]/g;

/**
 * Renders narrative text with two inline transforms applied in one
 * pass:
 *  - `[ref-N]` markers → superscript citation pills with hover titles
 *  - Bare ASX stock codes (limited to {validCodes}) → links to
 *    `/shorts/[code]`
 *
 * Replaces CitationRenderer on report pages where prose mentions
 * specific tickers. Both transforms run on the same token stream so
 * a citation immediately following a stock code (`BHP [ref-3]`) still
 * works.
 */
export function LinkifiedNarrative({
  text,
  citations,
  validCodes,
  className,
}: LinkifiedNarrativeProps) {
  if (!text) return null;

  // Citation lookup map.
  const citationMap = new Map<string, ReportCitation>();
  for (const c of citations) {
    citationMap.set(c.id, c);
  }

  // Stock-code lookup set.
  const codeSet = new Set(validCodes.map((c) => c.toUpperCase()));

  // Combined splitter: capture both [ref-N] and bare stock codes so we
  // can render them as links while preserving surrounding text.
  // We scan in two passes — first by citation, then within each plain
  // segment by stock code — to keep regex complexity low.
  const citationSegments = text.split(/(\[ref-\d+\])/g);

  return (
    <span className={className}>
      {citationSegments.flatMap<React.ReactNode>((segment, segIdx) => {
        // Citation segment: render the superscript pill (or fall back
        // to plain text if the ref-N has no matching citation).
        const citationMatch = segment.match(/^\[ref-(\d+)\]$/);
        if (citationMatch) {
          const refId = `ref-${citationMatch[1]}`;
          const citation = citationMap.get(refId);
          if (!citation) {
            return [<span key={`s${segIdx}`}>{segment}</span>];
          }
          const tooltip = [
            citation.source,
            citation.date ? `(${citation.date})` : "",
            citation.type ? `[${citation.type.replace(/_/g, " ")}]` : "",
          ]
            .filter(Boolean)
            .join(" ");
          return [
            <a
              key={`c${segIdx}`}
              href={`#${refId}`}
              title={tooltip}
              className="relative -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary/10 px-0.5 text-[10px] font-semibold text-primary no-underline transition-colors hover:bg-primary/20"
            >
              {citationMatch[1]}
            </a>,
          ];
        }

        // Plain text segment — scan for stock codes and linkify the
        // matches that are in validCodes.
        return splitByStockCodes(segment, codeSet, segIdx);
      })}
    </span>
  );
}

function splitByStockCodes(
  segment: string,
  codeSet: Set<string>,
  segIdx: number,
): React.ReactNode[] {
  // Reset lastIndex on each call (RegExp keeps state between calls).
  CODE_PATTERN.lastIndex = 0;
  const out: React.ReactNode[] = [];
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = CODE_PATTERN.exec(segment)) !== null) {
    const code = match[1]!;
    if (!codeSet.has(code)) continue;
    if (match.index > lastEnd) {
      out.push(
        <span key={`s${segIdx}-${i++}`}>
          {segment.slice(lastEnd, match.index)}
        </span>,
      );
    }
    out.push(
      <Link
        key={`l${segIdx}-${i++}`}
        href={`/shorts/${code}`}
        prefetch={false}
        className="font-semibold text-primary underline-offset-2 hover:underline"
      >
        {code}
      </Link>,
    );
    lastEnd = match.index + code.length;
  }
  if (lastEnd < segment.length) {
    out.push(<span key={`s${segIdx}-${i++}`}>{segment.slice(lastEnd)}</span>);
  }
  if (out.length === 0) {
    out.push(<span key={`s${segIdx}-0`}>{segment}</span>);
  }
  return out;
}

/**
 * Helper: scan freeform text for ASX-style codes that appear in
 * {allCodes}. Useful for callers that want to compute a unique set
 * of mentioned stocks (e.g. to drive a "stocks mentioned" sidebar).
 */
export function extractMentionedCodes(
  text: string,
  allCodes: string[],
): string[] {
  const codeSet = new Set(allCodes.map((c) => c.toUpperCase()));
  const found = new Set<string>();
  // Strip citation markers first so we don't accidentally match the N
  // inside [ref-N] (the regex requires 2+ chars but be defensive).
  const clean = text.replace(CITATION_PATTERN, " ");
  CODE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_PATTERN.exec(clean)) !== null) {
    const code = match[1]!;
    if (codeSet.has(code)) {
      found.add(code);
    }
  }
  return [...found];
}
