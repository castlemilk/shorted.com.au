import { getStockDetails } from "~/app/actions/getStockDetails";
import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { Card, CardHeader, CardTitle, CardDescription } from "./card";
import { Badge } from "./badge";
import { Skeleton } from "./skeleton";
import { Sparkles } from "lucide-react";
import { CompanyLogo } from "./company-logo";

export const CompanyProfilePlaceholder = () => (
  <Card className="sm:col-span-4">
    <CardHeader className="pb-3">
      <div className="flex">
        <div className="mr-4">
          <Skeleton className="rounded-md w-[70px] h-[70px]" />
        </div>
        <div className="">
          <CardTitle className="flex">
            <Skeleton className="w-[60px] h-[20px] mb-2" />
          </CardTitle>
          <CardTitle className="flex text-lg font-semibold">
            <Skeleton className="w-[200px] h-[20px] mb-2" />
          </CardTitle>
          <CardTitle className="flex text-lg font-semibold">
            <Skeleton className="w-[80px] h-[20px]" />
          </CardTitle>
        </div>
      </div>
      <CardDescription className="flex text-xs">
        <Skeleton className="w-[250px] h-[20px]" />
      </CardDescription>
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

  // Truncate summary if it's too long (limit to ~200 chars for card view)
  const truncatedSummary =
    displaySummary.length > 200
      ? `${displaySummary.substring(0, 200)}...`
      : displaySummary;

  return (
    <Card className="sm:col-span-4">
      <CardHeader className="pb-3">
        <div className="flex">
          <CompanyLogo 
            gcsUrl={stockDetails.gcsUrl} 
            companyName={stockDetails.companyName} 
            stockCode={stockCode}
          />
          <div className="flex-1">
            <CardTitle className="flex items-center gap-2">
              {stockCode}
              {isEnriched && (
                <span title="AI-Enhanced Data Available">
                  <Sparkles className="h-3 w-3 text-purple-500" />
                </span>
              )}
            </CardTitle>
            <CardTitle className="flex text-lg font-semibold">
              {stockDetails.companyName ?? stockCode}
            </CardTitle>
            <div className="flex flex-wrap gap-1 mt-1">
              {stockDetails.industry && (
                <Badge variant="default">{stockDetails.industry}</Badge>
              )}
              {/* Show first 2-3 enriched tags */}
              {isEnriched &&
                stockDetails.tags?.slice(0, 2).map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="text-xs"
                  >
                    {tag}
                  </Badge>
                ))}
            </div>
          </div>
        </div>
        {truncatedSummary && (
          <CardDescription className="flex text-xs mt-2 leading-relaxed">
            {truncatedSummary}
          </CardDescription>
        )}
      </CardHeader>
    </Card>
  );
};

export default CompanyProfile;