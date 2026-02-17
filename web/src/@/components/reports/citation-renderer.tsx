"use client";

import { type ReportCitation } from "~/app/actions/reports/getReportData";

interface CitationRendererProps {
  text: string;
  citations: ReportCitation[];
  className?: string;
}

/**
 * Renders narrative text with inline [ref-N] markers converted to
 * superscript citation links with hover tooltips showing source info.
 */
export function CitationRenderer({
  text,
  citations,
  className,
}: CitationRendererProps) {
  if (!text) return null;

  // Build lookup map: "ref-1" → citation
  const citationMap = new Map<string, ReportCitation>();
  for (const c of citations) {
    citationMap.set(c.id, c);
  }

  // Split text by [ref-N] patterns
  const parts = text.split(/(\[ref-\d+\])/g);

  return (
    <span className={className}>
      {parts.map((part, i) => {
        const match = part.match(/^\[ref-(\d+)\]$/);
        if (!match) {
          return <span key={i}>{part}</span>;
        }

        const refId = `ref-${match[1]}`;
        const citation = citationMap.get(refId);
        if (!citation) {
          return <span key={i}>{part}</span>;
        }

        const tooltipText = [
          citation.source,
          citation.date ? `(${citation.date})` : "",
          citation.type ? `[${citation.type.replace(/_/g, " ")}]` : "",
        ]
          .filter(Boolean)
          .join(" ");

        const num = match[1];

        return (
          <a
            key={i}
            href={`#${refId}`}
            title={tooltipText}
            className="relative -top-1 inline-flex items-center justify-center h-4 min-w-4 px-0.5 text-[10px] font-semibold text-primary bg-primary/10 rounded hover:bg-primary/20 transition-colors no-underline"
          >
            {num}
          </a>
        );
      })}
    </span>
  );
}

interface CitationFootnotesProps {
  citations: ReportCitation[];
}

/**
 * Renders a numbered list of citation sources as footnotes.
 */
export function CitationFootnotes({ citations }: CitationFootnotesProps) {
  if (!citations || citations.length === 0) return null;

  return (
    <section className="border-t border-border/40 pt-4 mt-6">
      <h3 className="text-sm font-semibold text-muted-foreground mb-2">
        Sources
      </h3>
      <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
        {citations.map((c) => {
          const typeLabel = c.type
            ? ` [${c.type.replace(/_/g, " ")}]`
            : "";
          return (
            <li key={c.id} id={c.id} className="scroll-mt-24">
              {c.url ? (
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {c.source}
                </a>
              ) : (
                <span>{c.source}</span>
              )}
              {c.date && (
                <span className="ml-1">({c.date})</span>
              )}
              {typeLabel && (
                <span className="ml-1 text-muted-foreground/60">
                  {typeLabel}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
