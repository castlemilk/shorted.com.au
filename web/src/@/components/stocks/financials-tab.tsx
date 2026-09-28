import type { ReactNode } from "react";
import { Table2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { formatAsOf } from "~/@/lib/fundamentals/format";
import type { StockFundamentals } from "~/app/actions/getStockFundamentals";
import { FinancialStatements } from "./financial-statements";
import {
  fundamentalsEmptyKind,
  type FundamentalsEmptyKind,
} from "./fundamentals-model";
import { KeyRatiosCard } from "./key-ratios-card";
import { LatestResultCard } from "./latest-result-card";
import { shapeStatements } from "./statements-shape";

// The stock page's Financials tab (docs/plans/fundamentals-coverage.md §7.1):
// a composition of props-only server cards plus ONE client island (the
// statements). Order: Latest result, Key ratios, Financial statements, then
// the reports list and the tax card, which arrive as ReactNode slots from the
// page (the tax card last).
//
// A null `fundamentals` (the API failed) renders nothing extra. The empty
// state shows ONLY when nothing is held AND the collector has a definite
// answer; its copy never states or implies that a listed company publishes
// no statements.

/** The empty-state sentence for a stock, or null when none applies. */
export function emptyStateCopy(
  kind: FundamentalsEmptyKind,
  code: string,
  lastAttemptAt: string,
  hasFilings: boolean,
): string {
  const date = formatAsOf(lastAttemptAt);
  switch (kind) {
    case "empty":
      return `Our data providers hold no financial statements for ${code}${
        date ? ` (last checked ${date})` : ""
      }.${hasFilings ? " The company's own filings are listed below." : ""}`;
    case "pending":
      return `Fundamentals not yet collected for ${code}.`;
    case "failed":
      return `Fundamentals for ${code} could not be collected${
        date ? ` on ${date}` : ""
      }; the next run retries.`;
  }
}

function FundamentalsEmptyState({ message }: { message: string }) {
  return (
    <Card role="region" aria-labelledby="fundamentals-empty-heading">
      <CardHeader className="pb-3">
        <CardTitle
          id="fundamentals-empty-heading"
          className="flex items-center gap-2 text-lg"
        >
          <Table2 className="h-5 w-5" aria-hidden />
          Fundamentals
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

export interface FinancialsTabProps {
  stockCode: string;
  /** Null when the API is unavailable: the tab then renders its slots only. */
  fundamentals: StockFundamentals | null;
  /** The company's filings (FinancialReports), rendered after the statements. */
  reports?: ReactNode;
  /** The ATO tax card, rendered last. */
  taxCard?: ReactNode;
  /** The reports slot lists at least one filing. */
  hasFilings?: boolean;
}

export function FinancialsTab({
  stockCode,
  fundamentals,
  reports,
  taxCard,
  hasFilings = false,
}: FinancialsTabProps) {
  const emptyKind = fundamentalsEmptyKind(fundamentals);
  const statements = fundamentals ? shapeStatements(fundamentals) : null;
  const basisPeriod =
    fundamentals?.quality
      ? (fundamentals.periods.find(
          (p) =>
            p.periodType === fundamentals.quality!.basisPeriodType &&
            p.periodEnd === fundamentals.quality!.basisPeriodEnd,
        ) ?? null)
      : null;

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      {emptyKind && fundamentals ? (
        <FundamentalsEmptyState
          message={emptyStateCopy(
            emptyKind,
            stockCode,
            fundamentals.coverage.lastAttemptAt,
            hasFilings,
          )}
        />
      ) : null}
      {fundamentals ? <LatestResultCard fundamentals={fundamentals} /> : null}
      {fundamentals?.quality ? (
        <KeyRatiosCard quality={fundamentals.quality} basisPeriod={basisPeriod} />
      ) : null}
      {statements ? <FinancialStatements {...statements} /> : null}
      {reports}
      {taxCard}
    </div>
  );
}
