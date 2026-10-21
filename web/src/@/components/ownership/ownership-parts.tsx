import Link from "next/link";
import type {
  KindShare,
  OwnershipStock,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { Badge } from "~/@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { formatAmount, formatPct } from "~/@/lib/fundamentals/format";
import { holderHref, kindInfo, kindRank } from "~/@/lib/ownership/kinds";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { cn } from "~/@/lib/utils";

// Server components only: no "use client", no Connect import, type imports
// from the generated code. The ownership pages and the stock page's Company
// tab draw these into ISR HTML. The long tables are islands
// (ownership-tables.tsx, NoticeTable in notice-table.tsx), never imported
// from here: Next ships every client module a route's server graph reaches,
// and the Company tab reaches this file.

/**
 * A sum of voting powers: two decimals, so a column of sums lines up. A single
 * notice's figure keeps the precision it states (formatVotingPower).
 */
export function formatSum(pct: number | null | undefined): string {
  return formatPct(pct, { digits: 2 });
}

/** A kind's name as a small badge with its swatch. */
export function KindBadge({ kind }: { kind: string }) {
  const info = kindInfo(kind);
  return (
    <Badge variant="outline" className="gap-1.5 whitespace-nowrap font-normal">
      <span aria-hidden className={cn("inline-block h-2 w-2 rounded-sm", info.swatch)} />
      {info.label}
    </Badge>
  );
}

/**
 * Disclosed voting power by kind as one bar, 0 to 100% of the company. Holders'
 * interests can overlap, so a register whose notices sum past 100% is drawn
 * scaled to fit, and the text says so.
 */
export function KindBar({ byKind, className }: { byKind: readonly KindShare[]; className?: string }) {
  const shares = [...byKind].sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
  const total = shares.reduce((sum, k) => sum + k.pct, 0);
  const scale = total > 100 ? 100 / total : 1;
  const summary = shares.map((k) => `${kindInfo(k.kind).label} ${formatSum(k.pct)}`).join(", ");
  return (
    <div className={cn("flex h-2.5 w-full min-w-24 overflow-hidden rounded-sm bg-muted", className)}>
      <span className="sr-only">{summary}</span>
      {shares.map((k) => (
        <span
          key={k.kind}
          aria-hidden
          title={`${kindInfo(k.kind).label}: ${formatSum(k.pct)} (${k.holders} holder${k.holders === 1 ? "" : "s"})`}
          className={cn("h-full", kindInfo(k.kind).swatch)}
          style={{ width: `${k.pct * scale}%` }}
        />
      ))}
    </div>
  );
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

const INSTITUTIONAL = new Set([
  "super_fund",
  "index_manager",
  "hedge_fund",
  "active_manager",
  "bank_broker",
  "sovereign_public",
  "insurer",
]);

function kindSum(stock: OwnershipStock, accept: (kind: string) => boolean): number {
  return stock.byKind.filter((k) => accept(k.kind)).reduce((s, k) => s + k.pct, 0);
}

function cell(stock: OwnershipStock, col: StockColumn, superOptionsTotal?: number) {
  switch (col) {
    case "holders":
      return String(stock.holders);
    case "institutional":
      return formatSum(kindSum(stock, (k) => INSTITUTIONAL.has(k)));
    case "disclosed":
      return formatSum(stock.disclosedPct);
    case "bar":
      return <KindBar byKind={stock.byKind} />;
    case "longActive":
      return formatSum(kindSum(stock, (k) => k === "hedge_fund" || k === "active_manager"));
    case "bank":
      return formatSum(kindSum(stock, (k) => k === "bank_broker"));
    case "short":
      return stock.hasShortPct ? formatPct(stock.shortPct, { digits: 2 }) : "n/a";
    case "index":
      return stock.hasIndexPct ? formatPct(stock.indexPct, { digits: 2 }) : "n/a";
    case "superOptions":
      return superOptionsTotal ? `${stock.superOptions} of ${superOptionsTotal}` : String(stock.superOptions);
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
                href={stockTabHref(s.stockCode, "company")}
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
                {cell(s, c, superOptionsTotal)}
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

/** Where the figures come from, and what they are not. */
export function OwnershipMethodology({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-2 text-xs text-muted-foreground", className)}>
      <p>
        Substantial holdings are the voting power stated in each holder&apos;s latest ASX notice (Corporations Act
        s671B, Forms 603, 604 and 605), read from the notice PDF. A holding is shown until a later notice says it
        changed or ceased; the date is the notice&apos;s. Notices whose voting power cannot be read unambiguously (a
        scanned form, a figure only in an annexure) are withheld, never estimated.
      </p>
      <p>
        Holders&apos; interests can overlap: MUFG reports Morgan Stanley&apos;s and First Sentier&apos;s interests as
        its own. Sums count each interest once where the overlap is known (a group and its member count the larger
        figure; two notices disclosing the same voting power on the same date count once), and every holder is
        still listed. Other overlaps remain, so a sum is what the notices disclose, not a share of the company.
        Banks&apos; and brokers&apos; notices are mostly securities lending, often to short sellers.
      </p>
      <p>
        Index ETF holdings are the funds&apos; own holdings files; super fund holdings are each fund&apos;s portfolio
        holdings disclosure for one investment option (its default or balanced option), not the whole fund. Short
        interest is ASIC&apos;s daily short position report. Not financial advice.
      </p>
    </div>
  );
}
