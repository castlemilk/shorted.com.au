import { ArrowUpRight } from "lucide-react";

import type {
  EvidenceChannel,
  IndustryEvidenceSourceInput,
} from "~/@/lib/industry-intelligence";

const REPORT_ERROR_EMAIL = "support@shorted.com.au";

/**
 * Data-driven "Sources & methodology" section. Lists every source that is
 * actually feeding the page (plus the standing ASIC line), with publisher,
 * licence, and cadence — the citation-and-dating posture required by
 * docs/influence-editorial-standards.md.
 */
export function IndustryMethodology({
  channels,
  asAt,
}: {
  channels: EvidenceChannel[];
  asAt: string;
}) {
  const seen = new Set<string>();
  const sources: { channelLabel: string; source: IndustryEvidenceSourceInput }[] =
    [];
  for (const channel of channels) {
    for (const source of channel.sources) {
      if (seen.has(source.sourceKey)) continue;
      seen.add(source.sourceKey);
      sources.push({ channelLabel: channel.label, source });
    }
  }

  return (
    <section
      id="methodology"
      aria-labelledby="methodology-heading"
      className="min-w-0 scroll-mt-24 rounded-lg border border-border/60 bg-card/80 p-5 shadow-amber-sm md:p-6"
    >
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
        Sources &amp; methodology
      </p>
      <h2
        id="methodology-heading"
        className="mt-1 text-2xl font-semibold tracking-tight text-balance"
      >
        Where these figures come from
      </h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground text-pretty">
        Every figure on this page is imported from a published primary source,
        carries its as-at date, and links back to the register it came from.
        Company-level facts are joined only on exact ABN or reviewed
        entity-name matches — ambiguous names are excluded rather than guessed.
        Figures are presented side by side without causal claims.
      </p>

      <dl className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border/60 bg-background/70 p-4">
          <dt className="text-sm font-semibold">
            ASIC short position reports
          </dt>
          <dd className="mt-1 text-xs leading-5 text-muted-foreground">
            Australian Securities and Investments Commission · Daily, T+4
            reporting delay · Crowding metrics as at {asAt}
          </dd>
        </div>
        {sources.map(({ channelLabel, source }) => (
          <div
            key={source.sourceKey}
            className="rounded-md border border-border/60 bg-background/70 p-4"
          >
            <dt className="text-sm font-semibold">
              <a
                href={source.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-primary hover:underline"
              >
                {source.displayName}
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </a>
            </dt>
            <dd className="mt-1 text-xs leading-5 text-muted-foreground">
              {source.publisher} · {source.licence} · {channelLabel}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-5 text-xs leading-5 text-muted-foreground">
        Spotted a problem with a figure?{" "}
        <a
          href={`mailto:${REPORT_ERROR_EMAIL}?subject=${encodeURIComponent(
            "Data error report: industry intelligence",
          )}`}
          className="text-primary hover:underline"
        >
          Report an error
        </a>{" "}
        and the affected rows will be re-verified against the primary source.
      </p>
    </section>
  );
}
