import { getStockDetails } from "~/app/actions/getStockDetails";
import { CompanyProfileWithRetry } from "./company-profile-with-retry";
import {
  CompanyProfileSkeleton,
  CompanyProfileView,
} from "./company-profile-view";

export const CompanyProfilePlaceholder = () => <CompanyProfileSkeleton />;

const CompanyProfile = async ({ stockCode }: { stockCode: string }) => {
  const stockDetails = await getStockDetails(stockCode);

  // If SSR failed or returned null, use client-side retry component
  if (!stockDetails) {
    return <CompanyProfileWithRetry stockCode={stockCode} initialData={null} />;
  }

  return (
    <CompanyProfileView stockCode={stockCode} stockDetails={stockDetails} />
  );
};

export default CompanyProfile;
