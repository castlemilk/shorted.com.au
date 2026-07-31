import { CaveatNote, SourceLine } from "@/components/politicians/compliance";
import { sectionTitle } from "@/lib/typography";

export interface AboutThisDataProps {
  sourceLabel: string;
  sourceUrl?: string;
  licence: string;
  asAt: string;
  methodologyHref?: string;
  reportErrorHref: string;
  surface?: string;
}

function asDate(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function AboutThisData({
  sourceLabel,
  sourceUrl,
  licence,
  asAt,
  methodologyHref,
  reportErrorHref,
  surface = "politician explorer",
}: AboutThisDataProps) {
  return (
    <footer className="space-y-4 border-t pt-6">
      <h2 className={sectionTitle}>About this data</h2>
      <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
        <p>
          <span className="font-medium text-foreground/80">Source: </span>
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted hover:text-foreground"
            >
              {sourceLabel}
            </a>
          ) : (
            sourceLabel
          )}
        </p>
        <p>
          <span className="font-medium text-foreground/80">Licence: </span>
          {licence}
        </p>
        <p>
          <span className="font-medium text-foreground/80">As at: </span>
          <time dateTime={asAt}>{asAt}</time>
        </p>
        <p className="flex flex-wrap gap-x-3 gap-y-1">
          {methodologyHref ? (
            <a
              href={methodologyHref}
              className="underline decoration-dotted hover:text-foreground"
            >
              Methodology
            </a>
          ) : null}
          <a
            href={reportErrorHref}
            className="underline decoration-dotted hover:text-foreground"
          >
            Report an error
          </a>
        </p>
      </div>
      <SourceLine asAt={asDate(asAt)} pdfUrl={sourceUrl} surface={surface} />
      <CaveatNote />
    </footer>
  );
}
