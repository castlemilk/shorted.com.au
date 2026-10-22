import Link from "next/link";
import { ExternalLink, Landmark } from "lucide-react";
import type { GetStockOwnershipResponse } from "~/gen/shorts/v1alpha1/ownership_pb";
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
import { formatAmount, formatPct } from "~/@/lib/fundamentals/format";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import {
  formLabel,
  formatFundWeight,
  formatPointChange,
  formatVotingPower,
  fundLabel,
} from "~/@/lib/ownership/kinds";
import { HolderName, KindBadge, KindBar, formatSum } from "./ownership-parts";

/** Fund holdings the card lists: the largest by value. */
export const STOCK_FUND_HOLDINGS_SHOWN = 8;

/**
 * Who holds one stock, for the Company tab: its substantial holders as their
 * latest notices state them, and the index ETFs and super fund options that
 * hold it. A server component (the page reads the data and draws this), so
 * the card is in the HTML at the size it keeps.
 */
export function StockOwnershipView({ data }: { data: GetStockOwnershipResponse }) {
  const summary = data.summary;
  const funds = data.fundHoldings.slice(0, STOCK_FUND_HOLDINGS_SHOWN);
  const etfUnits = data.fundHoldings.filter((f) => f.sourceKind === "etf").length;
  const superOptions = data.fundHoldings.filter((f) => f.sourceKind === "super_phd").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Landmark className="h-5 w-5" aria-hidden />
          Who owns it
        </CardTitle>
        <CardDescription>
          {data.holders.length > 0
            ? `${data.holders.length} substantial holder${data.holders.length === 1 ? "" : "s"} disclosing ${formatSum(summary?.disclosedPct)}`
            : "No current substantial holder notices on record"}
          {etfUnits + superOptions > 0
            ? `; held by ${etfUnits} index ETF${etfUnits === 1 ? "" : "s"} and ${superOptions} super fund option${superOptions === 1 ? "" : "s"} tracked`
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {summary && summary.byKind.length > 0 ? <KindBar byKind={summary.byKind} /> : null}

        {data.holders.length > 0 ? (
          <Table>
            <caption className="sr-only">Substantial holders of {summary?.stockCode}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Holder</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Voting power</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead>As at</TableHead>
                <TableHead>
                  <span className="sr-only">Notice</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.holders.map((h) => (
                <TableRow key={h.holderKey}>
                  <TableCell className="max-w-64">
                    <HolderName name={h.holderName} slug={h.institutionSlug} holderKey={h.holderKey} />
                  </TableCell>
                  <TableCell>
                    <KindBadge kind={h.kind} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatVotingPower(h.votingPowerPct)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {h.hasPrevious ? formatPointChange(h.previousPct, h.votingPowerPct) : formLabel(h.form, false)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{h.eventDate || h.announcedOn}</TableCell>
                  <TableCell>
                    {safeExternalHref(h.announcementUrl) ? (
                      <a
                        href={safeExternalHref(h.announcementUrl)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hit-target inline-flex text-muted-foreground hover:text-primary"
                        aria-label={`${h.holderName || "Holder"}'s notice on ASX`}
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden />
                      </a>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        {funds.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">
              Index funds and super funds
              {summary?.hasIndexPct ? (
                <span className="ml-2 font-normal text-muted-foreground">
                  index funds tracked hold {formatPct(summary.indexPct, { digits: 2 })} of shares on issue
                </span>
              ) : null}
            </h4>
            <Table>
              <caption className="sr-only">Funds holding {summary?.stockCode}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Fund</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">Of shares</TableHead>
                  <TableHead className="text-right">Of fund</TableHead>
                  <TableHead>As at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {funds.map((f) => (
                  <TableRow key={`${f.institutionSlug}|${f.fundName}`}>
                    <TableCell className="max-w-64">
                      <HolderName name={f.institutionName} slug={f.institutionSlug} />
                      <span className="block truncate text-xs text-muted-foreground">
                        {fundLabel(f.fundCode, f.fundName)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.hasValue ? formatAmount(f.valueAud, "AUD") : "n/a"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.hasPctOfIssued ? formatPct(f.pctOfIssued, { digits: 2 }) : "n/a"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatFundWeight(f.weightPct, f.hasWeight, f.hasValue ? f.valueAud : null)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{f.asAt}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          From ASX substantial holding notices (5% or more), index ETF holdings files and super fund portfolio
          holdings disclosures. Holders&apos; interests can overlap.{" "}
          <Link href="/ownership" prefetch={false} className="text-primary underline-offset-4 hover:underline">
            How ownership is read
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
