import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "~/@/lib/utils";
import {
  evidenceHeadline,
  formatRuleMeasure,
  shortDayLabel,
} from "~/@/lib/strategies/evidence";
import type { SignalRule } from "~/@/lib/strategies/signals";
import type { PickRow } from "~/@/lib/strategies/types";
import { StatusPill } from "~/@/components/picks/picks-table";
import { RuleStateMark, ruleState, ruleStateWord } from "./rule-cell";

/**
 * The evidence for one stock on the Signals tab: its name and status, the
 * headline its status earns, the chart (passed in as a slot, because the chart
 * is a client module), and each core rule with its measure against threshold.
 * A stock the list does not hold, or one the strategy did not read, has no pick
 * and prints the notice instead.
 */
export interface EvidencePanelProps {
  code: string;
  /** The company name, when the list carries it; "" otherwise. */
  name: string;
  /** The stock's row, or null when there is none to read. */
  pick: PickRow | null;
  /** The strategy's rules: the core ones are listed, in order. */
  rules: readonly SignalRule[];
  /** Printed in place of the rules when there is no pick. */
  notice: string | null;
  /** The levels chart, drawn by the island. */
  chart: ReactNode;
  /** The stock page's strategy tab; no link when there is no stock. */
  openHref: string | null;
  /** The stock's signal history, drawn by the island (signed-in only); after the actions. */
  history?: ReactNode;
}

export function EvidencePanel({
  code,
  name,
  pick,
  rules,
  notice,
  chart,
  openHref,
  history,
}: EvidencePanelProps) {
  const coreRules = rules.filter((rule) => rule.core);
  const shortReport = shortDayLabel(pick?.shortReportDate);
  const shortAvailable = shortDayLabel(pick?.shortAvailableDate);
  return (
    <section
      aria-labelledby="signal-evidence-heading"
      data-evidence-code={code}
      className="flex flex-col gap-4 rounded-lg border border-border/60 bg-card p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <h3
          id="signal-evidence-heading"
          className="min-w-0 font-mono text-base font-semibold tracking-tight"
        >
          <span className="text-primary">{code}</span>
          {name ? (
            <span className="font-normal text-muted-foreground"> · {name}</span>
          ) : null}
        </h3>
        {pick ? <StatusPill status={pick.status} /> : null}
      </div>

      {chart}

      {pick ? (
        <>
          <p className="text-base font-semibold leading-snug">
            {evidenceHeadline(pick, rules)}
          </p>
          <ul className="divide-y border-y text-sm">
            {coreRules.map((rule) => {
              const result = pick.rules.find((r) => r.ruleId === rule.id);
              const state = ruleState(result);
              const measure = formatRuleMeasure(rule, result);
              return (
                <li key={rule.id} className="py-2" data-rule-state={state}>
                  <div className="flex items-center gap-2">
                    <RuleStateMark state={state} />
                    <span className="min-w-0 flex-1 font-medium">
                      {rule.title}
                    </span>
                    <span
                      className={cn(
                        "rounded-sm border px-1.5 py-0.5 text-[11px] uppercase leading-none tracking-[0.12em]",
                        state === "pass" && "border-primary/50 text-foreground",
                        state !== "pass" &&
                          "border-border text-muted-foreground",
                      )}
                    >
                      {ruleStateWord(state)}
                    </span>
                    {measure ? (
                      <span className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                        {measure}
                      </span>
                    ) : null}
                  </div>
                  {result?.detail ? (
                    <p className="mt-1 pl-[1.1rem] text-xs text-muted-foreground">
                      {result.detail}
                    </p>
                  ) : null}
                  {state === "waiting" && rule.evaluation ? (
                    <p className="mt-1 pl-[1.1rem] text-xs text-muted-foreground">
                      {rule.evaluation}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {shortReport ? (
            <p className="text-xs text-muted-foreground">
              Short report: {shortReport}
              {shortAvailable ? ` · available ${shortAvailable}` : ""}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {notice ?? "This stock is not in the list for this strategy today."}
        </p>
      )}

      {openHref ? (
        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Link
            href={openHref}
            prefetch={false}
            className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm font-medium hover:bg-muted/50"
          >
            Open stock →
          </Link>
        </div>
      ) : null}

      {/* After the actions, so a long history never moves "Open stock" below the sticky panel's fold. */}
      {history ? <div className="border-t pt-4">{history}</div> : null}
    </section>
  );
}
