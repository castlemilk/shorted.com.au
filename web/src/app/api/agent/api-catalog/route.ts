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
  // The Go MCP server, in-process with the API. NOT `${base}/api/mcp/mcp` —
  // that route is a deprecated four-tool shim, and advertising it here would
  // send every RFC 9727 discovery straight to the thing we are retiring.
  const mcpEndpoint = "https://api.shorted.com.au/mcp";
  const mcpCatalog = "https://api.shorted.com.au/mcp/catalog.json";
  const mcpServerCard = `${base}/.well-known/mcp/server-card.json`;

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
          {
            href: `${base}/openapi.yaml`,
            type: "application/yaml",
            title: "Shorted Public API — OpenAPI 3.1 description (YAML)",
          },
        ],
        "service-doc": [
          {
            href: `${base}/docs/api`,
            type: "text/html",
            title: "Shorted API documentation",
          },
          {
            href: `${base}/docs/api.md`,
            type: "text/markdown",
            title:
              "Shorted API documentation (markdown, no JavaScript required)",
          },
        ],
        describedby: [
          {
            href: `${base}/llms.txt`,
            type: "text/plain",
            title: "Site and dataset overview for language models",
          },
          {
            href: `${base}/llms-full.txt`,
            type: "text/plain",
            title:
              "Extended site and dataset documentation for language models",
          },
        ],
        // The MCP server is a sibling machine-readable surface over the same
        // data, not a description OF this API — so it hangs off `related`
        // (IANA-registered, RFC 4287) rather than `service-desc`. It gets its
        // own anchor below, where `service-desc` legitimately points at the
        // server card that describes it.
        related: [
          {
            href: mcpEndpoint,
            type: "application/json",
            title:
              "Shorted MCP server — Model Context Protocol (streamable HTTP)",
          },
          {
            href: mcpServerCard,
            type: "application/json",
            title: "Shorted MCP server card",
          },
          {
            href: mcpCatalog,
            type: "application/json",
            title: "Shorted MCP tool catalog",
          },
        ],
        status: [{ href: `${base}/api/health` }],
      },
      {
        anchor: mcpEndpoint,
        "service-desc": [
          {
            href: mcpServerCard,
            type: "application/json",
            title: "Shorted MCP server card (SEP-1649)",
          },
        ],
        "service-doc": [
          {
            href: `${base}/docs/mcp.md`,
            type: "text/markdown",
            title: "Connecting to the Shorted MCP server",
          },
          {
            href: `${base}/docs/api`,
            type: "text/html",
            title: "Shorted API documentation",
          },
        ],
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
