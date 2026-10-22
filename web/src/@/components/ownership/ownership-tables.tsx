"use client";

import { useId, useState } from "react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import type { FileHoldingRow, HoldingRow, NoticeRow } from "~/@/lib/ownership/rows";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { ExternalLinkGlyph } from "./external-link-glyph";

// The ownership tables that run long: an index manager's ninety-odd stakes, a
// hundred holdings-file rows, a hundred notices. Each is an island so its rows
// arrive as data the server formatted (lib/ownership/rows.ts), not as an
// element tree beside their HTML. The two holdings tables draw every row: they
// are the page's account of what an institution holds. The notices table can
// draw its first `limit` rows, newest first, and hold the rest behind "Show
// all". The page draws the external-link symbol the glyphs point at
// (ExternalLinkSymbol).

function useShown<T>(rows: readonly T[], limit: number | undefined) {
  const [expanded, setExpanded] = useState(false);
  const bounded = limit !== undefined && rows.length > limit;
  return {
    shown: bounded && !expanded ? rows.slice(0, limit) : rows,
    bounded,
    expanded,
    toggle: () => setExpanded((v) => !v),
  };
}

/**
 * The notices' control. GetInstitution serves a holder's newest 100 notices,
 * so a holder with more on record (State Street has 1,117) is told how many
 * it shows instead of "all".
 */
function ShowAll({
  served,
  onRecord,
  expanded,
  controls,
  onToggle,
}: {
  served: number;
  onRecord: number | undefined;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const label =
    onRecord !== undefined && onRecord > served
      ? `Show the latest ${served} of ${onRecord.toLocaleString("en-AU")} notices`
      : `Show all ${served} notices`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={controls}
      className="py-1 text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
    >
      {expanded ? "Show fewer" : label}
    </button>
  );
}

function StockLink({ code }: { code: string }) {
  return (
    <Link
      href={stockTabHref(code, "company")}
      prefetch={false}
      className="font-semibold text-primary underline-offset-4 hover:underline"
    >
      {code}
    </Link>
  );
}

/** The notice's ASX link; nothing when its stored URL is not http(s). */
function AsxLink({ url, label }: { url: string; label: string }) {
  const href = safeExternalHref(url);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="hit-target inline-flex text-muted-foreground hover:text-primary"
      aria-label={label}
    >
      <ExternalLinkGlyph />
    </a>
  );
}

/** An institution's current substantial holdings, largest first. */
export function SubstantialHoldingsTable({
  rows,
  holder,
  caption,
}: {
  rows: readonly HoldingRow[];
  /** The institution, for each ASX link's label. */
  holder: string;
  caption: string;
}) {
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>Stock</TableHead>
          <TableHead className="text-right">Voting power</TableHead>
          <TableHead className="text-right">Change</TableHead>
          <TableHead>As at</TableHead>
          <TableHead className="hidden md:table-cell">Notice</TableHead>
          <TableHead>
            <span className="sr-only">Document</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((p) => (
          <TableRow key={p.code}>
            <TableCell>
              <StockLink code={p.code} />
              {p.company ? (
                <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">{p.company}</span>
              ) : null}
            </TableCell>
            <TableCell className="text-right tabular-nums">{p.votingPower}</TableCell>
            <TableCell className="text-right tabular-nums">{p.change}</TableCell>
            <TableCell className="whitespace-nowrap tabular-nums">{p.asAt}</TableCell>
            <TableCell className="hidden md:table-cell">{p.form}</TableCell>
            <TableCell>
              <AsxLink url={p.url} label={`${holder}'s ${p.code} notice on ASX`} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The largest ASX holdings, by value, in an institution's holdings files. */
export function FileHoldingsTable({
  rows,
  caption,
}: {
  rows: readonly FileHoldingRow[];
  caption: string;
}) {
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>Stock</TableHead>
          <TableHead>Fund</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">Of fund</TableHead>
          <TableHead className="text-right">Of shares</TableHead>
          <TableHead>As at</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((h) => (
          <TableRow key={`${h.fund}|${h.code}`}>
            <TableCell>
              <StockLink code={h.code} />
            </TableCell>
            <TableCell className="max-w-64 truncate text-xs text-muted-foreground">{h.fund}</TableCell>
            <TableCell className="text-right tabular-nums">{h.value}</TableCell>
            <TableCell className="text-right tabular-nums">{h.ofFund}</TableCell>
            <TableCell className="text-right tabular-nums">{h.ofShares}</TableCell>
            <TableCell className="whitespace-nowrap tabular-nums">{h.asAt}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Substantial holding notices, newest first. */
export function NoticeRowsTable({
  rows,
  showStock,
  showHolder,
  caption,
  limit,
  onRecord,
}: {
  rows: readonly NoticeRow[];
  showStock: boolean;
  showHolder: boolean;
  caption: string;
  limit?: number;
  /** The holder's notices on record, which can be more than the rows served. */
  onRecord?: number;
}) {
  const bodyId = useId();
  const { shown, bounded, expanded, toggle } = useShown(rows, limit);
  return (
    <>
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>Released</TableHead>
            {showStock ? <TableHead>Stock</TableHead> : null}
            {showHolder ? <TableHead>Holder</TableHead> : null}
            <TableHead>Notice</TableHead>
            <TableHead className="text-right">Voting power</TableHead>
            <TableHead className="text-right">Change</TableHead>
            <TableHead>
              <span className="sr-only">Document</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody id={bodyId}>
          {shown.map((n) => (
            <TableRow key={n.url}>
              <TableCell className="whitespace-nowrap tabular-nums">{n.released}</TableCell>
              {showStock ? (
                <TableCell>
                  <StockLink code={n.code} />
                </TableCell>
              ) : null}
              {showHolder ? (
                <TableCell className="max-w-64">
                  {n.holder?.href ? (
                    <Link href={n.holder.href} prefetch={false} className="text-primary underline-offset-4 hover:underline">
                      {n.holder.name}
                    </Link>
                  ) : (
                    <span>{n.holder?.name}</span>
                  )}
                </TableCell>
              ) : null}
              <TableCell className="whitespace-nowrap">{n.form}</TableCell>
              <TableCell className="text-right tabular-nums">{n.votingPower}</TableCell>
              <TableCell className="text-right tabular-nums">{n.change}</TableCell>
              <TableCell>
                <AsxLink url={n.url} label={`Notice for ${n.code}, released ${n.released}, on ASX`} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {bounded ? (
        <ShowAll served={rows.length} onRecord={onRecord} expanded={expanded} controls={bodyId} onToggle={toggle} />
      ) : null}
    </>
  );
}
