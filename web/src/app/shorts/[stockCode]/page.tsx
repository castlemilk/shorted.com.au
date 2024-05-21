import { IdCardIcon } from "@radix-ui/react-icons";
import Image from "next/image";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { getStock } from "~/app/actions/getStock";
import Chart from "~/@/components/ui/chart";
import { getStockData } from "~/app/actions/getStockData";
import { Suspense } from "react";
import { getStockDetails } from "~/app/actions/getStockDetails";
import { Badge } from "~/@/components/ui/badge";
import { PanelTopIcon } from "lucide-react";
import Link from "next/link";
import { Separator } from "~/@/components/ui/separator";
import { formatNumber } from "~/@/lib/utils";
export async function generateMetadata({
  params,
}: {
  params: { stockCode: string };
}) {
  return {
    title: params.stockCode,
    describe: "shorted",
  };
}

const Page = async ({ params }: { params: { stockCode: string } }) => {
  const stock = await getStock(params.stockCode);
  const stockDetails = await getStockDetails(params.stockCode);
  const stockData = await getStockData(params.stockCode, "6m");
  return (
    <div className="flex min-h-screen w-full flex-col bg-muted/40">
      <main className="grid auto-rows-min flex-1 items-start gap-4 mt-5 p-4 sm:px-6 sm:py-0 md:gap-8 lg:grid-cols-3 xl:grid-cols-3">
        <div className="grid items-start gap-4 md:gap-8 lg:col-span-1">
          <div className="grid  gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
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
                    <CardTitle className="flex">{params.stockCode}</CardTitle>
                    <CardTitle className="flex text-lg font-semibold">
                      {stockDetails?.companyName ?? stock.name}
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
          </div>
          <div className="grid gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
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
          </div>
          <div className="grid gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            <Card className="sm:col-span-4">
              <CardHeader className="pb-3">
                <CardTitle className="flex">About</CardTitle>
              </CardHeader>
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
            </Card>
          </div>
        </div>
        <div className="grid auto-rows-max items-start gap-4 lg:col-span-2">
          <div>
            <Suspense fallback={<div>Loading...</div>}>
              <Chart stockCode={params.stockCode} initialData={stockData} />
            </Suspense>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Page;
