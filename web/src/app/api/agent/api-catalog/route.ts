import { NextResponse } from "next/server";

export const dynamic = "force-static";

/**
 * RFC 9727 API catalog for automated agent discovery.
 * Served at /.well-known/api-catalog via a rewrite in next.config.mjs
 * (the app router ignores dot-prefixed folders, so the canonical
 * well-known path can't host a route handler directly).
 */
export function GET() {
  const base = "https://shorted.com.au";
  const catalog = {
    linkset: [
      {
        anchor: `${base}/api/`,
        "service-desc": [
          {
            href: `${base}/openapi.json`,
            type: "application/json",
            title: "Shorted Public API — OpenAPI 3.1 description",
          },
        ],
        "service-doc": [
          {
            href: `${base}/docs/api`,
            type: "text/html",
            title: "Shorted API documentation",
          },
        ],
        status: [{ href: `${base}/api/health` }],
      },
    ],
  };

  return NextResponse.json(catalog, {
    headers: {
      "Content-Type": "application/linkset+json",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
