import { getStockDetails } from "~/app/actions/getStockDetails";
import { CompanyInfoWithRetry } from "./company-info-with-retry";
import { CompanyInfoSkeleton, CompanyInfoView } from "./company-info-view";

export const CompanyInfoPlaceholder = () => <CompanyInfoSkeleton />;

const CompanyInfo = async ({ stockCode }: { stockCode: string }) => {
  const stockDetails = await getStockDetails(stockCode);

  // If SSR failed or returned null, use client-side retry component
  if (!stockDetails) {
    return <CompanyInfoWithRetry stockCode={stockCode} initialData={null} />;
  }

  return <CompanyInfoView stockDetails={stockDetails} />;
};

export default CompanyInfo;
