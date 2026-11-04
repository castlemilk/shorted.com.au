import type { ReactNode } from "react";

import { cn } from "~/@/lib/utils";
import { formatRuleMeasure } from "~/@/lib/strategies/evidence";
import type { RankingInput, SignalRule } from "~/@/lib/strategies/signals";
import type { PickRow } from "~/@/lib/strategies/types";
import { StatusPill } from "~/@/components/picks/picks-table";
import { SortedByValue } from "~/@/components/picks/pick-fundamentals";
import { pickSortDef, type PickSortKey } from "~/@/lib/strategies/sort";
import { RuleCell } from "./rule-cell";

/**
 * The stock-by-rule matrix of the Signals tab: one row per stock, the status,
 * one RuleCell column per core rule, then the strategy's ranking inputs. A
 * server-renderable table with no hooks; the island owns the selection, and the
 * stock code is the one button in each row.
 */
export interface SignalsMatrixProps {
  rows: readonly PickRow[];
  /** The core rules, in the strategy's order: one column each. */
  rules: readonly SignalRule[];
  rankingInputs: readonly RankingInput[];
  /** The selected stock's code, or null. */
  selected: string | null;
  /**
   * The key the list is sorted by, or null in rank order. A sort on a figure the
   * matrix does not show adds a "Sorted by" column, so the order reads.
   */
  sortKey?: PickSortKey | null;
  onSelect: (code: string) => void;
  /** Screen-reader caption for the table. */
  caption: string;
  /** A full-width last row under the stocks, e.g. the sign-in prompt. */
  footer?: ReactNode;
}

const TH = "whitespace-nowrap px-3 py-2 text-left font-medium";
const TH_NUM = cn(TH, "text-right");

export function SignalsMatrix({
  rows,
  rules,
  rankingInputs,
  selected,
  sortKey = null,
  onSelect,
  caption,
  footer,
}: SignalsMatrixProps) {
  const sortDef = sortKey ? pickSortDef(sortKey) : null;
  const columns = 2 + rules.length + rankingInputs.length + (sortDef ? 1 : 0);
  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <th scope="col" className={TH}>
              Code
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
            {rules.map((rule) => (
              <th
                key={rule.id}
                scope="col"
                className={cn(TH, "normal-case tracking-normal")}
              >
                <span className="block max-w-[10rem] whitespace-normal font-medium leading-tight text-foreground">
                  {rule.title}
                </span>
                <span className="mt-1 inline-block rounded-sm border border-border px-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  Core
                </span>
              </th>
            ))}
            {rankingInputs.map((input) => (
              <th
                key={input.id}
                scope="col"
                title={input.title}
                className={cn(TH_NUM, "normal-case tracking-normal")}
              >
                {input.label}
              </th>
            ))}
            {sortDef ? (
              <th
                scope="col"
                aria-sort={sortDef.ascending ? "ascending" : "descending"}
                title={sortDef.title}
                className={cn(TH_NUM, "normal-case tracking-normal")}
              >
                <span className="sr-only">Sorted by </span>
                {sortDef.label}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => {
            const isSelected = row.code === selected;
            return (
              <tr
                key={row.code}
                data-status={row.status}
                data-selected={isSelected || undefined}
                className={cn(
                  "transition-colors duration-150 hover:bg-muted/30 motion-reduce:transition-none",
                  isSelected && "bg-primary/5",
                )}
              >
                <td className="px-3 py-2 align-top">
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => onSelect(row.code)}
                    className="rounded-sm text-left font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {row.code}
                  </button>
                  {row.name ? (
                    <span className="hidden max-w-[200px] truncate text-xs font-normal text-muted-foreground sm:block">
                      {row.name}
                    </span>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top">
                  <StatusPill status={row.status} />
                </td>
                {rules.map((rule) => {
                  const result = row.rules.find((r) => r.ruleId === rule.id);
                  return (
                    <RuleCell
                      key={rule.id}
                      title={rule.title}
                      result={result}
                      measure={formatRuleMeasure(rule, result)}
                    />
                  );
                })}
                {rankingInputs.map((input) => (
                  <td
                    key={input.id}
                    className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums"
                  >
                    {input.read(row)}
                  </td>
                ))}
                {sortKey ? (
                  <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums">
                    <SortedByValue row={row} sortKey={sortKey} />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
        {footer ? (
          <tfoot>
            <tr className="border-t bg-muted/20">
              <td
                colSpan={columns}
                className="px-3 py-3 text-sm text-muted-foreground"
              >
                {footer}
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
