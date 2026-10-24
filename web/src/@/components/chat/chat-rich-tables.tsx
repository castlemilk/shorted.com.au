"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { seriesColor } from "~/@/components/charts/chart-theme";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { cn } from "~/@/lib/utils";
import {
  ChatDataTable,
  Dash,
  type ChatDataTableColumn,
} from "./chat-data-table";
import type {
  DirectorTradeRow,
  DirectorTradesView,
  PeerRow,
  PeersView,
  Reading,
  TopShortRow,
  TopShortsView,
} from "./chat-tool-data";
import {
  formatMarketCap,
  formatPercent,
  formatPointsChange,
  formatPrice,
  formatRatio,
  formatWhole,
  formatSignedPercent,
  formatTradeDate,
  formatDollars,
  tradeTypeLabel,
} from "./chat-tool-format";

// The sparkline is a chart, so it is loaded on first use and never in the eager
// chat bundle. Its placeholder keeps the cell's size, so the row does not jump.
const ChatSparkline = dynamic(
  () => import("./chat-charts").then((m) => m.ChatSparkline),
  {
    ssr: false,
    loading: () => (
      <span
        aria-hidden="true"
        className="inline-block h-7 w-24 motion-safe:animate-pulse rounded bg-muted/40"
      />
    ),
  },
);

/** "Most shorted" from get_top_shorts. */
export function TopShortsTable({ view }: { view: TopShortsView }) {
  if (view.rows.length === 0) {
    return <EmptyNote>No stocks to show.</EmptyNote>;
  }
  return (
    <ChatDataTable
      caption="Most shorted ASX stocks"
      columns={TOP_SHORT_COLUMNS}
      rows={view.rows}
      rowKey={(row) => `${row.rank}-${row.code}`}
      notShown={view.notShown}
    />
  );
}

const TOP_SHORT_COLUMNS: readonly ChatDataTableColumn<TopShortRow>[] = [
  { id: "rank", header: "Rank", numeric: true, cell: (row) => row.rank },
  {
    id: "code",
    header: "Code",
    rowHeader: true,
    cell: (row) => <StockCodeLink code={row.code} />,
  },
  {
    id: "name",
    header: "Company",
    cell: (row) => row.name ?? <Dash />,
  },
  {
    id: "short",
    header: "Short",
    numeric: true,
    cell: (row) =>
      row.latest === undefined ? <Dash /> : formatPercent(row.latest),
  },
  {
    id: "change",
    header: "3-month change",
    numeric: true,
    cell: (row) => changeCell(row.points),
  },
  {
    id: "trend",
    header: "Trend",
    cell: (row) =>
      row.points.length >= 2 ? (
        <ChatSparkline
          label={`${row.code} short interest, last three months`}
          points={row.points}
          color={seriesColor("short")}
        />
      ) : (
        <Dash />
      ),
  },
];

/**
 * How far the short position moved across the sparkline's window, in points. A
 * rise in short interest is red and a fall green: the site's convention for
 * short interest, the same as the short-interest table. The sign is in the text
 * too, so the colour is never the only cue.
 */
function changeCell(points: Reading[]): ReactNode {
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length < 2 || !first || !last) return <Dash />;
  const delta = last.v - first.v;
  return (
    <span
      className={cn(
        "font-medium",
        delta > 0 && "text-red-500",
        delta < 0 && "text-emerald-500",
        delta === 0 && "text-muted-foreground",
      )}
    >
      {formatPointsChange(delta)}
    </span>
  );
}

/** "Peer comparison" from get_peer_comparison. */
export function PeersTable({ view }: { view: PeersView }) {
  const subject = view.subjectCode ?? "this stock";
  const industry = industryLabel(view.industry);
  if (view.rows.length === 0) {
    return <EmptyNote>No peers to compare with {subject}.</EmptyNote>;
  }
  return (
    <ChatDataTable
      caption={
        industry ? `Peers of ${subject} in ${industry}` : `Peers of ${subject}`
      }
      columns={PEER_COLUMNS}
      rows={view.rows}
      rowKey={(row) => row.code}
    />
  );
}

