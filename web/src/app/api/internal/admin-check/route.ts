import { createHash, timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { adminAuth } from "~/@/lib/firebase-admin";
import { isAdminEmail } from "~/server/admin";

/**
 * POST /api/internal/admin-check   { "user_id": "<firebase uid>" }  →  { "admin": boolean }
 *
 * Server-to-server only (INTERNAL_SERVICE_SECRET). The shorts API calls it to
 * decide whether a Firebase uid is an administrator, for the admin MCP server
 * (/mcp/admin) and its OAuth grants.
 *
 * Why the API asks the web app rather than deciding itself: OAuth access
 * tokens carry a user id and nothing else, and turning a uid into an email
 * needs Firebase Admin `getUser`. The web app already holds a Firebase Admin
 * credential and the ADMIN_EMAILS allowlist; giving the API the same would
 * need a PROJECT-level IAM grant that the CI deploy account cannot make. One
 * allowlist, one place — the same function that gates the /admin pages.
 *
 * Only a VERIFIED email counts, and a disabled account is never an admin: an
 * unverified email/password account registered under an admin's address must
 * not inherit their access.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function secretMatches(provided: string | null): boolean {
  const expected = process.env.INTERNAL_SERVICE_SECRET;
  if (!expected || !provided) return false;
  // Hash to fixed-size buffers so length differences do not leak or throw.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function presentedSecret(request: NextRequest): string | null {
  const header = request.headers.get("x-internal-secret");
  if (header) return header;
  const auth = request.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
}

const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!secretMatches(presentedSecret(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { user_id?: unknown };
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!UID_PATTERN.test(userId)) {
    return NextResponse.json({ error: "user_id is required" }, { status: 400 });
  }

  try {
    const user = await adminAuth.getUser(userId);
    const admin = !user.disabled && user.emailVerified && isAdminEmail(user.email);
    return NextResponse.json(
      { admin },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // An unknown uid is a definite "no", not a failure.
    if ((error as { code?: string })?.code === "auth/user-not-found") {
      return NextResponse.json({ admin: false }, { headers: { "Cache-Control": "no-store" } });
    }
    console.error("[admin-check] lookup failed", error);
    return NextResponse.json({ error: "lookup failed" }, { status: 503 });
  }
}
