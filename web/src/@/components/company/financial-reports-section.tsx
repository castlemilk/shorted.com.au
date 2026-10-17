import { Suspense } from "react";
import { getEnrichedCompanyMetadata } from "~/app/actions/company-metadata";
import { FILINGS_LISTED_BELOW } from "~/@/components/stocks/financials-tab";
import { Card, CardContent, CardHeader } from "~/@/components/ui/card";
import { Skeleton } from "~/@/components/ui/skeleton";
import type { FinancialReport } from "~/@/types/company-metadata";
import { FinancialReports, hasListedReports } from "./financial-reports";

// The company's filings on the stock page's Financials tab, streamed.
//
// The list comes from getStockDetails (through getEnrichedCompanyMetadata),
// which retries three times with backoff and has no request timeout. Awaiting
// it in the page body held the whole page's first byte for that budget on a
// cache miss, for a list that sits at the bottom of an inactive tab. These
// async server components read it under their own Suspense boundaries
// instead, as the page's FinancialReportsSection used to. They take
// serializable props only (the code and a URL string), and a failed read
// renders nothing: never an error, never a claim that no filings exist.

/** The filings, or [] when the details read failed or has none. */
async function readReports(stockCode: string): Promise<FinancialReport[]> {
  try {
    const enriched = await getEnrichedCompanyMetadata(stockCode);
    return enriched?.financial_reports ?? [];
  } catch {
    return [];
  }
}

export interface FinancialReportsSectionProps {
  stockCode: string;
  /** The Latest result's source_document_url; "" when not filing-sourced. */
  sourceDocumentUrl: string;
}

/** The filings list once the details read resolves (exported for tests). */
export async function FinancialReportsData({
  stockCode,
  sourceDocumentUrl,
}: FinancialReportsSectionProps) {
  const reports = await readReports(stockCode);
  return (
    <FinancialReports
      reports={reports}
      stockCode={stockCode}
      sourceDocumentUrl={sourceDocumentUrl}
    />
  );
}

function FinancialReportsFallback() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="pb-3">
        <Skeleton className="h-6 w-40" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

/** The Financials tab's reports slot: the filings list, streamed. */
export function FinancialReportsSection({
  stockCode,
  sourceDocumentUrl,
}: FinancialReportsSectionProps) {
  return (
    <Suspense fallback={<FinancialReportsFallback />}>
      <FinancialReportsData
        stockCode={stockCode}
        sourceDocumentUrl={sourceDocumentUrl}
      />
    </Suspense>
  );
}

/**
 * The empty state's closing sentence, only when the filings list below will
 * show at least one filing (exported for tests). The same React-cached read
 * as the list, so no second request.
 */
export async function FilingsListedNoteData({
  stockCode,
}: {
  stockCode: string;
}) {
  const reports = await readReports(stockCode);
  return hasListedReports(reports) ? <>{FILINGS_LISTED_BELOW}</> : null;
}

/** The Financials tab's filingsNote slot, streamed; nothing until it resolves. */
export function FilingsListedNote({ stockCode }: { stockCode: string }) {
  return (
    <Suspense fallback={null}>
      <FilingsListedNoteData stockCode={stockCode} />
    </Suspense>
  );
}
