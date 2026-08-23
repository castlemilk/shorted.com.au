import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rateLimit } from "~/@/lib/rate-limit";
import { recordProductEvent } from "~/@/lib/product-events";
import { createCommunityThread } from "~/@/lib/community/community-repository";
import {
  COMMUNITY_PUBLIC_READ_CACHE_CONTROL,
  communityThreadsCacheTag,
  getCachedCommunityThreads,
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
const THREAD_TYPES = new Set([
  "bull",
  "bear",
  "catalyst",
  "question",
  "news_reaction",
]);

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
    const threads = await getCachedCommunityThreads(stockCode);

    return NextResponse.json(
      {
        stockCode,
        threads,
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
        route: "threads",
        stockCode,
        error,
      });

      return NextResponse.json(
        {
          stockCode,
          threads: [],
        },
        {
          headers: {
            "Cache-Control": COMMUNITY_PUBLIC_READ_FALLBACK_CACHE_CONTROL,
          },
        },
      );
    }

    console.error("Failed to fetch community threads", error);
    return NextResponse.json(
      { error: "Failed to fetch community threads" },
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
    authenticatedLimit: 120,
    windowSeconds: 60,
  });

  if (!rateLimitResult.success) {
    recordProductEvent({
      feature: "community",
      action: "thread_create",
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
      { error: "You must be signed in to post" },
      { status: 401 },
    );
  }

  try {
    const body = (await request.json().catch(() => null)) as
      | {
          type?: string;
          title?: string;
          body?: string;
          sources?: Array<{ label?: string; url?: string }>;
        }
      | null;

    const type = body?.type ?? "";
    const title = body?.title?.trim() ?? "";
    const content = body?.body?.trim() ?? "";
    const sources =
      body?.sources
        ?.map((source) => ({
          label: source.label?.trim() ?? "",
          url: source.url?.trim() ?? "",
        }))
        .filter((source) => source.label && source.url) ?? [];

    if (!THREAD_TYPES.has(type) || !title || !content) {
      return NextResponse.json(
        { error: "Invalid thread payload" },
        { status: 400 },
      );
    }

    const moderation = moderateCommunityText(`${title} ${content}`);
    const thread = await createCommunityThread({
      stockCode,
      type: type as
        | "bull"
        | "bear"
        | "catalyst"
        | "question"
        | "news_reaction",
      title,
      body: content,
      status: moderation.status,
      sources,
      author: {
        userId: session.user.id,
        displayName: session.user.name ?? session.user.email ?? "Anonymous",
      },
    });

    revalidateCommunityCacheTags([communityThreadsCacheTag(stockCode)]);

    return NextResponse.json({ stockCode, thread }, { status: 201 });
  } catch (error) {
    console.error("Failed to create community thread", error);
    return NextResponse.json(
      { error: "Failed to create community thread" },
      { status: 500 },
    );
  }
}
