import { IdCardIcon } from "@radix-ui/react-icons";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { getStock } from "~/app/actions/getStock";

const Page = async ({ params }: { params: { stockCode: string } }) => {
  const stockDetails = await getStock(params.stockCode);
  return (
    <div className="flex min-h-screen w-full flex-col bg-muted/40">
      <main className="grid flex-1 items-start gap-4 mt-5 p-4 sm:px-6 sm:py-0 md:gap-8 lg:grid-cols-3 xl:grid-cols-3">
        <div className="grid auto-rows-max items-start gap-4 md:gap-8 lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            <Card className="sm:col-span-2">
              <CardHeader className="pb-3">
                <div className="flex">
                  <div className="mr-4">
                    <IdCardIcon height={50} width={50} />
                  </div>
                  <div className="">
                    <CardTitle className="flex">{params.stockCode}</CardTitle>
                    <CardTitle className="flex text-lg font-semibold">
                      {stockDetails.name}
                    </CardTitle>
                  </div>
                </div>
                <CardDescription className="flex text-sm">
                  Company description goes here
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            <Card className="sm:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="flex">Short Position</CardTitle>
                <CardDescription>
                  <div className="flex">
                    <div className="text-3xl font-bold text-black">
                      {stockDetails.percentageShorted}
                    </div>
                    <div className="text-lg ">%</div>
                  </div>
                </CardDescription>
                <CardDescription>
                  Reported short positions:
                  {stockDetails.reportedShortPositions}
                </CardDescription>
                <CardDescription>
                  Total shares on issue: {stockDetails.totalProductInIssue}
                </CardDescription>
                <CardDescription>
                  <Progress value={stockDetails.percentageShorted} />
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Page;
