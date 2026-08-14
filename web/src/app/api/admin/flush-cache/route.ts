import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

import { isAdmin } from "~/server/admin";
import {
  deleteCachedByPrefix,
  SHORTS_DATA_CACHE_PREFIXES,
} from "~/@/lib/kv-cache";

/**
 * Admin-only cache flush.
 *
 * Authorized via the ADMIN_EMAILS allowlist (next-auth/Firebase session) — call
 * it while signed in as an admin (e.g. ben.ebsworth@gmail.com). Unlike
 * /api/revalidate (which needs the shared REVALIDATION_SECRET), this is gated on
 * the admin identity, so it's safe to expose in an admin UI / run from a browser.
 *
 * Clears a named Redis cache target and optionally revalidates a route, so a
 * poisoned/stale entry (e.g. an empty response cached during a backend redeploy —
 * see getHousingOverview) can be cleared without raw Redis access.
 *
 *   POST /api/admin/flush-cache   body: { "target": "housing", "path": "/housing" }
 */
const TARGETS: Record<string, readonly string[]> = {
  housing: ["cache:housing:overview:"],
  shorts: SHORTS_DATA_CACHE_PREFIXES,
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    target?: string;
    path?: string;
  };
  const prefixes = body.target ? TARGETS[body.target] : undefined;
  if (!prefixes) {
    return NextResponse.json(
      { error: `Unknown target. Valid: ${Object.keys(TARGETS).join(", ")}` },
      { status: 400 },
    );
  }

  let flushedKeys = 0;
  for (const prefix of prefixes) {
    flushedKeys += await deleteCachedByPrefix(prefix);
  }
  if (body.path) revalidatePath(body.path);

  return NextResponse.json({
    flushed: body.target,
    flushedKeys,
    revalidated: body.path ?? null,
    timestamp: Date.now(),
  });
}
