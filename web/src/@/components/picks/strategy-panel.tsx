import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { eyebrow, sectionTitle } from "~/@/lib/typography";
import { dataSourceLabel } from "~/@/lib/strategies/format";
import type { StrategyDef } from "~/@/lib/strategies/types";

/**
 * The strategy explained: the method, every rule in the author's terms beside
 * exactly how we test it, the metadata, what our data cannot see, and the
 * sources.
 *
 * PROPS-ONLY, DELIBERATELY. It takes plain StrategyDef data (mapped from the
 * API in the server action) and imports nothing from the generated protobuf
 * modules or @connectrpc, so any client island can compose it without pulling
 * the protobuf runtime across the RSC boundary: the failure mode that took
 * /politicians' static build down with "Element type is invalid"
 * (__tests__/client-boundary.test.ts guards it). All prose comes from the API;
 * this component adds only headings and the standing disclaimer.
 */

function MetaItem({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="bg-card p-4">
      <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1.5 text-sm leading-relaxed">{value}</dd>
    </div>
  );
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "core" | "scored" | "source";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] leading-none",
        tone === "core" && "border-primary/50 bg-primary/10 font-medium uppercase tracking-[0.12em] text-primary",
        tone === "scored" && "border-border uppercase tracking-[0.12em] text-muted-foreground",
        tone === "source" && "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export interface StrategyPanelProps {
  strategy: StrategyDef;
}

export function StrategyPanel({ strategy }: StrategyPanelProps) {
  const metadata = strategy.metadata;
  const ruleCount =
    metadata && metadata.ruleCount > 0 ? metadata.ruleCount : strategy.rules.length;

  return (
    <div className="space-y-12">
      <section id="method" aria-labelledby="method-heading" className="scroll-mt-24">
        <h2 id="method-heading" className={sectionTitle}>
          The method
        </h2>
        {strategy.author ? (
          <p className={cn(eyebrow, "mt-2")}>
            {strategy.name} · {strategy.author}
          </p>
        ) : null}
        <div className="mt-4 max-w-3xl space-y-3 text-sm leading-relaxed sm:text-base">
          {strategy.descriptionParagraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>

        <h3 className={cn(eyebrow, "mt-8")}>Metadata</h3>
        <dl className="mt-3 grid gap-px overflow-hidden rounded-lg border border-border/60 bg-border/60 sm:grid-cols-2 lg:grid-cols-3">
          <MetaItem label="Style" value={metadata?.style ?? ""} />
          <MetaItem label="Holding period" value={metadata?.holdingPeriod ?? ""} />
          <MetaItem label="Risk posture" value={metadata?.riskPosture ?? ""} />
          <MetaItem label="Universe" value={metadata?.universe ?? ""} />
          <MetaItem label="Refresh cadence" value={metadata?.refreshCadence ?? ""} />
          <MetaItem label="Rules" value={ruleCount > 0 ? String(ruleCount) : ""} />
        </dl>
      </section>

      <section id="rules" aria-labelledby="rules-heading" className="scroll-mt-24">
        <h2 id="rules-heading" className={sectionTitle}>
          The rules
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Every rule resolves to pass, fail or unknown for every stock. Unknown
          means the data is missing: it never counts as a pass, and a stock
          cannot trigger while a core rule is unknown. Rules marked scoring only
          order the list without gating it.
        </p>
        <ol className="mt-5 divide-y divide-border/60 rounded-lg border border-border/60">
          {strategy.rules.map((rule, index) => (
            <li key={rule.id} className="p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span
                  aria-hidden="true"
                  className="w-6 text-sm tabular-nums text-muted-foreground"
                >
                  {index + 1}
                </span>
                <h3 className="text-base font-semibold tracking-tight">
                  <span className="sr-only">Rule {index + 1}: </span>
                  {rule.title}
                </h3>
                <Badge tone={rule.core ? "core" : "scored"}>
                  {rule.core ? "Core" : "Scoring only"}
                </Badge>
                {rule.dataSource ? (
                  <Badge tone="source">
                    <span className="sr-only">Data source: </span>
                    {dataSourceLabel(rule.dataSource)}
                  </Badge>
                ) : null}
              </div>
              <dl className="mt-3 grid gap-3 text-sm leading-relaxed sm:ml-9 md:grid-cols-2 md:gap-6">
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    The rule
                  </dt>
                  <dd className="mt-1">{rule.ruleText}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    How we test it
                  </dt>
                  <dd className="mt-1">{rule.evaluation}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      </section>

      {strategy.caveats.length > 0 ? (
        <section id="caveats" aria-labelledby="caveats-heading" className="scroll-mt-24">
          <h2 id="caveats-heading" className={sectionTitle}>
            What this cannot see
          </h2>
          <ul className="mt-4 max-w-3xl list-disc space-y-2 pl-5 text-sm leading-relaxed marker:text-muted-foreground">
            {strategy.caveats.map((caveat, index) => (
              <li key={index}>{caveat}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer
        id="sources"
        aria-labelledby="sources-heading"
        className="scroll-mt-24 space-y-3 border-t border-border/40 pt-6"
      >
        <h2
          id="sources-heading"
          className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
        >
          Sources
        </h2>
        {strategy.sources.length > 0 ? (
          <ul className="max-w-3xl space-y-1.5 text-sm leading-relaxed text-muted-foreground">
            {strategy.sources.map((source, index) => (
              <li key={index}>{source}</li>
            ))}
          </ul>
        ) : null}
        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
          <strong className="font-semibold text-foreground">Not financial advice.</strong>{" "}
          These picks are a mechanical reading of published rules against public
          data, not recommendations, and a stock that meets every rule can still
          fall. Prices and company fundamentals are third-party data and can lag a
          company&apos;s filings by weeks; short positions come from ASIC with a
          T+4 trading-day delay. The strategy is attributed to its author for
          identification only; the evaluation is ours. See the{" "}
          <Link href="/methodology" className="text-primary hover:underline">
            methodology
          </Link>{" "}
          and{" "}
          <Link href="/disclaimer" className="text-primary hover:underline">
            disclaimer
          </Link>
          .
        </p>
      </footer>
    </div>
  );
}
