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

  // Show key metrics if we have financial data (from daily sync or enrichment)
  // Key metrics come from daily sync, not just enrichment, so don't require enrichmentStatus === "completed"
  if (!financialInfo) {
    return null;
  }

  // Helper to check if a value is valid (non-zero, non-null, non-empty)
  const isValidValue = (value?: number | string | bigint | null): boolean => {
    if (value === null || value === undefined) return false;
    if (typeof value === "bigint") return value !== BigInt(0);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "" || /^0+\.?0*$/.test(trimmed)) return false;
      const num = parseFloat(trimmed);
      return !isNaN(num) && num !== 0;
    }
    return value !== 0 && !isNaN(value);
  };

  const formatCurrency = (value?: number | string | null) => {
    if (!isValidValue(value)) return null;
    const num = typeof value === "string" ? parseFloat(value) : value!;

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
    if (!isValidValue(value)) return null;
    if (typeof value === "bigint") {
      return value.toLocaleString();
    }
    const num = typeof value === "string" ? parseFloat(value) : value!;
    return num.toLocaleString();
  };

  const hasAnyData = Boolean(
    isValidValue(financialInfo.marketCap) ||
      isValidValue(financialInfo.currentPrice) ||
      isValidValue(financialInfo.peRatio) ||
      isValidValue(financialInfo.eps) ||
      isValidValue(financialInfo.dividendYield) ||
      isValidValue(financialInfo.employeeCount),
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
          {(() => {
            if (!isValidValue(financialInfo.marketCap)) return null;
            const formatted = formatCurrency(financialInfo.marketCap);
            if (!formatted) return null;
            return (
              <>
                <div className="flex align-middle justify-between py-2">
                  <div className="flex items-center gap-2">
                    <DollarSign className="h-3 w-3" />
                    <span className="uppercase font-semibold text-xs">
                      market cap
                    </span>
                  </div>
                  <span className="text-xs">{formatted}</span>
                </div>
                <Separator />
              </>
            );
          })()}

          {/* Current Price */}
          {(() => {
            if (!isValidValue(financialInfo.currentPrice)) return null;
            const formatted = formatCurrency(financialInfo.currentPrice);
            if (!formatted) return null;
            return (
              <>
                <div className="flex align-middle justify-between py-2">
                  <span className="uppercase font-semibold text-xs">price</span>
                  <span className="text-xs">{formatted}</span>
                </div>
                <Separator />
              </>
            );
          })()}

          {/* P/E Ratio */}
          {(() => {
            if (!isValidValue(financialInfo.peRatio)) return null;
            const peRatio = financialInfo.peRatio;
            const num =
              typeof peRatio === "number"
                ? peRatio
                : parseFloat(String(peRatio));
            if (isNaN(num) || num === 0) return null;
            const formatted =
              typeof peRatio === "number"
                ? peRatio.toFixed(2)
                : String(peRatio);
            // Double-check formatted value isn't "0000" or similar
            if (/^0+\.?0*$/.test(formatted)) return null;
            return (
              <>
                <div className="flex align-middle justify-between py-2">
                  <span className="uppercase font-semibold text-xs">
                    p/e ratio
                  </span>
                  <span className="text-xs">{formatted}</span>
                </div>
                <Separator />
              </>
            );
          })()}

          {/* EPS */}
          {(() => {
            if (!isValidValue(financialInfo.eps)) return null;
            const formatted = formatCurrency(financialInfo.eps);
            if (!formatted) return null;
            return (
              <>
                <div className="flex align-middle justify-between py-2">
                  <span className="uppercase font-semibold text-xs">eps</span>
                  <span className="text-xs">{formatted}</span>
                </div>
                <Separator />
              </>
            );
          })()}

          {/* Dividend Yield */}
          {(() => {
            if (!isValidValue(financialInfo.dividendYield)) return null;
            const divYield = financialInfo.dividendYield;
            const num =
              typeof divYield === "number"
                ? divYield
                : parseFloat(String(divYield));
            if (isNaN(num) || num === 0) return null;
            const formatted =
              typeof divYield === "number"
                ? `${(divYield * 100).toFixed(2)}%`
                : String(divYield);
            // Double-check formatted value isn't "0000" or similar
            if (/^0+\.?0*%?$/.test(formatted.replace(/%$/, ""))) return null;
            return (
              <>
                <div className="flex align-middle justify-between py-2">
                  <span className="uppercase font-semibold text-xs">
                    dividend yield
                  </span>
                  <span className="text-xs">{formatted}</span>
                </div>
                <Separator />
              </>
            );
          })()}

          {/* Employees */}
          {(() => {
            if (!isValidValue(financialInfo.employeeCount)) return null;
            const formatted = formatNumber(financialInfo.employeeCount);
            if (!formatted) return null;
            return (
              <>
                <div className="flex align-middle justify-between py-2">
                  <div className="flex items-center gap-2">
                    <Users className="h-3 w-3" />
                    <span className="uppercase font-semibold text-xs">
                      employees
                    </span>
                  </div>
                  <span className="text-xs">{formatted}</span>
                </div>
              </>
            );
          })()}
        </CardContent>
      </CardHeader>
    </Card>
  );
};

export default CompanyFinancials;
