import { type NextRequest } from "next/server";
import { pauseAlertByToken } from "~/app/actions/alert-unsubscribe";

export const dynamic = "force-dynamic";

// RFC 8058 one-click target for the alert email's List-Unsubscribe header. It
// MUST return a bare 200 and MUST NOT redirect, so it never says whether the
// token was valid: the confirmation page at /alerts/unsubscribe asks the action
// directly when it needs the outcome. Only the token in ?t= is read.
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") ?? "";
  if (token) {
    try {
      await pauseAlertByToken(token);
    } catch {
      // Still a 200: a mail client that sees an error may retry or flag the sender.
    }
  }
  return new Response(null, { status: 200 });
}
