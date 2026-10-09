import { notFound } from "next/navigation";
import { CommunityThreadDetail } from "~/@/components/company/community/community-thread-detail";
import { getCachedCommunityThread } from "~/@/lib/community/community-activity-cache";
import {
  isFirestoreReadUnavailable,
  warnCommunityReadFallback,
} from "~/@/lib/community/public-read-fallback";

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

  let thread;
  try {
    thread = await getCachedCommunityThread(stockCode, threadId);
  } catch (error) {
    if (isFirestoreReadUnavailable(error)) {
      warnCommunityReadFallback({
        route: "thread_page",
        stockCode,
        error,
      });
      notFound();
    }

    throw error;
  }

  if (!thread) {
    notFound();
  }

  // The stock layout renders the dashboard shell and the breadcrumbs
  // (Stocks > CODE > Community on this path).
  return <CommunityThreadDetail thread={thread} comments={[]} />;
}
