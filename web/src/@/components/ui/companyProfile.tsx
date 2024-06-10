import { IdCardIcon } from "@radix-ui/react-icons";
import Image from "next/image";
import { getStockDetails } from "~/app/actions/getStockDetails";
import { Card, CardHeader, CardTitle, CardDescription } from "./card";
import { Badge } from "./badge";
import { Suspense } from "react";
import { Skeleton } from "./skeleton";

const placeHolder = (
    <Card className="sm:col-span-4">
        <CardHeader className="pb-3">
        <div className="flex">
            <div className="mr-4">
            <Skeleton className="rounded-md w-[70px] h-[70px]"  />
            </div>
            <div className="">
            <CardTitle className="flex">
                <Skeleton className="w-[60px] h-[20px] mb-2"/>
            </CardTitle>
            <CardTitle className="flex text-lg font-semibold">
                <Skeleton className="w-[200px] h-[20px] mb-2"/>
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

const CompanyProfile = async ({ stockCode}: { stockCode: string}) => {
    const stockDetails = await getStockDetails(stockCode);
    return (
        <Suspense fallback={placeHolder}>
        <Card className="sm:col-span-4">
              <CardHeader className="pb-3">
                <div className="flex">
                  <div className="mr-4">
                    {stockDetails?.gcsUrl ? (
                      <Image
                        width={70}
                        height={80}
                        src={stockDetails.gcsUrl}
                        alt={"company-logo"}
                      />
                    ) : (
                      <IdCardIcon height={50} width={50} />
                    )}
                  </div>
                  <div className="">
                    <CardTitle className="flex">{stockCode}</CardTitle>
                    <CardTitle className="flex text-lg font-semibold">
                      {stockDetails?.companyName ?? stockCode}
                    </CardTitle>
                    <CardTitle className="flex text-lg font-semibold">
                      <Badge>{stockDetails?.industry}</Badge>
                    </CardTitle>
                  </div>
                </div>
                <CardDescription className="flex text-xs">
                  {stockDetails?.summary}
                </CardDescription>
              </CardHeader>
            </Card>
            </Suspense>
    )
}

export default CompanyProfile;