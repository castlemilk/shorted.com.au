import { Suspense } from "react";
import { getEnrichedCompanyMetadata } from "~/app/actions/company-metadata";
import { CompanyOverview } from "./company-overview";
import { KeyPeople } from "./key-people";
import { FinancialReports } from "./financial-reports";
import {
  Card,
  CardContent,
  CardDescription,
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
    return (
      <Card className="border-l-4 border-l-gray-300">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Info className="h-5 w-5" />
            Company Insights
          </CardTitle>
          <CardDescription>
            Enriched company data not available yet
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            AI-powered company insights are being generated. Check back soon for
            detailed analysis, key people, financial reports, and more.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Company Overview Section */}
      <CompanyOverview data={enrichedData} />

      {/* Key People */}
      {enrichedData.key_people && enrichedData.key_people.length > 0 && (
        <KeyPeople
          people={enrichedData.key_people}
          companyName={enrichedData.company_name}
        />
      )}

      {/* Financial Reports */}
      {enrichedData.financial_reports &&
        enrichedData.financial_reports.length > 0 && (
          <FinancialReports
            reports={enrichedData.financial_reports}
            stockCode={stockCode}
          />
        )}
    </div>
  );
}

function EnrichedCompanyFallback() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

export function EnrichedCompanySection({
  stockCode,
}: EnrichedCompanySectionProps) {
  return (
    <Suspense fallback={<EnrichedCompanyFallback />}>
      <EnrichedCompanyData stockCode={stockCode} />
    </Suspense>
  );
}

