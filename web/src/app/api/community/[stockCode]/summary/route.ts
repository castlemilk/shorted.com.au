import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  COMMUNITY_SUMMARY_CACHE_SECONDS,
  getCachedStockCommunitySummary,
} from "~/@/lib/community/community-summary-cache";
import {
  COMMUNITY_PUBLIC_READ_FALLBACK_CACHE_CONTROL,
  emptyCommunitySummary,
  isFirestoreReadUnavailable,
  warnCommunityReadFallback,
} from "~/@/lib/community/public-read-fallback";

const STOCK_CODE_PATTERN = /^[A-Z0-9]{1,4}$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ stockCode: string }> },
) {
  const { stockCode: rawStockCode } = await params;
  const stockCode = rawStockCode.toUpperCase();

  if (!STOCK_CODE_PATTERN.test(stockCode)) {
    return NextResponse.json({ error: "Invalid stock code" }, { status: 400 });
  }

  try {
    const summary = await getCachedStockCommunitySummary(stockCode);

    return NextResponse.json(
      {
        stockCode,
        summary,
      },
      {
        headers: {
          "Cache-Control": `public, s-maxage=${COMMUNITY_SUMMARY_CACHE_SECONDS}, stale-while-revalidate=600`,
        },
      },
    );
  } catch (error) {
    if (isFirestoreReadUnavailable(error)) {
      warnCommunityReadFallback({
        route: "summary",
        stockCode,
        error,
      });

      return NextResponse.json(
        {
          stockCode,
          summary: emptyCommunitySummary(stockCode),
        },
        {
          headers: {
            "Cache-Control": COMMUNITY_PUBLIC_READ_FALLBACK_CACHE_CONTROL,
          },
        },
      );
    }

    console.error("Failed to fetch community summary", error);
    return NextResponse.json(
      { error: "Failed to fetch community summary" },
      { status: 500 },
    );
  }
}
