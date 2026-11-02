import Link from "next/link";
import type { FundHolding } from "~/gen/shorts/v1alpha1/ownership_pb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { institutionHref, isPooledFile, registerHref } from "~/@/lib/ownership/kinds";
import { fileHoldingRow } from "~/@/lib/ownership/rows";
import { PooledFundMark } from "./pooled-fund-mark";

// Server-safe: no "use client", no Connect import. The Company card and the
// register both draw it, so the rows print as the institution page prints them
// (rows.ts), and a holding reads the same wherever it appears.

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  etf: "Index fund file",
  super_phd: "Super option",
};

const CAPTION =
  "Index fund figures are the funds' own holdings files; Vanguard's are the pooled fund behind each ETF, not the ETF alone (marked P). Super fund figures are one investment option's disclosure, never the whole fund. Each row carries its file's date.";

const EMPTY_LEAD = "No index fund file or super option disclosure tracked holds";
const EMPTY_BODY = "Only funds that publish a holdings file are tracked, and most do not;";

export interface StockFundTableProps {
  rows: readonly FundHolding[];
  /** The stock's ASX code, for the empty state and the default link. */
  code: string;
  /** Rows to draw before the link to the full register. Absent draws every row. */
  limit?: number;
  moreHref?: string;
}

export function StockFundTable({ rows, code, limit, moreHref }: StockFundTableProps) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {EMPTY_LEAD} {code}. {EMPTY_BODY}{" "}
        <Link href="/ownership#coverage" prefetch={false} className="text-primary underline-offset-4 hover:underline">
          the hub lists them
        </Link>
        .
      </p>
    );
  }

  const shown = limit === undefined ? rows : rows.slice(0, limit);
  const more = rows.length - shown.length;
  // A caption is as wide as its table, and the table scrolls sideways on a phone, so a
  // caption inside the table would scroll with it. The paragraph above wraps to the page.
  const captionId = `funds-caption-${code.toLowerCase()}`;

  return (
    <div className="space-y-3">
      <p id={captionId} className="text-xs text-muted-foreground">
        {CAPTION}
      </p>
      <Table aria-describedby={captionId}>
        <TableHeader>
          <TableRow>
            <TableHead>Fund</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Of shares</TableHead>
            <TableHead className="text-right">Of fund</TableHead>
            <TableHead>As at</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((holding, index) => {
            const row = fileHoldingRow(holding);
            const name = holding.institutionName || "Unnamed holder";
            const href = institutionHref(holding.institutionSlug);
            return (
              <TableRow key={index}>
                <TableCell className="max-w-64">
                  {href ? (
                    <Link href={href} prefetch={false} className="text-primary underline-offset-4 hover:underline">
                      {name}
                    </Link>
                  ) : (
                    <span>{name}</span>
                  )}
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{row.fund}</span>
                    {isPooledFile(holding) ? <PooledFundMark /> : null}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {SOURCE_LABEL[holding.sourceKind] ?? holding.sourceKind}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{row.value}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{row.ofShares}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{row.ofFund}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {row.asAt ? <time dateTime={row.asAt}>{row.asAt}</time> : NOT_AVAILABLE}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {more > 0 ? (
        <p className="text-sm">
          <Link
            href={moreHref ?? `${registerHref(code)}#funds`}
            prefetch={false}
            className="text-primary underline-offset-4 hover:underline"
          >
            {`All ${rows.length.toLocaleString("en-AU")} fund rows in the full register →`}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
