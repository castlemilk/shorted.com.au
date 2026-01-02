import { getStockDetails } from "~/app/actions/getStockDetails";
import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { Card, CardHeader, CardTitle, CardDescription } from "./card";
import { Badge } from "./badge";
import { Skeleton } from "./skeleton";
import { Sparkles } from "lucide-react";
import { CompanyLogo } from "./company-logo";

export const CompanyProfilePlaceholder = () => (
  <Card className="w-full">
    <CardHeader className="pb-4">
      <div className="flex flex-col md:flex-row md:items-center gap-4 md:gap-6">
        <div className="flex items-center gap-4">
          <Skeleton className="rounded-md w-[70px] h-[70px]" />
          <div className="flex flex-col gap-2">
            <Skeleton className="w-[80px] h-[24px]" />
            <div className="flex gap-1">
              <Skeleton className="w-[60px] h-[18px]" />
              <Skeleton className="w-[60px] h-[18px]" />
            </div>
          </div>
        </div>
        <div className="flex-1">
          <Skeleton className="w-full max-w-[400px] h-[32px] md:h-[40px] mb-2" />
          <Skeleton className="w-full max-w-[600px] h-[40px]" />
        </div>
      </div>
    </CardHeader>
  </Card>
);

const CompanyProfile = async ({ stockCode }: { stockCode: string }) => {
  const stockDetailsResult = await getStockDetails(stockCode);

  if (!stockDetailsResult) {
    return (
      <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex">{stockCode}</CardTitle>
          <CardDescription className="flex text-xs">
            Company profile not available
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const stockDetails: StockDetails = stockDetailsResult;

  // Check if we have enriched data
  const isEnriched = stockDetails.enrichmentStatus === "completed";
  const displaySummary =
    stockDetails.enhancedSummary || stockDetails.summary || "";

  // Truncate summary based on context (full width header allows more text)
  const truncatedSummary =
    displaySummary.length > 400
      ? `${displaySummary.substring(0, 400)}...`
      : displaySummary;

  return (
    <Card className="h-full">
      <CardHeader className="pb-4 h-full">
        <div className="flex flex-col h-full">
          <div className="flex items-start gap-4 mb-4">
            <CompanyLogo 
              gcsUrl={stockDetails.logoIconGcsUrl || stockDetails.gcsUrl} 
              companyName={stockDetails.companyName} 
              stockCode={stockCode}
            />
            <div className="flex flex-col min-w-0 flex-1">
              <CardTitle className="flex items-center gap-2 text-xl font-bold truncate">
                <span>{stockCode}</span>
                {isEnriched && (
                  <span title="AI-Enhanced Data Available" className="shrink-0">
                    <Sparkles className="h-4 w-4 text-purple-500" />
                  </span>
                )}
              </CardTitle>
              <h1 className="text-xl md:text-2xl font-extrabold tracking-tight text-foreground line-clamp-2 leading-tight" title={stockDetails.companyName ?? stockCode}>
                {stockDetails.companyName ?? stockCode}
              </h1>
              <div className="flex flex-wrap gap-1 mt-2">
                {stockDetails.industry && (
                  <Badge variant="default" className="text-[10px] whitespace-nowrap">
                    {stockDetails.industry}
                  </Badge>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex-1 min-w-0">
            {truncatedSummary && (
              <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3 md:line-clamp-4">
                {truncatedSummary}
              </p>
            )}
            {isEnriched && stockDetails.tags && stockDetails.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {stockDetails.tags.slice(0, 4).map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="text-[10px]"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardHeader>
    </Card>
  );
};

export default CompanyProfile;