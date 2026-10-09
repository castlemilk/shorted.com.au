import Link from "next/link";
import { RuleDot } from "~/@/components/picks/picks-table";
import { FitStatusLine } from "~/@/components/stocks/strategy-fit-strip";
import type { StrategyDef } from "~/@/lib/strategies/types";
import type { StockStrategyFitRow } from "~/app/actions/getStockStrategyFit";
import { FIT_STATUS_STRENGTH } from "./strategy-levels";

// One strategy's full reading of one stock: status, score, rank and every
// rule beside the author's words, our test and the evidence the evaluator
// wrote. Props-only (no protobuf, no connect) so a server page renders it
// and it stays crawlable. The strategy's description paragraphs are NOT
// repeated here; the name links to the /picks page that owns them. A core
// rule is flagged beside its title, set off by a real space (not just a
// margin) so a screen reader reads "core" as a word of its own.

const RESULT_WORD = { pass: "Pass", fail: "Fail", unknown: "Unknown" } as const;

/**
 * Strongest first: triggered, setup, watch, none; a higher score first within
 * a status, no score after any score; equal fits keep the order given. The
 * chart opens on the same strategy (defaultStrategyId reads the same table),
 * so the first panel is always the one the chart is showing.
 */
export function sortFitsByStrength(
  fits: StockStrategyFitRow[],
): StockStrategyFitRow[] {
  return fits
    .map((fit, i) => ({ fit, i }))
    .sort(
      (a, b) =>
        FIT_STATUS_STRENGTH[b.fit.status] - FIT_STATUS_STRENGTH[a.fit.status] ||
        (b.fit.score ?? -1) - (a.fit.score ?? -1) ||
        a.i - b.i,
    )
    .map(({ fit }) => fit);
}

export function StrategyFitPanel({
  fit,
  definition,
}: {
  fit: StockStrategyFitRow;
  definition: StrategyDef | null;
}) {
  const headingId = `fit-${fit.strategyId}`;
  const defs = new Map((definition?.rules ?? []).map((r) => [r.id, r]));
  return (
    <section aria-labelledby={headingId} className="rounded-lg border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <h2 id={headingId} className="text-base font-semibold">
          <Link
            href={`/picks/${fit.strategyId}`}
            prefetch={false}
            className="text-primary hover:underline"
          >
            {fit.strategyName}
          </Link>
        </h2>
        <FitStatusLine fit={fit} />
      </header>
      <div className="overflow-x-auto border-t">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Rule
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                The rule
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                How we test it
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Result
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Evidence
              </th>
            </tr>
          </thead>
          <tbody className="divide-y align-top">
            {fit.rules.map((rule) => {
              const def = defs.get(rule.ruleId);
              const title =
                fit.ruleColumns.find((c) => c.id === rule.ruleId)?.title ??
                def?.title ??
                rule.ruleId;
              return (
                <tr key={rule.ruleId}>
                  <th scope="row" className="px-4 py-2 text-left font-medium">
                    {title}
                    {def?.core ? (
                      <>
                        {" "}
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          core
                        </span>
                      </>
                    ) : null}
                  </th>
                  <td className="px-4 py-2 text-muted-foreground">
                    {def?.ruleText ?? ""}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {def?.evaluation ?? ""}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <RuleDot status={rule.status} />
                      {RESULT_WORD[rule.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2">{rule.detail}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
