import { IdCardIcon } from "@radix-ui/react-icons";
import Image from "next/image";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { getStock } from "~/app/actions/getStock";
import Chart from "~/@/components/ui/chart";
import { getStockData } from "~/app/actions/getStockData";
import { Suspense } from "react";
import { getStockDetails } from "~/app/actions/getStockDetails";
import { Badge } from "~/@/components/ui/badge";
import { Link as LinkIcon } from "lucide-react";
import Link from "next/link";
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
                    {stockDetails.gcsUrl ? (
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
                      {stockDetails.companyName}
                    </CardTitle>
                    <CardTitle className="flex text-lg font-semibold">
                      <Badge>{stockDetails.industry}</Badge>
                    </CardTitle>
                  </div>
                </div>
                <CardDescription className="flex text-sm">
                  {stockDetails.summary}
                </CardDescription>
                <CardDescription className="flex text-sm">
                  <LinkIcon size={"20"} className="mr-2"/>
                  <Link href={stockDetails.website}><p className="text-blue-600">{stockDetails.website}</p></Link>
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
          <div className="grid gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            <Card className="sm:col-span-4">
              <CardHeader className="pb-3">
                <CardTitle className="flex">Short Position</CardTitle>
                <CardTitle>
                  <div className="flex">
                    <div className="text-3xl font-bold">
                      {stock.percentageShorted}
                    </div>
                    <div className="text-lg ">%</div>
                  </div>
                </CardTitle>
                <CardDescription>
                  Reported short positions:
                  {stock.reportedShortPositions}
                </CardDescription>
                <CardDescription>
                  Total shares on issue: {stock.totalProductInIssue}
                </CardDescription>
                <CardDescription>
                  <Progress value={stock.percentageShorted} />
                </CardDescription>
              </CardHeader>
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
