import {
  toPublicCommunityComment,
  toPublicCommunityThread,
} from "~/@/lib/community/public-content";
import { notFound } from "next/navigation";
import { CommunityThreadDetail } from "~/@/components/company/community/community-thread-detail";
import {
  getCachedCommunityComments,
  getCachedCommunityThread,
} from "~/@/lib/community/community-activity-cache";
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
  let comments;
  try {
    thread = await getCachedCommunityThread(stockCode, threadId);
    if (!thread) {
      notFound();
    }
    comments = await getCachedCommunityComments(stockCode, threadId);
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

  // The stock layout renders the dashboard shell and the breadcrumbs
  // (Stocks > CODE > Community on this path).
  return (
    <CommunityThreadDetail
      thread={toPublicCommunityThread(thread)}
      comments={comments.map(toPublicCommunityComment)}
    />
  );
}
