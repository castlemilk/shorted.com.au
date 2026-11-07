import Link from "next/link";
import { buttonVariants } from "~/@/components/ui/button";
import { cn } from "~/@/lib/utils";
import { EXPLORER_COPY, type ExplorerInspector } from "~/@/lib/strategies/explorer";
import { EquitySparkline } from "./equity-sparkline";

export interface StrategyInspectorProps {
  /** The strategy's slug: its profile and its rules are the links. */
  id: string;
  inspector: ExplorerInspector;
  /** The benchmark's name, as the run names it (the dashed line). */
  benchmarkName: string;
  /** false inside the bottom sheet, whose title already names the strategy. */
  heading?: boolean;
}

/**
 * The selected-strategy rail of the explorer: the name and author, its chips and tagline,
 * the backtest's growth line (in-sample, then recorded) with the benchmark dashed, the
 * state's own copy, the holding horizon, the latest screen and today's counts, the
 * survivorship statement, and the two links. Plain props only.
 *
 * "Create alert" is not drawn: its capability is off (capabilities.ts).
 */
export function StrategyInspector({ id, inspector, benchmarkName, heading = true }: StrategyInspectorProps) {
  return (
    <section aria-label={inspector.name} data-inspector={id} className="space-y-4">
      {heading ? (
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Selected strategy</p>
      ) : null}
      {heading ? (
        <div className="space-y-1">
          <h2 className="font-serif text-2xl font-semibold leading-tight tracking-tight">{inspector.name}</h2>
          {inspector.author ? <p className="text-sm text-muted-foreground">By {inspector.author}</p> : null}
        </div>
      ) : inspector.author ? (
        <p className="text-sm text-muted-foreground">By {inspector.author}</p>
      ) : null}
      {inspector.chips.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {inspector.chips.map((chip) => (
            <li
              key={chip}
              className="rounded-full border border-solid border-border px-2 py-0.5 font-mono text-[11px] text-foreground"
            >
              {chip}
            </li>
          ))}
        </ul>
      ) : null}
      {inspector.tagline ? <p className="text-sm leading-relaxed">{inspector.tagline}</p> : null}

      <figure className="space-y-2">
        <figcaption className="font-mono text-xs text-muted-foreground">{inspector.sparkLabel}</figcaption>
        <EquitySparkline
          label={inspector.sparkLabel}
          strategy={inspector.sparkline.strategy}
          benchmark={inspector.sparkline.benchmark}
          liveFrom={inspector.sparkline.liveFromMs ?? undefined}
          emptyLabel={inspector.emptyLabel}
        />
        {benchmarkName && inspector.sparkline.benchmark.length > 0 ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            Solid: this strategy. Dashed: {benchmarkName}.
          </p>
        ) : null}
        <p className="text-[11px] leading-relaxed text-muted-foreground">{EXPLORER_COPY.hypothetical}</p>
      </figure>

      {inspector.stateLine ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{inspector.stateLine}</p>
      ) : null}

      <dl className="divide-y divide-border/60 rounded-md border border-border/60 text-sm">
        <div className="flex justify-between gap-3 px-3 py-2">
          <dt className="text-muted-foreground">Holding horizon</dt>
          <dd className="text-right">{inspector.holdingHorizon || "n/a"}</dd>
        </div>
        <div className="flex justify-between gap-3 px-3 py-2">
          <dt className="text-muted-foreground">Latest screen</dt>
          <dd className="text-right tabular-nums">{inspector.latestScreen || "n/a"}</dd>
        </div>
        <div className="flex justify-between gap-3 px-3 py-2">
          <dt className="text-muted-foreground">Today</dt>
          <dd className="text-right tabular-nums">{inspector.countsText}</dd>
        </div>
      </dl>

      {inspector.survivorship ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-mono text-[11px] text-foreground">Survivorship: </span>
          {inspector.survivorship}
        </p>
      ) : null}

      {inspector.paperLine ? <p className="text-xs text-muted-foreground">{inspector.paperLine}</p> : null}

      <div className="space-y-2">
        <Link href={`/strategies/${id}`} prefetch={false} className={cn(buttonVariants({ variant: "default" }), "w-full")}>
          Explore strategy →
        </Link>
        <p className="text-center">
          <Link
            href={`/strategies/${id}/rules`}
            prefetch={false}
            className="text-sm text-primary underline underline-offset-2 hover:no-underline"
          >
            Rules and assumptions
          </Link>
        </p>
      </div>
    </section>
  );
}
