import { sourceLabel } from "~/@/lib/fundamentals/format";
import { PROVENANCE_GLYPHS } from "./statement-lines";

// Provenance marks for fundamentals figures (docs/plans/fundamentals-coverage.md
// §1 "Provenance travels with the data", §7.1). A value that did not come from
// the default vendor carries a letter glyph plus screen-reader text, and every
// view that shows a glyph shows a legend: provenance is never colour alone.
//
// Props-only and hook-free, so the server cards and the statements island
// (a client module) render the same marks.

/** The letter that marks a source; "*" for a source this page does not know. */
export function provenanceGlyph(source: string): string {
  return PROVENANCE_GLYPHS[source.trim()] ?? "*";
}

/** A superscript glyph with its meaning for screen readers and on hover. */
export function ProvenanceMark({ source }: { source: string }) {
  const label = sourceLabel(source);
  return (
    <>
      <sup
        aria-hidden="true"
        title={label}
        className="ml-0.5 cursor-help text-[10px] font-medium text-muted-foreground"
      >
        {provenanceGlyph(source)}
      </sup>
      <span className="sr-only"> (source: {label})</span>
    </>
  );
}

/** One line per distinct source: "F Company filing (extracted)". */
export function ProvenanceLegend({
  sources,
  className,
}: {
  sources: readonly string[];
  className?: string;
}) {
  const unique = Array.from(new Set(sources.map((s) => s.trim()).filter(Boolean)));
  if (unique.length === 0) return null;
  return (
    <ul
      aria-label="Source marks"
      className={
        className ??
        "flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground"
      }
    >
      {unique.map((source) => (
        <li key={source} className="inline-flex items-baseline gap-1">
          <span aria-hidden="true" className="font-medium">
            {provenanceGlyph(source)}
          </span>
          <span>{sourceLabel(source)}</span>
        </li>
      ))}
    </ul>
  );
}
