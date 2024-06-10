import { formatNumber } from "~/@/lib/utils";
import { getStock } from "~/app/actions/getStock";
import { Card, CardHeader, CardTitle, CardContent } from "./card";
import { Separator } from "./separator";
import { Suspense } from "react";
import { Skeleton } from "./skeleton";

const placeHolder = (
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
                <Skeleton className="w-[40px] h-[15px]"/>
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
                <Skeleton className="w-[40px] h-[15px]"/>
            </span>
            </div>
        </CardContent>
        <Separator />
        <CardContent className="p-0 text-xs">
            <div className="flex align-middle justify-between">
            <span className="uppercase font-semibold">
                total shares on issue
            </span>
            <span>
                <Skeleton className="w-[40px] h-[15px]"/>
            </span>
            </div>
        </CardContent>
        </CardHeader>
    </Card>
    );

const CompanyStats = async ({ stockCode }: { stockCode: string }) => {
  const stock = await getStock(stockCode);
  return (
    <Suspense fallback={placeHolder}>
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
              {stock.percentageShorted.toFixed(2)}
              <div className="flex">
                <p>%</p>
              </div>
            </span>
          </div>
        </CardContent>
        <Separator />
        <CardContent className="p-0 text-xs">
          <div className="flex align-middle justify-between">
            <span className="uppercase font-semibold">
              reported short positions
            </span>
            <span>{formatNumber(stock.reportedShortPositions)}</span>
          </div>
        </CardContent>
        <Separator />
        <CardContent className="p-0 text-xs">
          <div className="flex align-middle justify-between">
            <span className="uppercase font-semibold">
              total shares on issue
            </span>
            <span>{formatNumber(stock.totalProductInIssue, 3)}</span>
          </div>
        </CardContent>
      </CardHeader>
    </Card>
    </Suspense>
  );
};

export default CompanyStats