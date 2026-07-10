import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { Card, CardHeader } from "./card";
import { Badge } from "./badge";
import { Skeleton } from "./skeleton";
import { Sparkles, RefreshCwIcon } from "lucide-react";
import { CompanyLogo } from "./company-logo";

/**
 * Shared presentational view for the company profile card.
 *
 * Rendered by BOTH the server component (companyProfile.tsx) and the client
 * retry twin (company-profile-with-retry.tsx) so the markup lives in exactly
 * one place. Keep this module free of a "use client" directive and free of
 * any @connectrpc/connect imports — it must stay renderable from server
 * import chains. (CompanyLogo is "use client", which is fine to reference
 * from a server component.)
 */
export function CompanyProfileView({
  stockCode,
  stockDetails,
}: {
  stockCode: string;
  stockDetails: StockDetails;
}) {
  // Check if we have enriched data
  const isEnriched = stockDetails.enrichmentStatus === "completed";
  // CSS line-clamp below handles truncation — no JS substring, which
  // produced mid-word "..." cutoffs on top of the clamp.
  const displaySummary =
    stockDetails.enhancedSummary || stockDetails.summary || "";

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
              <div className="flex items-center gap-2 text-xl font-bold truncate">
                <span>{stockCode}</span>
                {isEnriched && (
                  <span
                    role="img"
                    aria-label="AI-enhanced data available"
                    title="AI-Enhanced Data Available"
                    className="shrink-0"
                  >
                    <Sparkles className="h-4 w-4 text-purple-500" aria-hidden />
                  </span>
                )}
              </div>
              {/* h2 — the page's h1 is the sr-only crawler summary in page.tsx */}
              <h2 className="text-xl md:text-2xl font-extrabold tracking-tight text-foreground line-clamp-2 leading-tight" title={stockDetails.companyName ?? stockCode}>
                {stockDetails.companyName ?? stockCode}
              </h2>
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
            {displaySummary && (
              <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3 md:line-clamp-4">
                {displaySummary}
              </p>
            )}
            {/* Enrichment tags intentionally omitted — they render once, in
                the Company insights card on the Overview tab. */}
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

/**
 * Shared skeleton — the server placeholder AND the client loading state.
 * `isRetrying` adds the client-side retry spinner next to the code skeleton.
 */
export function CompanyProfileSkeleton({
  isRetrying,
}: {
  isRetrying?: boolean;
}) {
  return (
    <Card className="w-full">
      <CardHeader className="pb-4">
        <div className="flex flex-col md:flex-row md:items-center gap-4 md:gap-6">
          <div className="flex items-center gap-4">
            <Skeleton className="rounded-md w-[70px] h-[70px]" />
            <div className="flex flex-col gap-2">
              {isRetrying ? (
                <div className="flex items-center gap-2">
                  <Skeleton className="w-[80px] h-[24px]" />
                  <RefreshCwIcon className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <Skeleton className="w-[80px] h-[24px]" />
              )}
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
}
