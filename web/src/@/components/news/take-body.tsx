"use client";

import { LinkifiedNarrative } from "~/@/components/reports/linkified-narrative";

export interface TakeCitation {
  refId: string;
  url: string;
  source: string;
  headline: string;
  date: string;
  type: string;
}

interface TakeBodyProps {
  bodyMd: string;
  citations: TakeCitation[];
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
export function TakeBody({ bodyMd, citations, stockCode }: TakeBodyProps) {
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

  return (
    <div>
      <div className="space-y-5 text-base leading-relaxed">
        {paragraphs.map((para, i) => (
          <p key={i} className="text-foreground/90">
            <LinkifiedNarrative
              text={para}
              citations={adapted}
              validCodes={validCodes}
            />
          </p>
        ))}
      </div>

      {citations.length > 0 ? (
        <aside className="mt-10 border-t border-border pt-6">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-orange-400">
            Sources
          </h2>
          <ol className="space-y-2 text-sm">
            {citations.map((c) => (
              <li
                key={c.refId}
                id={c.refId}
                className="flex gap-3 scroll-mt-20"
              >
                <span className="flex-shrink-0 font-mono text-xs text-orange-300">
                  [{c.refId.replace("ref-", "")}]
                </span>
                <div className="min-w-0 flex-1">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground hover:text-orange-300"
                  >
                    {c.headline}
                  </a>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {c.source} · {c.date}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      ) : null}
    </div>
  );
}
