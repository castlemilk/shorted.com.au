import { getStockDetails } from "~/app/actions/getStockDetails";
import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { Card, CardHeader, CardTitle, CardContent } from "./card";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";
import { TrendingUp, DollarSign, Users } from "lucide-react";

export const CompanyFinancialsPlaceholder = () => (
  <Card className="sm:col-span-4">
    <CardHeader className="pb-3">
      <CardTitle className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4" />
        Key Metrics
      </CardTitle>
      <Separator />
      <CardContent className="p-0 text-xs">
        <div className="flex align-middle justify-between py-2">
          <span className="flex justify-center uppercase font-semibold">
            market cap
          </span>
          <span className="flex items-end">
            <Skeleton className="w-[60px] h-[15px]" />
          </span>
        </div>
      </CardContent>
    </CardHeader>
  </Card>
);

const CompanyFinancials = async ({ stockCode }: { stockCode: string }) => {
  const stockDetailsResult = await getStockDetails(stockCode);

  if (!stockDetailsResult) {
    return null;
  }

  const stockDetails: StockDetails = stockDetailsResult;
  const financialInfo = stockDetails.financialStatements?.info;

  // Only show this card if we have enriched financial data
  if (!financialInfo || stockDetails.enrichmentStatus !== "completed") {
    return null;
  }

  const formatCurrency = (value?: number | string | null) => {
    if (!value) return null;
    const num = typeof value === "string" ? parseFloat(value) : value;
    if (isNaN(num)) return null;

    if (num >= 1e9) {
      return `$${(num / 1e9).toFixed(2)}B`;
    } else if (num >= 1e6) {
      return `$${(num / 1e6).toFixed(2)}M`;
    } else if (num >= 1e3) {
      return `$${(num / 1e3).toFixed(2)}K`;
    }
    return `$${num.toFixed(2)}`;
  };

  const formatNumber = (value?: number | string | bigint | null) => {
    if (!value) return null;
    if (typeof value === "bigint") return value.toLocaleString();
    const num = typeof value === "string" ? parseFloat(value) : value;
    if (isNaN(num)) return null;
    return num.toLocaleString();
  };

  const hasAnyData = Boolean(
    financialInfo.marketCap ||
    financialInfo.currentPrice ||
    financialInfo.peRatio ||
    financialInfo.eps ||
    financialInfo.dividendYield ||
    financialInfo.employeeCount
  );

  if (!hasAnyData) {
    return null;
  }

  return (
    <Card className="sm:col-span-4">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Key Metrics
        </CardTitle>
        <Separator />

        <CardContent className="p-0 space-y-0">
          {/* Market Cap */}
          {financialInfo.marketCap && (
            <>
              <div className="flex align-middle justify-between py-2">
                <div className="flex items-center gap-2">
                  <DollarSign className="h-3 w-3" />
                  <span className="uppercase font-semibold text-xs">
                    market cap
                  </span>
                </div>
                <span className="text-xs">
                  {formatCurrency(financialInfo.marketCap as number | string | null | undefined)}
                </span>
              </div>
              <Separator />
            </>
          )}

          {/* Current Price */}
          {financialInfo.currentPrice && (
            <>
              <div className="flex align-middle justify-between py-2">
                <span className="uppercase font-semibold text-xs">price</span>
                <span className="text-xs">
                  {formatCurrency(financialInfo.currentPrice as number | string | null | undefined)}
                </span>
              </div>
              <Separator />
            </>
          )}

          {/* P/E Ratio */}
          {financialInfo.peRatio && (
            <>
              <div className="flex align-middle justify-between py-2">
                <span className="uppercase font-semibold text-xs">
                  p/e ratio
                </span>
                <span className="text-xs">
                  {typeof financialInfo.peRatio === "number"
                    ? financialInfo.peRatio.toFixed(2)
                    : financialInfo.peRatio}
                </span>
              </div>
              <Separator />
            </>
          )}

          {/* EPS */}
          {financialInfo.eps && (
            <>
              <div className="flex align-middle justify-between py-2">
                <span className="uppercase font-semibold text-xs">eps</span>
                <span className="text-xs">
                  {formatCurrency(financialInfo.eps as number | string | null | undefined)}
                </span>
              </div>
              <Separator />
            </>
          )}

          {/* Dividend Yield */}
          {financialInfo.dividendYield && (
            <>
              <div className="flex align-middle justify-between py-2">
                <span className="uppercase font-semibold text-xs">
                  dividend yield
                </span>
                <span className="text-xs">
                  {typeof financialInfo.dividendYield === "number"
                    ? `${(financialInfo.dividendYield * 100).toFixed(2)}%`
                    : financialInfo.dividendYield}
                </span>
              </div>
              <Separator />
            </>
          )}

          {/* Employees */}
          {financialInfo.employeeCount && (
            <>
              <div className="flex align-middle justify-between py-2">
                <div className="flex items-center gap-2">
                  <Users className="h-3 w-3" />
                  <span className="uppercase font-semibold text-xs">
                    employees
                  </span>
                </div>
                <span className="text-xs">
                  {formatNumber(financialInfo.employeeCount as number | string | bigint | null | undefined)}
                </span>
              </div>
            </>
          )}
        </CardContent>
      </CardHeader>
    </Card>
  );
};

export default CompanyFinancials;