const PEER_COLUMNS: readonly ChatDataTableColumn<PeerRow>[] = [
  {
    id: "code",
    header: "Code",
    rowHeader: true,
    cell: (row) => <StockCodeLink code={row.code} />,
  },
  { id: "name", header: "Company", cell: (row) => row.name ?? <Dash /> },
  {
    id: "short",
    header: "Short",
    numeric: true,
    cell: (row) =>
      row.shortPercent === undefined ? (
        <Dash />
      ) : (
        formatPercent(row.shortPercent)
      ),
  },
  {
    id: "marketCap",
    header: "Market cap",
    numeric: true,
    cell: (row) =>
      row.marketCap === undefined ? <Dash /> : formatMarketCap(row.marketCap),
  },
  {
    id: "pe",
    header: "P/E",
    numeric: true,
    // A negative or zero earnings base has no meaningful P/E: a dash, not a number.
    cell: (row) =>
      row.peRatio !== undefined && row.peRatio > 0 ? (
        formatRatio(row.peRatio)
      ) : (
        <Dash />
      ),
  },
  {
    id: "yield",
    header: "Yield",
    numeric: true,
    cell: (row) =>
      row.dividendYield === undefined || row.dividendYield < 0 ? (
        <Dash />
      ) : (
        formatPercent(row.dividendYield)
      ),
  },
  {
    id: "priceChange",
    header: "1-month price",
    numeric: true,
    cell: (row) =>
      row.priceChange1m === undefined ? (
        <Dash />
      ) : (
        formatSignedPercent(row.priceChange1m)
      ),
  },
];

/** "Director trades" from get_director_trades. `code` is the stock the tool was asked about. */
export function DirectorTradesTable({
  view,
  code,
}: {
  view: DirectorTradesView;
  code?: string;
}) {
  if (view.trades.length === 0) {
    return (
      <EmptyNote>
        No director trades reported{code ? ` for ${code}` : ""}.
      </EmptyNote>
    );
  }
  return (
    <ChatDataTable
      caption={code ? `Director trades in ${code}` : "Recent director trades"}
      columns={TRADE_COLUMNS}
      rows={view.trades}
      rowKey={(row) => row.id}
      notShown={view.notShown}
    />
  );
}

const TRADE_COLUMNS: readonly ChatDataTableColumn<DirectorTradeRow>[] = [
  {
    id: "date",
    header: "Date",
    cell: (row) =>
      row.tradeDate ? formatTradeDate(row.tradeDate) : <Dash />,
  },
  { id: "director", header: "Director", cell: (row) => row.director },
  {
    id: "type",
    header: "Type",
    cell: (row) => tradeTypeLabel(row.tradeType),
  },
  {
    id: "shares",
    header: "Shares",
    numeric: true,
    cell: (row) => (row.shares === undefined ? <Dash /> : formatWhole(row.shares)),
  },
  {
    id: "price",
    header: "Price",
    numeric: true,
    cell: (row) =>
      row.pricePerShare === undefined ? <Dash /> : formatPrice(row.pricePerShare),
  },
  {
    id: "value",
    header: "Value",
    numeric: true,
    cell: (row) =>
      row.totalValue === undefined ? <Dash /> : formatDollars(row.totalValue),
  },
  {
    id: "notice",
    header: "Notice",
    // The announcement link is data from the API: a link only when it is http(s).
    cell: (row) => {
      const href = safeExternalHref(row.announcementUrl);
      return href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          Notice
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <Dash />
      );
    },
  },
];

/** A link to a stock page. The code is validated by the parser, so it is safe in a path. */
function StockCodeLink({ code }: { code: string }) {
  return (
    <a
      href={`/shorts/${encodeURIComponent(code)}`}
      className="rounded-sm font-mono text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {code}
    </a>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
