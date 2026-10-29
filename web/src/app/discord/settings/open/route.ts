import { NextResponse, type NextRequest } from "next/server";

import {
  SETTINGS_COOKIE,
  SETTINGS_PAGE_PATH,
  readSettingsGrant,
} from "~/@/lib/discord/settings-link";

/**
 * Where `/settings`'s link lands (settings-link.ts). It moves the signed token
 * out of the URL into an httpOnly cookie that only the settings page and its
 * actions receive, then redirects to the page's clean URL, so the token is not
 * left in the address bar, the history, or the page view analytics records.
 *
 * The cookie lives as long as the grant and no longer. A link that is expired
 * or forged clears any earlier one, so the page says the link has expired
 * rather than quietly editing what an older link granted.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("t");
  const grant = readSettingsGrant(token);
  const page = new URL(SETTINGS_PAGE_PATH, request.url);
  if (!grant) page.searchParams.set("link", "expired");

  const response = NextResponse.redirect(page, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (grant && token) {
    response.cookies.set(SETTINGS_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: SETTINGS_PAGE_PATH,
      maxAge: Math.max(0, grant.expiresAt - Math.floor(Date.now() / 1000)),
    });
  } else {
    response.cookies.set(SETTINGS_COOKIE, "", {
      path: SETTINGS_PAGE_PATH,
      maxAge: 0,
    });
  }
  return response;
}
