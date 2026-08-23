import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rateLimit } from "~/@/lib/rate-limit";
import { recordProductEvent } from "~/@/lib/product-events";
import { createCommunityReport } from "~/@/lib/community/community-repository";
import { auth } from "~/server/auth";

const TARGET_TYPES = new Set(["thread", "comment", "pulse", "pulse_reply"]);

export async function POST(request: NextRequest) {
  const rateLimitResult = await rateLimit(request, {
    anonymousLimit: 10,
    authenticatedLimit: 120,
    windowSeconds: 60,
  });

  if (!rateLimitResult.success) {
    recordProductEvent({
      feature: "community",
      action: "report",
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
      { error: "You must be signed in to report content" },
      { status: 401 },
    );
  }

  try {
    const body = (await request.json().catch(() => null)) as
      | {
          stockCode?: string;
          targetType?: string;
          targetId?: string;
          reason?: string;
          details?: string;
        }
      | null;

    const stockCode = body?.stockCode?.trim().toUpperCase() ?? "";
    const targetType = body?.targetType ?? "";
    const targetId = body?.targetId?.trim() ?? "";
    const reason = body?.reason?.trim() ?? "";
    const details = body?.details?.trim() ?? "";

    if (!stockCode || !TARGET_TYPES.has(targetType) || !targetId || !reason) {
      return NextResponse.json(
        { error: "Invalid report payload" },
        { status: 400 },
      );
    }

    const report = await createCommunityReport({
      stockCode,
      targetType: targetType as "thread" | "comment" | "pulse" | "pulse_reply",
      targetId,
      reason,
      details: details || undefined,
      userId: session.user.id,
    });

    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    console.error("Failed to create community report", error);
    return NextResponse.json(
      { error: "Failed to create community report" },
      { status: 500 },
    );
  }
}
