import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rateLimit } from "~/@/lib/rate-limit";
import {
  createCommunityThread,
  listCommunityThreads,
} from "~/@/lib/community/firestore-community";
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
    const threads = await listCommunityThreads(stockCode);

    return NextResponse.json({
      stockCode,
      threads,
    });
  } catch (error) {
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

    return NextResponse.json({ stockCode, thread }, { status: 201 });
  } catch (error) {
    console.error("Failed to create community thread", error);
    return NextResponse.json(
      { error: "Failed to create community thread" },
      { status: 500 },
    );
  }
}
