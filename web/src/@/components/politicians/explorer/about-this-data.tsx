/**
 * The "About this data" band at the foot of an explorer surface.
 *
 * PROPS-ONLY, DELIBERATELY. The first cut of this component imported
 * `SourceLine`/`CaveatNote` from `../compliance`, which has no "use client" and
 * imports `RegisterHolder` from the generated protobuf module. That quietly
 * broke the kit's contract for every other file in this directory: any client
 * island composing this band would have dragged the protobuf runtime across the
 * RSC boundary and taken a route's static build down with the undiagnosable
 * "Element type is invalid" error. The transitive check in
 * `../../__tests__/client-boundary.test.ts` now walks the import graph so the
 * same import cannot come back.
 *
 * It also composed badly. `SourceLine`'s link is labelled "Original PDF" and
 * means THE DOCUMENT A ROW CAME FROM; feeding it a page-level register landing
 * URL cited the wrong kind of thing under a label that promised a specific one.
 * And it carried its own "Report an error" link, so the band rendered two.
 *
 * So: one band, every string a prop, no claims of its own. The host page owns
 * the wording of the source label, the licence line and the method link — the
 * same way it owns `CaveatNote`, which belongs beside the DATA it qualifies and
 * not inside a reusable footer.
 */

import { sectionTitle } from "@/lib/typography";

export interface AboutThisDataProps {
  /**
   * What the source link actually points at. The default names the registers
   * and the host, because "Original PDF" over a landing page is the error this
   * component was rebuilt to remove.
   */
  sourceLabel?: string;
  /** Where the source label links. Omitted -> the label renders as plain text. */
  sourceHref?: string;
  /** The licence the extracted facts are published under. */
  licence: string;
  /**
   * An ISO 8601 date ("2026-07-31" or a full timestamp). Machine value for
   * `<time dateTime>`, formatted separately for display — a human string like
   * "31 July 2026" is not a valid `dateTime` and was previously used as both.
   */
  asAt: string;
  /** Optional: how often the extraction runs. Rendered only when supplied. */
  updateCadence?: string;
  methodologyHref?: string;
  reportErrorHref: string;
}

const DEFAULT_SOURCE_LABEL =
  "Registers of Members’ and Senators’ Interests (aph.gov.au)";

/**
 * Split an ISO date into its machine and display forms.
 *
 * Formatted in UTC on purpose: `new Date("2026-07-31")` is UTC midnight, and
 * formatting that in a timezone behind UTC prints the previous day — an as-at
 * date that disagrees with itself by one day is worse than no as-at date.
 */
function asAtParts(value: string): { machine?: string; display: string } {
  const trimmed = value.trim();
  if (!trimmed) return { display: "" };
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    // Not parseable: show what we were given rather than inventing a date, and
    // emit no `dateTime` attribute rather than an invalid one.
    return { display: trimmed };
  }
  return {
    machine: parsed.toISOString().slice(0, 10),
    display: parsed.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
}

const LINK_CLASS = "underline decoration-dotted hover:text-foreground";

export function AboutThisData({
  sourceLabel = DEFAULT_SOURCE_LABEL,
  sourceHref,
  licence,
  asAt,
  updateCadence,
  methodologyHref,
  reportErrorHref,
}: AboutThisDataProps) {
  const { machine, display } = asAtParts(asAt);

  return (
    <footer className="space-y-3 border-t pt-6">
      <h2 className={sectionTitle}>About this data</h2>
      <dl className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
        <div className="flex flex-wrap gap-x-1">
          <dt className="font-medium text-foreground/80">Source:</dt>
          <dd>
            {sourceHref ? (
              <a
                href={sourceHref}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK_CLASS}
              >
                {sourceLabel}
              </a>
            ) : (
              sourceLabel
            )}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-1">
          <dt className="font-medium text-foreground/80">Licence:</dt>
          <dd>{licence}</dd>
        </div>
        {display ? (
          <div className="flex flex-wrap gap-x-1">
            <dt className="font-medium text-foreground/80">As at:</dt>
            <dd>
              {machine ? <time dateTime={machine}>{display}</time> : display}
            </dd>
          </div>
        ) : null}
        {updateCadence ? (
          <div className="flex flex-wrap gap-x-1">
            <dt className="font-medium text-foreground/80">Updated:</dt>
            <dd>{updateCadence}</dd>
          </div>
        ) : null}
      </dl>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {methodologyHref ? (
          <a href={methodologyHref} className={LINK_CLASS}>
            Methodology
          </a>
        ) : null}
        <a href={reportErrorHref} className={LINK_CLASS}>
          Report an error
        </a>
      </p>
    </footer>
  );
}
