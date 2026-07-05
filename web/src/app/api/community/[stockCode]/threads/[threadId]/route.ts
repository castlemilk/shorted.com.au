import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getCommunityThread } from "~/@/lib/community/firestore-community";
import {
  COMMUNITY_PUBLIC_READ_FALLBACK_CACHE_CONTROL,
  isFirestoreReadUnavailable,
  warnCommunityReadFallback,
} from "~/@/lib/community/public-read-fallback";

const STOCK_CODE_PATTERN = /^[A-Z0-9]{1,4}$/;

export async function GET(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ stockCode: string; threadId: string }> },
) {
  const { stockCode: rawStockCode, threadId } = await params;
  const stockCode = rawStockCode.toUpperCase();

  if (!STOCK_CODE_PATTERN.test(stockCode) || !threadId) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const thread = await getCommunityThread(stockCode, threadId);

    if (!thread) {
      return NextResponse.json(
        { error: "Thread not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      stockCode,
      thread,
    });
  } catch (error) {
    if (isFirestoreReadUnavailable(error)) {
      warnCommunityReadFallback({
        route: "thread_detail",
        stockCode,
        error,
      });

      return NextResponse.json(
        { error: "Thread not found" },
        {
          status: 404,
          headers: {
            "Cache-Control": COMMUNITY_PUBLIC_READ_FALLBACK_CACHE_CONTROL,
          },
        },
      );
    }

    console.error("Failed to fetch community thread", error);
    return NextResponse.json(
      { error: "Failed to fetch community thread" },
      { status: 500 },
    );
  }
}
