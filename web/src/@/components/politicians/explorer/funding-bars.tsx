/**
 * A horizontal bar list for ONE funding measure.
 *
 * ONE CHART PER MEASURE, NEVER A STACK. The AEC publishes three figures that a
 * reader will assume are three parts of one total, and they are not: a party's
 * own annual return declares what it says it received; itemised receipts are the
 * transaction rows the RECIPIENT declared; declared donations are the rows the
 * DONOR declared. The three are drawn from different forms lodged by different
 * people, they do not reconcile, and stacking or summing them would publish an
 * arithmetic relationship that does not exist. So this component renders exactly
 * one measure, names it in its own heading, and the surface renders it three
 * times rather than once with three series.
 *
 * PROPS-ONLY KIT, like every file in this directory: no data fetching, no
 * generated protobuf, no compliance imports (the transitive client-boundary
 * check walks this graph). Colours arrive as strings so the caller owns the
 * party palette.
 *
 * The bars are scaled to the LARGEST VALUE IN THE SET, and the exact figure sits
 * beside every one of them: a bar is an aid to comparison, never the only
 * rendering of an amount. The `sr-only` table carries the same figures in the
 * same order, so nothing here is available to sighted readers only.
 */

import { formatCents, formatCount } from "@/lib/politics/funding-money";

export interface FundingBarRow {
  /** The party group's own verbatim key. Never re-labelled. */
  label: string;
  /** Party colour, or the neutral grey. Category only — never a grade. */
  color: string;
  /** The measure, in cents. */
  valueCents: number;
  /**
   * A count that belongs to the SAME measure — payers for a receipts chart,
   * donors for a donations chart. Rendered as a caption, never as a bar: two
   * different units in one bar chart is how a count gets read as an amount.
   */
  countLabel?: string;
  /**
   * TRUE when this row's year is lodged under the post-1-Jan-2027 scheme. A set
   * mixing both is two regimes, and the caller renders the reform note beside
   * it; the row itself carries a marker so the mixture is visible in the chart.
   */
  postReformScheme?: boolean;
}

export interface FundingBarsProps {
  /** What this chart measures, in full. Becomes the heading and the aria label. */
  measureLabel: string;
  /** Who declared it, in one line. Rendered under the heading. */
  measureNote: string;
  rows: FundingBarRow[];
  /** Said plainly when there is nothing to draw. Never a zero bar. */
  emptyLabel?: string;
}

function safeCents(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function FundingBars({
  measureLabel,
  measureNote,
  rows,
  emptyLabel = "No party group lodged this measure in this year.",
}: FundingBarsProps) {
  const values = rows.map((row) => ({ ...row, valueCents: safeCents(row.valueCents) }));
  const max = values.reduce((most, row) => Math.max(most, row.valueCents), 0);

  return (
    <figure className="space-y-2">
      <figcaption className="space-y-0.5">
        <h3 className="text-sm font-medium text-foreground">{measureLabel}</h3>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{measureNote}</p>
      </figcaption>

      {values.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-[11px] text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <>
          <ul
            aria-hidden
            className="space-y-1.5"
          >
            {values.map((row) => (
              <li key={row.label} className="space-y-0.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[11px] text-foreground" title={row.label}>
                    {row.label}
                    {row.postReformScheme ? (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        (reformed scheme)
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatCents(row.valueCents)}
                  </span>
                </div>
                <span className="flex h-2 w-full rounded-sm bg-muted">
                  <span
                    data-funding-bar
                    className="block h-2 rounded-sm"
                    style={{
                      width: `${max > 0 ? (row.valueCents / max) * 100 : 0}%`,
                      backgroundColor: row.color,
                    }}
                  />
                </span>
                {row.countLabel ? (
                  <span className="block text-[10px] tabular-nums text-muted-foreground">
                    {row.countLabel}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>

          {/*
            The same figures, for a screen reader. `aria-hidden` on the bars
            above and a real table here is the pattern the rest of the explorer
            kit uses: an aria-label listing twenty parties and twenty amounts is
            one unnavigable sentence, whereas a table can be read row by row.
          */}
          <table className="sr-only">
            <caption>
              {measureLabel}. {measureNote}
            </caption>
            <thead>
              <tr>
                <th scope="col">Party group</th>
                <th scope="col">{measureLabel}</th>
              </tr>
            </thead>
            <tbody>
              {values.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td className="tabular-nums">
                    {formatCents(row.valueCents)}
                    {row.countLabel ? ` — ${row.countLabel}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}

/**
 * A count caption for a bar, phrased for its own measure.
 *
 * Exported so the caller cannot phrase a payer count as a donor count: the two
 * come from different sides of the ledger and mean different things.
 */
export function payerCountLabel(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "payer" : "payers"} named`;
}

export function donorCountLabel(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "donor" : "donors"} declared giving`;
}

export function returnCountLabel(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "return" : "returns"} lodged`;
}
