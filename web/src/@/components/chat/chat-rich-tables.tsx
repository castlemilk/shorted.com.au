"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
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
  formatDayMonth,
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

// The tables are drawn in the chat's sidebar, about 330px wide on a phone and on a
// desktop alike. The key figures come first and sit inside that width. The rest
// scrolls sideways, and the table says so with a fade on its right edge.

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
  {
    id: "code",
    header: "Stock",
    rowHeader: true,
    cell: (row) => (
      <StockCell code={row.code} name={row.name} rank={row.rank} />
    ),
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
    header: "Change",
    numeric: true,
    cell: (row) => changeCell(row.points),
  },
  {
    id: "trend",
    header: "Trend",
    cell: (row) =>
      row.points.length >= 2 ? (
        <ChatSparkline
          label={`${row.code} short interest`}
          seriesLabel={row.code}
          points={row.points}
          color={seriesColor("short")}
        />
      ) : (
        <Dash />
      ),
  },
];

/**
 * How far the short position moved across the sparkline's readings, in points, and
 * the day the first of them is dated. Those readings can cover less than the three
 * months the answer is about, so the day is shown rather than a period name. A rise
 * in short interest is red and a fall green: the site's convention for short
 * interest. The sign is in the text too, so the colour is never the only cue.
 */
function changeCell(points: Reading[]): ReactNode {
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length < 2 || !first || !last) return <Dash />;
  const delta = last.v - first.v;
  return (
    <span className="block">
      <span
        className={cn(
          "font-medium",
          delta > 0 && "text-red-700 dark:text-red-400",
          delta < 0 && "text-emerald-700 dark:text-emerald-400",
          delta === 0 && "text-muted-foreground",
        )}
      >
        {formatPointsChange(delta)}
      </span>
      <span className="block text-[10px] font-normal text-muted-foreground">
        since {formatDayMonth(first.t)}
      </span>
    </span>
  );
}

/** "Peer comparison" from get_peer_comparison. The stock it compares is the first row. */
export function PeersTable({ view }: { view: PeersView }) {
  const subject = view.subjectCode ?? "this stock";
  const industry = industryLabel(view.industry);
  if (view.rows.length === 0) {
    return <EmptyNote>No peers to compare with {subject}.</EmptyNote>;
  }
  const rows = view.subject ? [view.subject, ...view.rows] : view.rows;
  return (
    <ChatDataTable
      caption={
        industry ? `Peers of ${subject} in ${industry}` : `Peers of ${subject}`
      }
      columns={peerColumns(view.subjectCode)}
      rows={rows}
      rowKey={(row) => row.code}
      rowClassName={(row) =>
        row.code === view.subjectCode ? "bg-muted/50" : undefined
      }
    />
  );
}

/** The peer columns. The subject's row is marked, so a reader knows which row it is. */
function peerColumns(subjectCode?: string): readonly ChatDataTableColumn<PeerRow>[] {
  return [
    {
      id: "code",
      header: "Stock",
      rowHeader: true,
      cell: (row) => (
        <StockCell
          code={row.code}
          name={row.name}
          badge={row.code === subjectCode ? "This stock" : undefined}
        />
      ),
    },
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
}

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
        {view.notShown > 0
          ? `${formatWhole(view.notShown)} director trades were reported but cannot be shown.`
          : `No director trades reported${code ? ` for ${code}` : ""}.`}
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
    id: "director",
    header: "Director",
    rowHeader: true,
    cell: (row) => <DirectorCell row={row} />,
  },
  {
    id: "shares",
    header: "Shares",
    numeric: true,
    cell: (row) => (row.shares === undefined ? <Dash /> : formatWhole(row.shares)),
  },
  {
    id: "value",
    header: "Value",
    numeric: true,
    cell: (row) =>
      row.totalValue === undefined ? <Dash /> : formatDollars(row.totalValue),
  },
  {
    id: "price",
    header: "Price",
    numeric: true,
    cell: (row) =>
      row.pricePerShare === undefined ? <Dash /> : formatPrice(row.pricePerShare),
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

/**
 * A trade's director, with its date and type beneath: the three read together in
 * a narrow column, so the figures can sit beside them.
 */
function DirectorCell({ row }: { row: DirectorTradeRow }) {
  const detail = [
    row.tradeDate ? formatTradeDate(row.tradeDate) : undefined,
    tradeTypeLabel(row.tradeType),
  ]
    .filter(Boolean)
    .join(" · ");
  // The cell is capped in width, so a long trade type ("Option exercise") wraps under the
  // date instead of pushing the figures off the sidebar's width.
  return (
    <span className="block max-w-[7.5rem]">
      <span className="block truncate" title={row.director}>
        {row.director}
      </span>
      <span className="block text-[11px] font-normal text-muted-foreground">
        {detail}
      </span>
    </span>
  );
}

/**
 * A stock's code, linked to its page, with its company name beneath. A rank in front of
 * the code keeps the answer's order. A badge names the stock a comparison is about.
 */
function StockCell({
  code,
  name,
  rank,
  badge,
}: {
  code: string;
  name?: string;
  rank?: number;
  badge?: string;
}) {
  return (
    <span className="block min-w-0">
      <span className="flex items-baseline gap-1.5">
        {rank !== undefined && (
          <span className="tabular-nums font-normal text-muted-foreground">
            {rank}
          </span>
        )}
        <StockCodeLink code={code} />
        {badge && (
          <span className="rounded-sm bg-muted px-1 text-[10px] font-medium text-muted-foreground">
            {badge}
          </span>
        )}
      </span>
      {name && (
        <span
          className="block max-w-[7rem] truncate text-[11px] font-normal text-muted-foreground"
          title={name}
        >
          {name}
        </span>
      )}
    </span>
  );
}

/**
 * A link to a stock page, client-side, so the chat sidebar (in the root layout) stays
 * open and a reply still streaming keeps streaming. The code is validated by the
 * parser, so it is safe in a path.
 */
function StockCodeLink({ code }: { code: string }) {
  return (
    <Link
      href={`/shorts/${encodeURIComponent(code)}`}
      prefetch={false}
      className="rounded-sm font-mono text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {code}
    </Link>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
