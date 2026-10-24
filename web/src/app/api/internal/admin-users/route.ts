import { type NextRequest, NextResponse } from "next/server";

import { adminAuth } from "~/@/lib/firebase-admin";
import { page, scanUsers, summarise, toAdminUser } from "~/server/admin-users";
import { hasInternalSecret } from "~/server/internal-secret";

/**
 * POST /api/internal/admin-users — signed-up accounts, for the admin MCP
 * server's users:read tools (services/shorts/internal/mcp/admin_people.go).
 *
 *   { "action": "summary" }                                  → counts
 *   { "action": "list", "query", "sort", "limit", "offset" } → one page
 *   { "action": "lookup", "email" }                          → { user | null }
 *   { "action": "lookup", "uid" }                            → { user | null }
 *
 * lookup takes EXACTLY ONE of email or uid; both, or neither, is a 400. A uid is
 * 1–128 characters of letters, digits, "_" and "-" (Firebase's uid shape). An
 * unknown email or uid is { user: null }, never an error. The uid form exists
 * so the admin MCP server can check a caller's verified address by the uid its
 * token carries (services/shorts/internal/services/shorts/firebase_users.go).
 *
 * Server-to-server only (INTERNAL_SERVICE_SECRET), for the same reason as
 * admin-check: accounts are Firebase Auth users and only this app holds a
 * Firebase Admin credential. The API has already checked that the caller is a
 * current administrator holding users:read, or jobs:run for the smoke test. A jobs:run caller only ever
 * looks up its own uid (run_alerts_smoke_test, to read its verified address);
 * this route trusts the secret.
 *
 * Returns the fewest fields that say who and in what state: uid, email,
 * verified, disabled, sign-in providers and two dates. No display names,
 * photos, phone numbers or custom claims.
 *
 * Firebase can only list accounts in uid order, so sorting and filtering scan
 * every account (1,000 per call, up to MAX_PAGES), and anything past the cap is
 * reported as `truncated` rather than silently dropped.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

// Firebase uid shape: what the admin MCP server's token carries.
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const int = (v: unknown, fallback: number) =>
  Number.isInteger(v) ? (v as number) : fallback;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasInternalSecret(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const action = body.action;

  try {
    if (action === "lookup") {
      // Exactly one key. A key that is present but malformed is a 400 too, so a
      // caller can never get a lookup it did not ask for.
      const hasEmail = body.email !== undefined;
      const hasUid = body.uid !== undefined;
      if (hasEmail === hasUid) {
        return NextResponse.json(
          { error: "give exactly one of email or uid" },
          { status: 400 },
        );
      }
      try {
        if (hasEmail) {
          const email =
            typeof body.email === "string"
              ? body.email.trim().toLowerCase()
              : "";
          if (!email || email.length > 254 || !email.includes("@")) {
            return NextResponse.json(
              { error: "email is required" },
              { status: 400 },
            );
          }
          const user = await adminAuth.getUserByEmail(email);
          return NextResponse.json(
            { user: toAdminUser(user) },
            { headers: NO_STORE },
          );
        }
        if (!UID_PATTERN.test(typeof body.uid === "string" ? body.uid : "")) {
          return NextResponse.json(
            {
              error:
                "uid must be 1-128 characters of letters, digits, _ or -",
            },
            { status: 400 },
          );
        }
        const user = await adminAuth.getUser(body.uid as string);
        return NextResponse.json(
          { user: toAdminUser(user) },
          { headers: NO_STORE },
        );
      } catch (error) {
        if ((error as { code?: string })?.code === "auth/user-not-found") {
          return NextResponse.json({ user: null }, { headers: NO_STORE });
        }
        throw error;
      }
    }

    if (action === "summary") {
      const { users, truncated } = await scanUsers();
      return NextResponse.json(summarise(users, truncated), {
        headers: NO_STORE,
      });
    }

    if (action === "list") {
      const limit = int(body.limit, 25);
      const offset = int(body.offset, 0);
      const query = typeof body.query === "string" ? body.query.trim() : "";
      const sort = body.sort === "last_sign_in" ? "last_sign_in" : "newest";
      if (limit < 1 || limit > 100 || offset < 0 || query.length > 200) {
        return NextResponse.json({ error: "invalid page" }, { status: 400 });
      }
      const { users, truncated } = await scanUsers();
      return NextResponse.json(
        { ...page(users, { query, sort, limit, offset }), truncated },
        { headers: NO_STORE },
      );
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    console.error("[admin-users] lookup failed", error);
    return NextResponse.json({ error: "lookup failed" }, { status: 503 });
  }
}
