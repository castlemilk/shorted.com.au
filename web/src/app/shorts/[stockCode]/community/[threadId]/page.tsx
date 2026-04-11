import { notFound } from "next/navigation";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { CommunityThreadDetail } from "~/@/components/company/community/community-thread-detail";
import { getCommunityThread } from "~/@/lib/community/firestore-community";

interface PageProps {
  params: Promise<{ stockCode: string; threadId: string }>;
}

const STOCK_CODE_PATTERN = /^[A-Z0-9]{1,4}$/;

export default async function CommunityThreadPage({ params }: PageProps) {
  const { stockCode: rawStockCode, threadId } = await params;
  const stockCode = rawStockCode.toUpperCase();

  if (!STOCK_CODE_PATTERN.test(stockCode) || !threadId) {
    notFound();
  }

  const thread = await getCommunityThread(stockCode, threadId);

  if (!thread) {
    notFound();
  }

  return (
    <DashboardLayout>
      <div className="mb-4">
        <Breadcrumbs
          items={[
            { label: "Stocks", href: "/stocks" },
            { label: stockCode, href: `/shorts/${stockCode}` },
            { label: "Community", href: `/shorts/${stockCode}?tab=community` },
            { label: thread.title, href: `/shorts/${stockCode}/community/${thread.id}` },
          ]}
        />
      </div>

      <CommunityThreadDetail thread={thread} comments={[]} />
    </DashboardLayout>
  );
}
