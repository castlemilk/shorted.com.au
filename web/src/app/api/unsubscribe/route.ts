import { type NextRequest } from "next/server";
import { unsubscribe } from "~/app/actions/unsubscribe";

export const dynamic = "force-dynamic";

// RFC 8058 one-click target. MUST return a bare 200/202, MUST NOT redirect.
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t") ?? "";
  if (token) await unsubscribe(token);
  return new Response(null, { status: 200 });
}
