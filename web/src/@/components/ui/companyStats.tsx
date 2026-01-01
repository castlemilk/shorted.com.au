import { formatNumber } from "~/@/lib/utils";
import { getStock } from "~/app/actions/getStock";
import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { Card, CardHeader, CardTitle, CardContent } from "./card";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";

export const CompanyStatsPlaceholder = () => (
  <Card className="sm:col-span-4">
    <CardHeader className="pb-3">
      <CardTitle className="flex">Shorted</CardTitle>
      <Separator />
      <CardContent className="p-0 text-xs">
        <div className="flex align-middle justify-between">
          <span className="flex justify-center uppercase font-semibold">
            short percentage
          </span>
          <span className="flex items-end">
            <Skeleton className="w-[40px] h-[15px]" />
          </span>
        </div>
      </CardContent>
      <Separator />
      <CardContent className="p-0 text-xs">
        <div className="flex align-middle justify-between">
          <span className="uppercase font-semibold">
            reported short positions
          </span>
          <span>
            <Skeleton className="w-[40px] h-[15px]" />
          </span>
        </div>
      </CardContent>
      <Separator />
      <CardContent className="p-0 text-xs">
        <div className="flex align-middle justify-between">
          <span className="uppercase font-semibold">total shares on issue</span>
          <span>
            <Skeleton className="w-[40px] h-[15px]" />
          </span>
        </div>
      </CardContent>
    </CardHeader>
  </Card>
);

const CompanyStats = async ({ stockCode }: { stockCode: string }) => {
  const stockResult = await getStock(stockCode);
  
  if (!stockResult) {
    return (
      <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex">Shorted</CardTitle>
          <Separator />
          <CardContent className="p-0 pt-4">
            <p className="text-sm text-muted-foreground">
              Stock statistics not available
            </p>
          </CardContent>
        </CardHeader>
      </Card>
    );
  }

  const stock: Stock = stockResult;
  
  return (
      <Card className="h-full">
        <CardHeader className="pb-3 h-full flex flex-col">
          <CardTitle className="flex">Shorted</CardTitle>
          <Separator className="my-2" />
          <div className="flex-1 flex flex-col justify-between py-1">
            <CardContent className="p-0 text-xs">
              <div className="flex align-middle justify-between">
                <span className="flex justify-center uppercase font-semibold text-muted-foreground">
                  short percentage
                </span>
                <span className="flex items-center font-bold text-sm">
                  {stock.percentageShorted.toFixed(2)}%
                </span>
              </div>
            </CardContent>
            <Separator className="my-2 opacity-50" />
            <CardContent className="p-0 text-xs">
              <div className="flex align-middle justify-between">
                <span className="uppercase font-semibold text-muted-foreground">
                  reported shorts
                </span>
                <span className="font-medium">{formatNumber(stock.reportedShortPositions)}</span>
              </div>
            </CardContent>
            <Separator className="my-2 opacity-50" />
            <CardContent className="p-0 text-xs">
              <div className="flex align-middle justify-between">
                <span className="uppercase font-semibold text-muted-foreground">
                  shares on issue
                </span>
                <span className="font-medium">{formatNumber(stock.totalProductInIssue, 3)}</span>
              </div>
            </CardContent>
          </div>
        </CardHeader>
      </Card>
  );
};

export default CompanyStats;
