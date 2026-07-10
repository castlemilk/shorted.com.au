import { getStock } from "~/app/actions/getStock";
import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { CompanyStatsWithRetry } from "./company-stats-with-retry";
import { CompanyStatsSkeleton, CompanyStatsView } from "./company-stats-view";

export const CompanyStatsPlaceholder = () => <CompanyStatsSkeleton />;

const CompanyStats = async ({
  stockCode,
  initialStock,
}: {
  stockCode: string;
  initialStock?: Stock | null;
}) => {
  const stock = initialStock ?? (await getStock(stockCode));

  // If SSR failed or returned null, use client-side retry component
  if (!stock) {
    return <CompanyStatsWithRetry stockCode={stockCode} initialData={null} />;
  }

  return <CompanyStatsView stock={stock} />;
};

export default CompanyStats;
