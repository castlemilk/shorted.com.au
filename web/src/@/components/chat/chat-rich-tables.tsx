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
import { tierAtLeast, type TableTier } from "./chat-layout";
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
  formatCompactDollars,
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

// The sparkline is a chart, so it is loaded on first use and never in the eager chat
// bundle. Its placeholder keeps the cell's size, so the row does not jump. The placeholder is
// the standard tier's 64px, the widest a sparkline is drawn beside the sidebar's figures.
const ChatSparkline = dynamic(
  () => import("./chat-charts").then((m) => m.ChatSparkline),
  {
    ssr: false,
    loading: () => (
      <span
        aria-hidden="true"
        className="inline-block h-7 w-16 motion-safe:animate-pulse rounded bg-muted/40"
      />
    ),
  },
);

// The tables are drawn in the chat's sidebar (about 276px on a desktop, 223 to 270px on a
// phone) and on the /chat page (about 620 to 720px). Each column says the narrowest tier it
// is drawn at (`minTier`). At the narrowest tier the figures a reader needs come first and
// sit inside the sidebar's width; a wider table adds the rest, so nothing is cut off or
// scrolled out of sight at the sidebar's width. See chat-layout.ts for the widths and tiers.

/** A sparkline's width: a full table draws the 96px line, a standard table a 64px one. */
function sparkWidth(tier: TableTier): number {
  return tier === "full" ? 96 : 64;
}

/** "Most shorted" from get_top_shorts. */
export function TopShortsTable({ view }: { view: TopShortsView }) {
  if (view.rows.length === 0 && view.notShown === 0) {
    return <EmptyNote>No stocks to show.</EmptyNote>;
  }
  // The budget keeps the sparklines of the highest rows and clears the rest, so their change
  // and trend are blank. The footnote says which rows have them, rather than leaving a dash.
  // It names only the columns the table draws: the trend is not drawn below the standard tier.
  const withReadings = view.rows.filter((row) => row.points.length >= 2).length;
  const footnote = (tier: TableTier) => {
    if (withReadings >= view.rows.length) return undefined;
    const names = tierAtLeast(tier, "standard") ? "Change and trend" : "Change";
    const verb = names === "Change" ? "is" : "are";
    return withReadings === 0
      ? `${names} ${verb} not shown for these stocks.`
      : `${names} ${verb} shown for the top ${formatWhole(withReadings)} only.`;
  };
  return (
    <ChatDataTable
      caption="Most shorted ASX stocks"
      columns={TOP_SHORT_COLUMNS}
      rows={view.rows}
      rowKey={(row) => `${row.rank}-${row.code}`}
      notShown={view.notShown}
      footnote={footnote}
    />
  );
}

