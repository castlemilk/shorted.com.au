import { Suspense } from "react";
import { getEnrichedCompanyMetadata } from "~/app/actions/company-metadata";
import { CompanyInsightsCard } from "./company-insights-card";
import { pickCompanyInsights } from "./company-insights-data";
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

  // Only the fields the card reads cross into the client component: the
  // enriched payload also carries the ~32 KB financial_statements JSONB,
  // which must never ride along in the page's RSC payload.
  return <CompanyInsightsCard data={pickCompanyInsights(enrichedData)} />;
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
 * sections + key people). Reports are NOT rendered here: the Financials tab
 * lists them (FinancialReports, passed in by the page), so the two tabs do
 * not duplicate content.
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
