import { ExternalLink, Users } from "lucide-react";
import type { DirectorTrade } from "~/gen/shorts/v1alpha1/stock_pb";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { Badge } from "~/@/components/ui/badge";
import { safeExternalHref } from "~/@/lib/safe-external-href";

/**
 * How many trades the Company tab lists. The page's server read and the client
 * island's default are this one number, so either path shows the same rows.
 */
export const DIRECTOR_TRADES_LIMIT = 20;

const tradeTypeStyles: Record<string, string> = {
  buy: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400",
  sell: "bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-400",
  exercise_options: "bg-stone-500/15 text-stone-700 dark:text-stone-300",
};

// A fixed locale, as formatAsOfDate pins en-AU: this renders on the server now,
// and the HTML is cached for everyone, so it cannot depend on the host's.
const NUMBER_LOCALE = "en-AU";

interface DirectorTradesViewProps {
  trades: readonly DirectorTrade[];
  totalCount: number;
}

/**
 * The director trades card once its trades are known: the table, or the "No
 * director trades found" card when there are none.
 *
 * Its own file, with no "use client", no Connect import and only type imports
 * from the generated code, on purpose. The Company page reads the trades on the
 * server and draws this from them, so the card is in the HTML at the size it
 * keeps. Drawn in the browser behind a 322px skeleton, a stock with no trades
 * opened a tall card and then collapsed it to about 92px, moving every card
 * beneath it up by 230px (a first-load layout shift of 0.164 on desktop and
 * 0.215 on a phone, measured on a local production build). The
 * DirectorTradesTable island, which the page falls back to only when its own
 * read fails, draws this for its loaded and empty states too, so the markup
 * lives once.
 */
export function DirectorTradesView({
  trades,
  totalCount,
}: DirectorTradesViewProps) {
  if (trades.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-5 w-5" />
            Director trades
          </CardTitle>
          <CardDescription>No director trades found</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Users className="h-5 w-5" />
          Director trades
        </CardTitle>
        <CardDescription>
          {totalCount} trade{totalCount !== 1 ? "s" : ""} recorded
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Director</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Shares</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trades.map((trade) => (
              <TableRow key={trade.id}>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {trade.tradeDate}
                </TableCell>
                <TableCell className="font-medium text-sm">
                  {trade.directorName}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={`text-xs border-0 ${tradeTypeStyles[trade.tradeType] ?? ""}`}
                  >
                    {trade.tradeType.replace(/_/g, " ")}
                  </Badge>
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {trade.sharesTraded
                    ? Number(trade.sharesTraded).toLocaleString(NUMBER_LOCALE)
                    : "-"}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {trade.pricePerShare
                    ? `$${trade.pricePerShare.toFixed(3)}`
                    : "-"}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {trade.totalValue
                    ? `$${Number(trade.totalValue).toLocaleString(NUMBER_LOCALE)}`
                    : "-"}
                </TableCell>
                <TableCell>
                  {safeExternalHref(trade.announcementUrl) && (
                    <a
                      href={safeExternalHref(trade.announcementUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-primary"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
