import { NextResponse, type NextRequest } from "next/server";
import { pauseAlertByToken } from "~/app/actions/alert-unsubscribe";

export const dynamic = "force-dynamic";

// RFC 8058 one-click target for the alert email's List-Unsubscribe header. It
// MUST return a bare 200 and MUST NOT redirect, so it never says whether the
// token was valid: the confirmation page at /alerts/unsubscribe asks the action
// directly when it needs the outcome. Only the token in ?t= is read.
//
// A failure is logged here, without the token, so a run of rejected pauses is
// visible. Every one of them is a customer's unsubscribe that did not work.
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") ?? "";
  if (!token) {
    console.warn("alert one-click pause: request had no token");
  } else {
    try {
      const result = await pauseAlertByToken(token);
      // "gone" is not a failure: the monitor was deleted, so no more mail will go.
      if (!result.ok && result.reason !== "gone") {
        console.warn(`alert one-click pause failed: ${result.reason}`);
      }
    } catch (error) {
      // Still a 200: a mail client that sees an error may retry or flag the sender.
      console.error(
        "alert one-click pause threw:",
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }
  return new Response(null, { status: 200 });
}

// A mail client or a link scanner that opens the List-Unsubscribe URL rather than
// POSTing it lands on the confirmation page. The redirect pauses nothing, so a
// prefetch cannot unsubscribe anyone.
export async function GET(req: NextRequest) {
  const target = new URL("/alerts/unsubscribe", req.nextUrl.origin);
  const token = req.nextUrl.searchParams.get("t");
  if (token) target.searchParams.set("t", token);
  return NextResponse.redirect(target, 303);
}
