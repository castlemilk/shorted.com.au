import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rateLimit } from "~/@/lib/rate-limit";
import { createCommunityPulseItem } from "~/@/lib/community/community-repository";
import {
  COMMUNITY_PUBLIC_READ_CACHE_CONTROL,
  communityPulseCacheTag,
  getCachedCommunityPulseItems,
  revalidateCommunityCacheTags,
} from "~/@/lib/community/community-activity-cache";
import {
  COMMUNITY_PUBLIC_READ_FALLBACK_CACHE_CONTROL,
  isFirestoreReadUnavailable,
  warnCommunityReadFallback,
} from "~/@/lib/community/public-read-fallback";
import { moderateCommunityText } from "~/@/lib/community/moderation";
import { auth } from "~/server/auth";

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
    const pulse = await getCachedCommunityPulseItems(stockCode);

    return NextResponse.json(
      {
        stockCode,
        pulse,
      },
      {
        headers: {
          "Cache-Control": COMMUNITY_PUBLIC_READ_CACHE_CONTROL,
        },
      },
    );
  } catch (error) {
    if (isFirestoreReadUnavailable(error)) {
      warnCommunityReadFallback({
        route: "pulse",
        stockCode,
        error,
      });

      return NextResponse.json(
        {
          stockCode,
          pulse: [],
        },
        {
          headers: {
            "Cache-Control": COMMUNITY_PUBLIC_READ_FALLBACK_CACHE_CONTROL,
          },
        },
      );
    }

    console.error("Failed to fetch community pulse", error);
    return NextResponse.json(
      { error: "Failed to fetch community pulse" },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ stockCode: string }> },
) {
  const { stockCode: rawStockCode } = await params;
  const stockCode = rawStockCode.toUpperCase();

  if (!STOCK_CODE_PATTERN.test(stockCode)) {
    return NextResponse.json({ error: "Invalid stock code" }, { status: 400 });
  }

  const rateLimitResult = await rateLimit(request, {
    anonymousLimit: 10,
    authenticatedLimit: 180,
    windowSeconds: 60,
  });

  if (!rateLimitResult.success) {
    return rateLimitResult.response;
  }

  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "You must be signed in to post" },
      { status: 401 },
    );
  }

  try {
    const body = (await request.json().catch(() => null)) as
      | { body?: string }
      | null;
    const content = body?.body?.trim() ?? "";

    if (!content) {
      return NextResponse.json(
        { error: "Invalid pulse payload" },
        { status: 400 },
      );
    }

    const moderation = moderateCommunityText(content);
    const pulseItem = await createCommunityPulseItem({
      stockCode,
      body: content,
      status: moderation.status,
      author: {
        userId: session.user.id,
        displayName: session.user.name ?? session.user.email ?? "Anonymous",
      },
    });

    revalidateCommunityCacheTags([communityPulseCacheTag(stockCode)]);

    return NextResponse.json({ stockCode, pulse: pulseItem }, { status: 201 });
  } catch (error) {
    console.error("Failed to create pulse item", error);
    return NextResponse.json(
      { error: "Failed to create pulse item" },
      { status: 500 },
    );
  }
}