const TOP_SHORT_COLUMNS: readonly ChatDataTableColumn<TopShortRow>[] = [
  {
    id: "code",
    header: "Stock",
    rowHeader: true,
    // The name is the one text here that can be long, so the stock takes the room the other
    // columns leave, and its name is cut only where it does not fit.
    fill: true,
    cell: (row, tier) => (
      <StockCell code={row.code} name={row.name} rank={row.rank} tier={tier} fill />
    ),
  },
  {
    id: "short",
    header: "Short",
    numeric: true,
    cell: (row) =>
      row.latest === undefined ? (
        <Dash />
      ) : (
        <span className="whitespace-nowrap">{formatPercent(row.latest)}</span>
      ),
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
    // The trend is the widest column. The sidebar's table has no room for it beside the
    // figures, so it is drawn from the standard tier up.
    minTier: "standard",
    cell: (row, tier) =>
      row.points.length >= 2 ? (
        <ChatSparkline
          label={`${row.code} short interest`}
          seriesLabel={row.code}
          points={row.points}
          color={seriesColor("short")}
          width={sparkWidth(tier)}
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
  // The colour follows the figure as it is shown. A move under half a hundredth of a
  // point prints as "0.00 pp", and that reads as no change, not as a rise or a fall.
  const shown = Number(delta.toFixed(2));
  // A figure and its date each stay on one line. A wrapped "+2.82 / pp" makes the column four
  // lines tall, and the name, not the figures, is the text that gives way.
  return (
    <span className="block whitespace-nowrap">
      <span
        className={cn(
          "font-medium",
          shown > 0 && "text-red-700 dark:text-red-400",
          shown < 0 && "text-emerald-700 dark:text-emerald-400",
          shown === 0 && "text-muted-foreground",
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
        row.code === view.subjectCode ? SUBJECT_ROW : undefined
      }
    />
  );
}

/**
 * The subject's row at every width. The tint is faint against the background (its contrast
 * is near 1:1), so the row also has a primary bar on its first cell and a bold code (the
 * StockCodeLink inherits the weight). The compact table has no room for the "This stock"
 * badge, so a screen reader hears it and the sighted reader sees the bar.
 */
const SUBJECT_ROW =
  "bg-primary/10 font-semibold [&>th:first-child]:shadow-[inset_3px_0_0_0_hsl(var(--primary))]";

/** The peer columns. The subject's row is marked, so a reader knows which row it is. */
function peerColumns(subjectCode?: string): readonly ChatDataTableColumn<PeerRow>[] {
  return [
    {
      id: "code",
      header: "Stock",
      rowHeader: true,
      cell: (row, tier) => (
        <StockCell
          code={row.code}
          name={row.name}
          badge={row.code === subjectCode ? "This stock" : undefined}
          tier={tier}
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
      compactHeader: "Mkt cap",
      numeric: true,
      cell: (row) =>
        row.marketCap === undefined ? <Dash /> : formatMarketCap(row.marketCap),
    },
    {
      id: "pe",
      header: "P/E",
      numeric: true,
      minTier: "standard",
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
      minTier: "full",
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
      minTier: "full",
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
  // A budget that left out every trade still leaves a count. The table says so in its
  // footer rather than in place of a table, as the chat's prompt describes it.
  if (view.trades.length === 0 && view.notShown === 0) {
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
    id: "director",
    header: "Director",
    rowHeader: true,
    // The name identifies the row, so it takes the room the figures leave.
    fill: true,
    cell: (row, tier) => <DirectorCell row={row} tier={tier} />,
  },
  {
    id: "shares",
    header: "Shares",
    numeric: true,
    minTier: "standard",
    cell: (row) => (row.shares === undefined ? <Dash /> : formatWhole(row.shares)),
  },
  {
    id: "value",
    header: "Value",
    numeric: true,
    // Below the full tier a value is abbreviated ($1.2M), which keeps the sidebar's width.
    cell: (row, tier) => {
      if (row.totalValue !== undefined) {
        return tier === "full"
          ? formatDollars(row.totalValue)
          : formatCompactDollars(row.totalValue);
      }
      // The compact table has no Shares column, so a trade the feed priced with no value
      // shows its share count here rather than a dash.
      if (tier === "compact" && row.shares !== undefined) {
        return `${formatWhole(row.shares)} shares`;
      }
      return <Dash />;
    },
  },
  {
    id: "price",
    header: "Price",
    numeric: true,
    minTier: "full",
    cell: (row) =>
      row.pricePerShare === undefined ? <Dash /> : formatPrice(row.pricePerShare),
  },
  {
    id: "notice",
    header: "Notice",
    // Below the full tier the director's name is the notice's link (DirectorCell), so the
    // column is drawn only where there is room for it beside the rest.
    minTier: "full",
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
 * A trade's director, with its date and type beneath. The director's name is the first
 * line and takes the column's width, and truncates only when it does not fit. The date and
 * the type wrap onto as many lines as they need, so a type is never cut short ("Optio…").
 * Below the full tier the name is the notice's link, since the Notice column is not drawn
 * there; it keeps the same safe-URL check and the same "opens in a new tab" text.
 */
function DirectorCell({ row, tier }: { row: DirectorTradeRow; tier: TableTier }) {
  const date = row.tradeDate ? formatTradeDate(row.tradeDate) : undefined;
  const detail = date ? `${date} · ${tradeTypeLabel(row.tradeType)}` : tradeTypeLabel(row.tradeType);
  const href = tier === "full" ? undefined : safeExternalHref(row.announcementUrl);
  return (
    <span className="block max-w-full">
      <span className="block truncate" title={row.director}>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          >
            {row.director}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          row.director
        )}
      </span>
      <span
        className="block break-words text-[11px] font-normal text-muted-foreground"
        title={detail}
      >
        {detail}
      </span>
    </span>
  );
}

/**
 * The widest a company name is drawn, by tier, in a column that does not fill the table. A
 * longer name is truncated, with its full text in the title. A filling column takes no cap.
 */
const NAME_WIDTH: Readonly<Record<TableTier, string>> = {
  compact: "max-w-[4.25rem]",
  standard: "max-w-[5rem]",
  full: "max-w-[7rem]",
};

/**
 * A stock's code, linked to its page, with its company name beneath. A rank in front of
 * the code keeps the answer's order. A badge names the stock a comparison is about. In a
 * column that fills the table (`fill`) the name takes the room left over; elsewhere it is
 * capped by tier, so the code and the figures beside it keep their room.
 */
function StockCell({
  code,
  name,
  rank,
  badge,
  tier,
  fill = false,
}: {
  code: string;
  name?: string;
  rank?: number;
  badge?: string;
  tier: TableTier;
  fill?: boolean;
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
        {badge &&
          (tier === "compact" ? (
            // The compact table has no room for the badge beside the code. The row's bar and
            // bold code mark it, and a screen reader still hears which stock it is.
            <span className="sr-only">{badge}</span>
          ) : (
            <span className="rounded-sm bg-muted px-1 text-[10px] font-medium text-muted-foreground">
              {badge}
            </span>
          ))}
      </span>
      {name && (
        <span
          className={cn(
            "block truncate text-[11px] font-normal text-muted-foreground",
            !fill && NAME_WIDTH[tier],
          )}
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
