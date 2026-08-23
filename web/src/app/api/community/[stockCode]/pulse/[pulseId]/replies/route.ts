import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rateLimit } from "~/@/lib/rate-limit";
import { recordProductEvent } from "~/@/lib/product-events";
import { createCommunityPulseReply } from "~/@/lib/community/community-repository";
import {
  COMMUNITY_PUBLIC_READ_CACHE_CONTROL,
  communityPulseRepliesCacheTag,
  getCachedCommunityPulseReplies,
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
  {
    params,
  }: { params: Promise<{ stockCode: string; pulseId: string }> },
) {
  const { stockCode: rawStockCode, pulseId } = await params;
  const stockCode = rawStockCode.toUpperCase();

  if (!STOCK_CODE_PATTERN.test(stockCode) || !pulseId) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const replies = await getCachedCommunityPulseReplies(stockCode, pulseId);

    return NextResponse.json(
      {
        stockCode,
        pulseId,
        replies,
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
        route: "pulse_replies",
        stockCode,
        error,
      });

      return NextResponse.json(
        {
          stockCode,
          pulseId,
          replies: [],
        },
        {
          headers: {
            "Cache-Control": COMMUNITY_PUBLIC_READ_FALLBACK_CACHE_CONTROL,
          },
        },
      );
    }

    console.error("Failed to fetch pulse replies", error);
    return NextResponse.json(
      { error: "Failed to fetch pulse replies" },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ stockCode: string; pulseId: string }> },
) {
  const { stockCode: rawStockCode, pulseId } = await params;
  const stockCode = rawStockCode.toUpperCase();

  if (!STOCK_CODE_PATTERN.test(stockCode) || !pulseId) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const rateLimitResult = await rateLimit(request, {
    anonymousLimit: 10,
    authenticatedLimit: 180,
    windowSeconds: 60,
  });

  if (!rateLimitResult.success) {
    recordProductEvent({
      feature: "community",
      action: "pulse_reply",
      status: "rate_limited",
      properties: {
        route_group: "/api/community/*",
        // Every community bucket is a 60s window (see the config above).
        limit_kind: "per_minute",
        tier: rateLimitResult.tier,
      },
    });
    return rateLimitResult.response;
  }

  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "You must be signed in to reply" },
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
        { error: "Invalid reply payload" },
        { status: 400 },
      );
    }

    const moderation = moderateCommunityText(content);
    const reply = await createCommunityPulseReply({
      stockCode,
      pulseId,
      body: content,
      status: moderation.status,
      author: {
        userId: session.user.id,
        displayName: session.user.name ?? session.user.email ?? "Anonymous",
      },
    });

    revalidateCommunityCacheTags([
      communityPulseRepliesCacheTag(stockCode, pulseId),
    ]);

    return NextResponse.json({ stockCode, pulseId, reply }, { status: 201 });
  } catch (error) {
    console.error("Failed to create pulse reply", error);
    return NextResponse.json(
      { error: "Failed to create pulse reply" },
      { status: 500 },
    );
  }
}
