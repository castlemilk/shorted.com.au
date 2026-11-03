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
import { formatPct } from "~/@/lib/fundamentals/format";
import { ageLabel } from "~/@/lib/ownership/age";
import {
  asAtRange,
  formLabel,
  formatPointChange,
  formatVotingPower,
  registerHref,
} from "~/@/lib/ownership/kinds";
import { REPORT_ERROR_EMAIL } from "~/@/lib/report-error";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { DisclosedBar } from "./disclosed-bar";
import { KindBadge } from "./kind-badge";
import { HolderName, formatSum } from "./ownership-parts";
import { Dated } from "./ownership-provenance";
import { StockFundTable } from "./stock-fund-table";

/** Fund holdings the card lists: the largest by value. */
export const STOCK_FUND_HOLDINGS_SHOWN = 8;

// The card's copy. Its figures come from the stock's own register, so the
// words say what the notices state and what the files hold, never a share.
const TITLE = "Substantial holders";
const BAR_CAPTION =
  "What the notices disclose, each interest counted once; not a share of the company.";
const POOLED_NOTE = "(Vanguard's files are the pooled fund's)";
const FUNDS_HEADING = "Index funds and super options";
const FOOTER =
  "From ASX substantial holding notices (5% or more), index fund holdings files and super fund portfolio holdings disclosures (one option each). Holders' interests can overlap, so the sum is what the notices disclose.";

/** A count with its noun, singular for one: "1 holder", "2 holders". */
function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-AU")} ${n === 1 ? one : many}`;
}

/**
 * Who holds one stock, for the Company tab: its substantial holders as their
 * latest notices state them, and the index fund files and super fund options
 * that hold it. A server component (the page reads the data and draws this), so
 * the card is in the HTML at the size it keeps.
 */
export function StockOwnershipView({ data }: { data: GetStockOwnershipResponse }) {
  const summary = data.summary;
  const code = summary?.stockCode ?? "";
  const holders = data.holders.length;
  const indexFunds = data.fundHoldings.filter((f) => f.sourceKind === "etf").length;
  const superOptions = data.fundHoldings.filter((f) => f.sourceKind === "super_phd").length;
  // An interest is a holding counted once after the overlap rule, and the
  // stock's kinds carry those counts. Without a summary the holder count stands in.
  const interests = summary ? summary.byKind.reduce((n, k) => n + k.holders, 0) : holders;
  const heldBy =
    indexFunds + superOptions > 0
      ? `; held by ${countOf(indexFunds, "index fund")} and ${countOf(superOptions, "super option")} tracked`
      : "";
  const description =
    holders > 0
      ? `${countOf(holders, "holder")}, ${countOf(interests, "interest")} counted once, disclose ${formatSum(summary?.disclosedPct)} between them${heldBy}${heldBy ? ` ${POOLED_NOTE}` : ""}`
      : `No current substantial holder read for this stock${heldBy}`;
  const withheld = data.withheldListed;
  const reportSubject = `Ownership data: ${code} register`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Landmark className="h-5 w-5" aria-hidden />
          {TITLE}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* With no sum there is no bar, and its caption would sit under nothing. */}
        {summary && summary.byKind.length > 0 && summary.disclosedPct > 0 ? (
          <DisclosedBar
            segments={summary.byKind}
            total={summary.disclosedPct}
            scaleMax={summary.disclosedPct}
            caption={BAR_CAPTION}
          />
        ) : null}

        {holders > 0 ? (
          <Table>
            <caption className="sr-only">Substantial holders of {code}</caption>
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
              {data.holders.map((h) => {
                const asAt = h.eventDate || h.announcedOn;
                const age = ageLabel(asAt, data.asOf);
                return (
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
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {asAt}
                      {age ? <span className="block text-xs text-muted-foreground">{age}</span> : null}
                    </TableCell>
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
                );
              })}
            </TableBody>
          </Table>
        ) : null}

        {summary && data.fundHoldings.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">
              {FUNDS_HEADING}
              {summary.hasIndexPct ? (
                <span className="ml-2 font-normal text-muted-foreground">
                  <Dated
                    text={`index funds tracked hold ${formatPct(summary.indexPct, { digits: 2 })} of shares on issue${
                      // A file date the API does not hold is left out, never "as at n/a".
                      summary.indexAsAtFrom || summary.indexAsAtTo
                        ? ` (files ${asAtRange(summary.indexAsAtFrom, summary.indexAsAtTo)})`
                        : ""
                    }`}
                  />
                </span>
              ) : null}
            </h4>
            <StockFundTable rows={data.fundHoldings} code={summary.stockCode} limit={STOCK_FUND_HOLDINGS_SHOWN} />
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          {FOOTER}
          {withheld > 0
            ? ` ${countOf(withheld, "notice")} listed under ${code} ${withheld === 1 ? "was" : "were"} withheld.`
            : null}
          {" · "}
          <Link href="/ownership#method" prefetch={false} className="text-primary underline-offset-4 hover:underline">
            How ownership is read →
          </Link>
          {" · "}
          <Link
            href={registerHref(code)}
            prefetch={false}
            className="text-primary underline-offset-4 hover:underline"
          >
            Full register →
          </Link>
          {" · "}
          <Link href="/disclaimer" prefetch={false} className="text-primary underline-offset-4 hover:underline">
            Not financial advice
          </Link>
          {" · "}
          <a
            href={`mailto:${REPORT_ERROR_EMAIL}?subject=${encodeURIComponent(reportSubject)}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            Report an error
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
