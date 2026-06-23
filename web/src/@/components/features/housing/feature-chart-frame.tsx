import type { ReactNode } from "react";
import { getSource } from "./data/sources";

/**
 * Frames an interactive dashboard: amber eyebrow, serif title, optional
 * subtitle, the chart, then a footer with a data note and clickable source
 * links back to the bibliography.
 */
export function FeatureChartFrame({
  eyebrow,
  title,
  subtitle,
  children,
  sourceIds = [],
  note,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  sourceIds?: string[];
  note?: string;
}) {
  return (
    <figure className="my-12 overflow-hidden rounded-xl border border-border bg-card shadow-amber-sm">
      <figcaption className="border-b border-border px-5 py-4 sm:px-6">
        {eyebrow ? (
          <div className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-primary">
            {eyebrow}
          </div>
        ) : null}
        <h3 className="mt-1 font-serif text-xl text-foreground sm:text-2xl">{title}</h3>
        {subtitle ? (
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
        ) : null}
      </figcaption>

      <div className="px-2 py-5 sm:px-4">{children}</div>

      {sourceIds.length > 0 || note ? (
        <div className="border-t border-border px-5 py-3 text-xs leading-relaxed text-muted-foreground sm:px-6">
          {note ? <p className="mb-1">{note}</p> : null}
          {sourceIds.length > 0 ? (
            <p>
              <span className="text-muted-foreground/70">Source: </span>
              {sourceIds.map((id, i) => {
                const s = getSource(id);
                if (!s) return null;
                return (
                  <span key={id}>
                    {i > 0 ? "; " : null}
                    <a
                      href={`#source-${s.id}`}
                      className="text-primary/80 underline-offset-2 hover:text-primary hover:underline"
                    >
                      {s.publisher}
                    </a>
                  </span>
                );
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </figure>
  );
}
