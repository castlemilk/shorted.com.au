import { NextResponse } from "next/server";

export const dynamic = "force-static";

/**
 * MCP Server Card (SEP-1649 draft) for agent discovery.
 * Served at /.well-known/mcp/server-card.json via a rewrite in
 * next.config.mjs (app router ignores dot-prefixed folders).
 */
export function GET() {
  const card = {
    $schema:
      "https://static.modelcontextprotocol.io/schemas/server-card.json",
    serverInfo: {
      name: "shorted-asx-short-positions",
      title: "Shorted — ASX Short Position Data",
      version: "1.0.0",
      description:
        "Read-only access to official ASIC short-selling data for ASX-listed stocks: most-shorted rankings, per-stock short interest, full history since 2010, and industry breakdowns. Data updates daily with a T+4 trading-day delay.",
      websiteUrl: "https://shorted.com.au",
    },
    transport: {
      type: "streamable-http",
      endpoint: "https://shorted.com.au/api/mcp/mcp",
    },
    authentication: { required: false },
    capabilities: { tools: { listChanged: false } },
    tools: [
      { name: "get_top_shorts", description: "Most shorted ASX stocks, ranked" },
      { name: "get_stock", description: "Current short position for one ASX ticker" },
      { name: "get_stock_history", description: "Short interest time series for a ticker" },
      { name: "get_industry_treemap", description: "Short positions grouped by industry" },
    ],
    contact: "support@shorted.com.au",
  };

  return NextResponse.json(card, {
    headers: { "Cache-Control": "public, max-age=86400" },
  });
}
