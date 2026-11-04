import Link from "next/link";
import { NOT_AVAILABLE, formatAmount } from "~/@/lib/fundamentals/format";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { StockLogoBox } from "../workspace/stock-logo-box";
import { SectorIcon } from "../workspace/sector-icon";
import { formatEstCompany, formatUnits, formatWeight, type PortfolioHolding } from "./fund-model";
import { FigureList } from "./row-disclosure";
import { EXPANDER_HEADER, ExpandableRow } from "./expandable-row";

export interface FundHoldingsListProps {
  holdings: readonly PortfolioHolding[];
  /** The link a holding's code follows: the selection of that holding, keeping the page's view. */
  hrefFor: (code: string) => string;
  /** The holding the selection names on this fund, if any. */
  selectedCode?: string | null;
}

/** The holdings, largest weight first; a holding with no stated weight goes last, by code. */
export function sortedHoldings(holdings: readonly PortfolioHolding[]): PortfolioHolding[] {
  return [...holdings].sort((a, b) => {
    const wa = a.weightPct ?? -1;
    const wb = b.weightPct ?? -1;
    if (wa !== wb) return wb - wa;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}

/**
 * The holdings of one fund file as a table (spec 14.3, Holdings view): logo and code,
 * company, sector, weight, value, the reported shares and the estimated share of the
 * company. Every numeral is tabular and a figure not stated reads n/a.
 */
export function FundHoldingsList({ holdings, hrefFor, selectedCode = null }: FundHoldingsListProps) {
  const rows = sortedHoldings(holdings);
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[44rem] border-collapse font-mono text-sm">
        <caption className="sr-only">Holdings in this file, largest weight first</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="w-8 px-1 py-2 font-normal"><span className="sr-only">{EXPANDER_HEADER}</span></th>
            <th scope="col" className="px-2 py-2 font-normal">Code</th>
            <th scope="col" className="px-2 py-2 font-normal">Company</th>
            <th scope="col" className="px-2 py-2 font-normal">Sector</th>
            <th scope="col" className="px-2 py-2 text-right font-normal">Weight</th>
            <th scope="col" className="px-2 py-2 text-right font-normal">Value (AUD)</th>
            <th scope="col" className="px-2 py-2 text-right font-normal">Reported shares</th>
            <th scope="col" className="px-2 py-2 text-right font-normal">Est. company shares</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((holding) => {
            const current = holding.code === selectedCode;
            return (
              <ExpandableRow
                key={holding.code}
                id={`holding-${holding.code}`}
                label={`${holding.code} details`}
                colSpan={8}
                current={current}
                className={current ? "bg-muted/40" : undefined}
                detail={
                  <FigureList
                    rows={[
                      { label: "Value (AUD)", value: formatAmount(holding.valueAud, "AUD") },
                      { label: "Reported shares", value: formatUnits(holding.units) },
                      { label: "Shares-on-issue basis", value: holding.sharesOnIssueAsAt || NOT_AVAILABLE },
                    ]}
                  />
                }
              >
                <td className="px-2 py-2">
                  <span className="flex items-center gap-2">
                    <StockLogoBox code={holding.code} size={20} />
                    <Link href={hrefFor(holding.code)} scroll={false} prefetch={false} className="font-semibold underline-offset-4 hover:underline">
                      {holding.code}
                    </Link>
                  </span>
                </td>
                <td className="max-w-[16rem] truncate px-2 py-2">{holding.name}</td>
                <td className="px-2 py-2">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <SectorIcon industry={holding.industry} size={14} />
                    <span className="truncate">{industryLabel(holding.industry) || NOT_AVAILABLE}</span>
                  </span>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{formatWeight(holding.weightPct, 2)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatAmount(holding.valueAud, "AUD")}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatUnits(holding.units)}</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatEstCompany(holding.estCompanyPct)}</td>
              </ExpandableRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
