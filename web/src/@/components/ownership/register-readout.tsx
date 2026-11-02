import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { asAtRange } from "~/@/lib/ownership/kinds";
import { DisclosedBar, type DisclosedSegment } from "./disclosed-bar";
import { Dated } from "./ownership-provenance";

// Server-safe: no "use client", no Connect import.
//
// The register's one lit surface (DESIGN.md, the One Bloom Rule). Kinds and
// short interest never share a panel: short interest is in the plate and the
// link row, and nothing in this readout names it.

// The stock header's label and figure classes, so the register reads as the same instrument.
const LABEL = "font-mono text-[10px] uppercase leading-3 text-muted-foreground";
const FIGURE = "font-mono text-2xl font-bold leading-none tabular-nums";
const META = "mt-1 font-mono text-[11px] leading-4 tabular-nums text-muted-foreground";

const BAR_CAPTION =
  "What the notices disclose, each interest counted once; not a share of the company.";

export interface RegisterReadoutProps {
  /** The stock's ASX code. The readout's labels name no stock; the page's heading does. */
  code: string;
  /** The disclosed sum, formatted; the page passes "n/a" when no holder is current. */
  disclosed: string;
  /** Interests counted once, after the overlap rule. */
  interests: number;
  /** Current substantial holders. */
  holders: number;
  /** The date the notices are read to. */
  asOf: string;
  /** Index fund holdings as a share of shares on issue, or null when no file holds the stock. */
  indexPct: string | null;
  indexFiles: number;
  indexFrom: string;
  indexTo: string;
  /** Super options holding the stock: the cell's figure. */
  superOptions: number;
  /** The combined value of those options, or null when unknown: the cell's meta line. */
  superValue: string | null;
  superFrom: string;
  superTo: string;
  segments: readonly DisclosedSegment[];
  total: number;
}

function countOf(n: number, one: string): string {
  return `${n.toLocaleString("en-AU")} ${n === 1 ? one : `${one}s`}`;
}

export function RegisterReadout({
  disclosed,
  interests,
  holders,
  asOf,
  indexPct,
  indexFiles,
  indexFrom,
  indexTo,
  superOptions,
  superValue,
  superFrom,
  superTo,
  segments,
  total,
}: RegisterReadoutProps) {
  const current = holders > 0;
  const indexed = indexFiles > 0;
  const superHeld = superOptions > 0;

  return (
    <section aria-label="The register" className="rounded-lg border bg-card p-4 shadow-terminal-inset">
      <dl className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
        <div className="bg-card p-3">
          <dt className={LABEL}>Disclosed by notices</dt>
          <dd className={FIGURE} title={asOf ? `Notices read to ${asOf}` : undefined}>
            {current ? (disclosed || NOT_AVAILABLE) : NOT_AVAILABLE}
          </dd>
          <dd className={META}>
            {current
              ? `${countOf(interests, "interest")} counted once, ${countOf(holders, "holder")}; not a share of the company`
              : "no current holder read"}
          </dd>
        </div>
        <div className="bg-card p-3">
          <dt className={LABEL}>Index funds tracked</dt>
          <dd className={FIGURE}>{indexed ? (indexPct ?? NOT_AVAILABLE) : NOT_AVAILABLE}</dd>
          <dd className={META}>
            {indexed ? (
              <Dated text={`${countOf(indexFiles, "file")}, ${asAtRange(indexFrom, indexTo)}`} />
            ) : (
              "no file tracked holds it"
            )}
          </dd>
        </div>
        <div className="bg-card p-3">
          <dt className={LABEL}>Super options tracked</dt>
          <dd className={FIGURE}>{superHeld ? superOptions.toLocaleString("en-AU") : NOT_AVAILABLE}</dd>
          <dd className={META}>
            {superHeld ? (
              <Dated
                text={
                  superValue
                    ? `${superValue} combined, ${asAtRange(superFrom, superTo)}`
                    : asAtRange(superFrom, superTo)
                }
              />
            ) : (
              "none tracked holds it"
            )}
          </dd>
        </div>
      </dl>
      {/* With no sum there is no bar, and its caption would sit under nothing. */}
      {current && total > 0 ? (
        <div className="mt-4">
          <DisclosedBar
            segments={segments}
            total={total}
            scaleMax={total}
            showFigure={false}
            caption={BAR_CAPTION}
          />
        </div>
      ) : null}
    </section>
  );
}
