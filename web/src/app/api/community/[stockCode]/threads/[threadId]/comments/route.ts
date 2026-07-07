import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rateLimit } from "~/@/lib/rate-limit";
import { createCommunityComment } from "~/@/lib/community/community-repository";
import {
  COMMUNITY_PUBLIC_READ_CACHE_CONTROL,
  communityThreadCommentsCacheTag,
  getCachedCommunityComments,
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
  }: { params: Promise<{ stockCode: string; threadId: string }> },
) {
  const { stockCode: rawStockCode, threadId } = await params;
  const stockCode = rawStockCode.toUpperCase();

  if (!STOCK_CODE_PATTERN.test(stockCode) || !threadId) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const comments = await getCachedCommunityComments(stockCode, threadId);

    return NextResponse.json(
      {
        stockCode,
        threadId,
        comments,
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
        route: "thread_comments",
        stockCode,
        error,
      });

      return NextResponse.json(
        {
          stockCode,
          threadId,
          comments: [],
        },
        {
          headers: {
            "Cache-Control": COMMUNITY_PUBLIC_READ_FALLBACK_CACHE_CONTROL,
          },
        },
      );
    }

    console.error("Failed to fetch community comments", error);
    return NextResponse.json(
      { error: "Failed to fetch community comments" },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ stockCode: string; threadId: string }> },
) {
  const { stockCode: rawStockCode, threadId } = await params;
  const stockCode = rawStockCode.toUpperCase();

  if (!STOCK_CODE_PATTERN.test(stockCode) || !threadId) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
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
      { error: "You must be signed in to comment" },
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
        { error: "Invalid comment payload" },
        { status: 400 },
      );
    }

    const moderation = moderateCommunityText(content);
    const comment = await createCommunityComment({
      stockCode,
      threadId,
      body: content,
      status: moderation.status,
      author: {
        userId: session.user.id,
        displayName: session.user.name ?? session.user.email ?? "Anonymous",
      },
    });

    revalidateCommunityCacheTags([
      communityThreadCommentsCacheTag(stockCode, threadId),
    ]);

    return NextResponse.json({ stockCode, threadId, comment }, { status: 201 });
  } catch (error) {
    console.error("Failed to create community comment", error);
    return NextResponse.json(
      { error: "Failed to create community comment" },
      { status: 500 },
    );
  }
}
