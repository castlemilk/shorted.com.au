import Link from "next/link";
import type { OwnershipStock } from "~/gen/shorts/v1alpha1/ownership_pb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { formatAmount, formatPct } from "~/@/lib/fundamentals/format";
import { INVESTOR_KINDS, holderHref, registerHref } from "~/@/lib/ownership/kinds";
import { cn } from "~/@/lib/utils";
import { DisclosedBar } from "./disclosed-bar";

// Server components only: no "use client", no Connect import, type imports
// from the generated code. The ownership pages and the stock page's Company
// tab draw these into ISR HTML. The long tables are islands
// (ownership-tables.tsx, NoticeTable in notice-table.tsx), never imported
// from here: Next ships every client module a route's server graph reaches,
// and the Company tab reaches this file.

// The badge lives in its own module; re-exported so a page keeps one import.
export { KindBadge } from "./kind-badge";

/**
 * A sum of voting powers: two decimals, so a column of sums lines up. A single
 * notice's figure keeps the precision it states (formatVotingPower).
 */
export function formatSum(pct: number | null | undefined): string {
  return formatPct(pct, { digits: 2 });
}

export type StockColumn =
  | "holders"
  | "institutional"
  | "disclosed"
  | "bar"
  | "longActive"
  | "bank"
  | "short"
  | "index"
  | "superOptions"
  | "superValue";

const COLUMN_HEADS: Record<StockColumn, string> = {
  holders: "Holders",
  institutional: "Institutions",
  disclosed: "Disclosed",
  bar: "By kind",
  longActive: "Hedge + active",
  bank: "Banks, brokers",
  short: "Short",
  index: "Index funds",
  superOptions: "Super options",
  superValue: "Super value",
};

function kindSum(stock: OwnershipStock, accept: (kind: string) => boolean): number {
  return stock.byKind.filter((k) => accept(k.kind)).reduce((s, k) => s + k.pct, 0);
}

interface TableContext {
  superOptionsTotal?: number;
  /** The table's largest disclosed sum: every bar in it is drawn against this. */
  barScale: number;
}

function cell(stock: OwnershipStock, col: StockColumn, ctx: TableContext) {
  switch (col) {
    case "holders":
      return String(stock.holders);
    case "institutional":
      return formatSum(kindSum(stock, (k) => INVESTOR_KINDS.has(k)));
    case "disclosed":
      return formatSum(stock.disclosedPct);
    case "bar":
      return (
        <DisclosedBar
          segments={stock.byKind}
          total={stock.disclosedPct}
          scaleMax={ctx.barScale}
          showFigure={false}
        />
      );
    case "longActive":
      return formatSum(kindSum(stock, (k) => k === "hedge_fund" || k === "active_manager"));
    case "bank":
      return formatSum(kindSum(stock, (k) => k === "bank_broker"));
    case "short":
      return stock.hasShortPct ? formatPct(stock.shortPct, { digits: 2 }) : "n/a";
    case "index":
      return stock.hasIndexPct ? formatPct(stock.indexPct, { digits: 2 }) : "n/a";
    case "superOptions":
      return ctx.superOptionsTotal
        ? `${stock.superOptions} of ${ctx.superOptionsTotal}`
        : String(stock.superOptions);
    case "superValue":
      return stock.hasSuperValue ? formatAmount(stock.superValueAud, "AUD") : "n/a";
  }
}

/** A list of stocks with the columns a view needs. */
export function OwnershipStockTable({
  stocks,
  columns,
  caption,
  superOptionsTotal,
}: {
  stocks: readonly OwnershipStock[];
  columns: readonly StockColumn[];
  caption: string;
  superOptionsTotal?: number;
}) {
  if (stocks.length === 0) {
    return <p className="text-sm text-muted-foreground">No stocks meet this view yet.</p>;
  }
  const ctx: TableContext = {
    superOptionsTotal,
    barScale: Math.max(0, ...stocks.map((s) => s.disclosedPct)),
  };
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>Stock</TableHead>
          {columns.map((c) => (
            <TableHead key={c} className={c === "bar" ? "w-40" : "text-right"}>
              {COLUMN_HEADS[c]}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {stocks.map((s) => (
          <TableRow key={s.stockCode}>
            <TableCell className="min-w-0">
              <Link
                href={registerHref(s.stockCode)}
                prefetch={false}
                className="font-semibold text-primary underline-offset-4 hover:underline"
              >
                {s.stockCode}
              </Link>
              {s.companyName ? (
                <span className="ml-2 hidden truncate text-xs text-muted-foreground sm:inline">{s.companyName}</span>
              ) : null}
            </TableCell>
            {columns.map((c) => (
              <TableCell key={c} className={c === "bar" ? "" : "text-right tabular-nums"}>
                {cell(s, c, ctx)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * A notice's holder, linked to its institution page when it has one, or to its
 * own stock page when the holder is a listed company (holderHref).
 */
export function HolderName({
  name,
  slug,
  holderKey,
  fallback,
}: {
  name: string;
  slug: string;
  holderKey?: string;
  fallback?: string;
}) {
  const href = holderHref(slug, holderKey);
  // An empty name falls through to the fallback, so not `??`.
  const text = [name, fallback].find((s) => s) ?? "Unnamed holder";
  return href ? (
    <Link href={href} prefetch={false} className="text-primary underline-offset-4 hover:underline">
      {text}
    </Link>
  ) : (
    <span>{text}</span>
  );
}

// The method's three paragraphs. The hub, an institution page and the stock
// card all describe the same figures, so the words live once, here.
const METHOD_P1 =
  "Substantial holdings are the voting power stated in each holder's latest ASX notice (Corporations Act s671B, Forms 603, 604 and 605), read from the notice PDF. A holding is shown until a later notice read says it changed or ceased; the date is the notice's, and \"current\" means the newest notice we could read. A notice whose voting power cannot be read unambiguously (a scanned form, a figure only in an annexure) is withheld, never estimated.";
const METHOD_P2 =
  "Holders' interests can overlap: MUFG reports Morgan Stanley's and First Sentier's interests as its own. Sums count each interest once where the overlap is known (a group and its member count the larger figure; two notices disclosing the same voting power on the same date count once), and every holder is still listed. Other overlaps remain, so a sum is what the notices disclose, not a share of the company. Banks' and brokers' notices are often securities lending, so crowded registers do not count them. A fall in voting power is a fall in the notice's figure, not necessarily a disposal: a placement dilutes a holder whose shares did not change.";
const METHOD_P3 =
  "Index fund holdings are the funds' own holdings files (Vanguard's are the pooled fund behind each ETF); super fund holdings are each fund's portfolio holdings disclosure for one investment option, not the whole fund. Short interest is ASIC's daily short position report. Not financial advice.";

/**
 * The shared method, paragraph by paragraph. The method disclosure (workspace/method-disclosure.tsx)
 * draws them with a lead sentence each, so the words are read from here and not restated.
 */
export const METHOD_PARAGRAPHS: readonly string[] = [METHOD_P1, METHOD_P2, METHOD_P3];

/** Where the figures come from, and what they are not. */
export function OwnershipMethodology({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-2 text-xs text-muted-foreground", className)}>
      {METHOD_PARAGRAPHS.map((paragraph) => (
        <p key={paragraph.slice(0, 40)}>{paragraph}</p>
      ))}
    </div>
  );
}
