import { getStockDetails } from "~/app/actions/getStockDetails";
import { Card, CardContent, CardHeader, CardTitle } from "./card";
import { PanelTopIcon } from "lucide-react";
import Link from "next/link";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";

export const CompanyInfoPlaceholder = () => (
  <Card className="sm:col-span-4">
    <CardHeader className="pb-3">
      <CardTitle className="flex">About</CardTitle>
      <Separator />

      <CardContent className="p-0">
        <div className="flex content-center justify-between">
          <div className="flex content-center">
            <div className="flex self-center p-2">
              <PanelTopIcon size={10} />
            </div>
            <p className="uppercase font-semibold content-center text-xs">
              website
            </p>
          </div>
          <span className="flex items-end content-center p-2 text-xs">
            <Skeleton className="w-[200px] h-[16px]" />
          </span>
        </div>
      </CardContent>
      <Separator />
    </CardHeader>
  </Card>
);

const companyInfo = async ({ stockCode }: { stockCode: string }) => {
  const stockDetails = await getStockDetails(stockCode);
  return (
    <Card className="sm:col-span-4">
      <CardHeader className="pb-3">
        <CardTitle className="flex">About</CardTitle>

        <Separator />
        {stockDetails?.website && (
          <>
            <CardContent className="p-0">
              <div className="flex content-center justify-between">
                <div className="flex content-center">
                  <div className="flex self-center p-2">
                    <PanelTopIcon size={10} />
                  </div>
                  <p className="uppercase font-semibold content-center text-xs">
                    website
                  </p>
                </div>
                <span className="flex items-end content-center p-2 text-xs">
                  <Link href={stockDetails?.website}>
                    <p className="text-blue-600">
                      {stockDetails?.website.split(/www.|\:\/\//).at(-1)}
                    </p>
                  </Link>
                </span>
              </div>
            </CardContent>
            <Separator />
          </>
        )}
      </CardHeader>
    </Card>
  );
};

export default companyInfo;
