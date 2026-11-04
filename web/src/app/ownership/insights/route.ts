import { NextResponse, type NextRequest } from "next/server";

import { insightsRedirectPath } from "~/@/lib/ownership/insights-redirect";

/**
 * /ownership/insights is retired (spec 14.10): the explorer folded into the map, and every
 * link to it answers a permanent redirect to the map with the same view. A route handler,
 * not a page: it reads the link it redirects, per request, by design.
 */
export function GET(request: NextRequest) {
  const params = new URLSearchParams(request.nextUrl.search);
  return NextResponse.redirect(new URL(insightsRedirectPath(params), request.url), 308);
}
