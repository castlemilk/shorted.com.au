import { Suspense } from "react";
import { getEnrichedCompanyMetadata } from "~/app/actions/company-metadata";
import { CompanyInsightsCard } from "./company-insights-card";
import { FinancialReports } from "./financial-reports";
import { FinancialStatementsCard } from "./financial-statements-card";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Info } from "lucide-react";

interface EnrichedCompanySectionProps {
  stockCode: string;
}

async function EnrichedCompanyData({ stockCode }: EnrichedCompanySectionProps) {
  const enrichedData = await getEnrichedCompanyMetadata(stockCode);

  if (!enrichedData) {
    // Same title as the loaded state so the card doesn't rename itself;
    // standard card chrome (the border-l stripe grammar is reserved for
    // semantic hero cards).
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Info className="h-5 w-5" />
            Company
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The AI research profile for this company is still being generated.
            Check back soon for history, competitive advantages, risk factors,
            and key people.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <CompanyInsightsCard data={enrichedData} />;
}

function EnrichedCompanyFallback() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Overview tab: consolidated Company insights card (tags + accordion
 * sections + key people). Reports are NOT rendered here — they live on
 * the Financials tab via FinancialReportsSection, so the two tabs no
 * longer duplicate content.
 */
export function EnrichedCompanySection({
  stockCode,
}: EnrichedCompanySectionProps) {
  return (
    <Suspense fallback={<EnrichedCompanyFallback />}>
      <EnrichedCompanyData stockCode={stockCode} />
    </Suspense>
  );
}

async function FinancialReportsData({ stockCode }: { stockCode: string }) {
  const enrichedData = await getEnrichedCompanyMetadata(stockCode);

  if (!enrichedData?.financial_reports?.length) {
    return null;
  }

  return (
    <FinancialReports
      reports={enrichedData.financial_reports}
      stockCode={stockCode}
    />
  );
}

async function FinancialStatementsData({ stockCode }: { stockCode: string }) {
  const enrichedData = await getEnrichedCompanyMetadata(stockCode);

  if (!enrichedData?.financial_statements) {
    return null;
  }

  return (
    <FinancialStatementsCard statements={enrichedData.financial_statements} />
  );
}

/**
 * Financials tab: annual (and, when present, quarterly) income statement /
 * balance sheet / cash flow tables from the enriched yfinance payload.
 * Renders nothing when the stock has no statement data.
 */
export function FinancialStatementsSection({
  stockCode,
}: {
  stockCode: string;
}) {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader className="pb-3">
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </CardContent>
        </Card>
      }
    >
      <FinancialStatementsData stockCode={stockCode} />
    </Suspense>
  );
}

/** Financials tab: report links only — the enriched prose stays on Overview. */
export function FinancialReportsSection({ stockCode }: { stockCode: string }) {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader className="pb-3">
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </CardContent>
        </Card>
      }
    >
      <FinancialReportsData stockCode={stockCode} />
    </Suspense>
  );
}
