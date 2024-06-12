import Chart from "~/@/components/ui/chart";
import CompanyProfile from "~/@/components/ui/companyProfile";
import CompanyStats from "~/@/components/ui/companyStats";
import CompanyInfo from "~/@/components/ui/companyInfo";
import { Suspense } from "react";
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
export const revalidate = 60; // revalidate the data at most every minute
const Page = async ({ params }: { params: { stockCode: string } }) => {
  return (
    <div className="flex min-h-screen w-full flex-col bg-muted/40">
      <main className="grid auto-rows-min flex-1 items-start gap-4 mt-5 p-4 sm:px-6 sm:py-0 md:gap-8 lg:grid-cols-3 xl:grid-cols-3">
        <div className="grid items-start gap-4 md:gap-8 lg:col-span-1">
          <div className="grid  gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
            <Suspense fallback={<div>loading...</div>}>
            <CompanyProfile stockCode={params.stockCode} />
            </Suspense>
          </div>
          <div className="grid gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
          <Suspense fallback={<div>loading...</div>}>
            <CompanyStats stockCode={params.stockCode} />
            </Suspense>
          </div>
          <div className="grid gap-4 sm:grid-cols-4 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4">
          <Suspense fallback={<div>loading...</div>}>
            <CompanyInfo stockCode={params.stockCode} />
            </Suspense>
          </div>
        </div>
        <div className="grid auto-rows-max items-start gap-4 lg:col-span-2">
          <div>
            <Chart stockCode={params.stockCode} />
          </div>
        </div>
      </main>
    </div>
  );
};

export default Page;
