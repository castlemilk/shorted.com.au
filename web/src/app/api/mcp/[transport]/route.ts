import { createMcpHandler } from "mcp-handler";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SHORTS_API_URL } from "~/app/actions/config";

export const maxDuration = 60;

// DEPRECATED — this is a compatibility shim, not the MCP server.
//
// The real server is Go, in-process with the API, at
// https://api.shorted.com.au/mcp: 24 tools across market, stock, discovery,
// news, housing, economy and politicians, plus resources and prompts, on
// protocol 2026-07-28. This route has four tools, calls the API back over
// HTTP through the WAF, and speaks whatever protocol the Vercel `mcp-handler`
// package supports.
//
// It is kept alive because existing client configurations point at it and
// deleting it would break them with a 404 and no explanation. Instead every
// tool result and the server instructions carry a pointer to the new endpoint,
// so a client (or the model driving it) is told where to go. Delete it only
// once traffic here is negligible.

const NEW_ENDPOINT = "https://api.shorted.com.au/mcp";
const MIGRATION_DOCS = "https://shorted.com.au/docs/mcp.md";
const DEPRECATION_NOTICE =
  `This endpoint is deprecated. Reconfigure this MCP server to ${NEW_ENDPOINT}, ` +
  `which serves 24 tools (market, stocks, discovery, news, housing, economy, ` +
  `politicians) plus resources and prompts, against the same data. ` +
  `Migration guide: ${MIGRATION_DOCS}`;

// All tools call the public Connect-RPC JSON endpoints server-side with
// plain fetch — never import @connectrpc/connect here (SSR/bundle hazard).

async function connectRpc<T>(method: string, body: unknown): Promise<T> {
  // .trim(): Vercel env vars can carry trailing newlines (documented gotcha).
  // Connect-Protocol-Version + a UA are required: api.shorted.com.au sits
  // behind the Cloudflare WAF, which serves an HTML 500 to bare fetches.
  const base = SHORTS_API_URL.trim();
  const res = await fetch(
    `${base}/shorts.v1alpha1.ShortedStocksService/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "User-Agent":
          "Mozilla/5.0 (compatible; ShortedMCP/1.0; +https://shorted.com.au)",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const snippet = (await res.text()).replace(/<[^>]+>/g, " ").slice(0, 120);
    throw new Error(`${method} failed: HTTP ${res.status} ${snippet}`);
  }
  return (await res.json()) as T;
}

// Every result carries the deprecation pointer. A notice only on `initialize`
// is read once by the client and never by the model; a notice in the payload
// is in front of whatever is actually doing the work, every call.
function textResult(data: unknown) {
  const payload =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? { _deprecated: DEPRECATION_NOTICE, _newEndpoint: NEW_ENDPOINT, ...data }
      : { _deprecated: DEPRECATION_NOTICE, _newEndpoint: NEW_ENDPOINT, data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const PERIODS = ["1m", "3m", "6m", "1y", "2y", "5y", "max"] as const;

// Schemas typed as ZodRawShape (not their literal types): the SDK's
// ShapeOutput<> conditional types recurse past TS's instantiation limit on
// zod 3.25 literal shapes (TS2589). Handler args are explicitly typed below;
// runtime validation still uses the full schemas.
const topShortsShape: z.ZodRawShape = {
  limit: z.number().int().min(1).max(100).optional()
    .describe("Number of stocks to return (1-100, default 20)"),
};
const stockShape: z.ZodRawShape = {
  code: z.string().regex(/^[A-Za-z0-9]{1,4}$/)
    .describe("ASX ticker code, 1-4 alphanumeric characters"),
};
const historyShape: z.ZodRawShape = {
  code: z.string().regex(/^[A-Za-z0-9]{1,4}$/)
    .describe("ASX ticker code, 1-4 alphanumeric characters"),
  period: z.enum(PERIODS).optional()
    .describe("History window (default 6m)"),
};
const treemapShape: z.ZodRawShape = {
  limit: z.number().int().min(1).max(25).optional()
    .describe("Stocks per industry (default 10)"),
};

type ToolResult = { content: Array<{ type: "text"; text: string }> };
type RegisterTool = (
  name: string,
  description: string,
  shape: z.ZodRawShape,
  cb: (args: unknown) => Promise<ToolResult>,
) => void;

const handler = createMcpHandler(
  (server: McpServer) => {
    // The SDK's ShapeOutput<> conditional types exceed TS's instantiation
    // depth with zod 3.25 (TS2589), so register through a plainly-typed
    // alias — runtime behaviour and validation are identical.
    const register = server.tool.bind(server) as unknown as RegisterTool;
    // Prefix every description, so a model choosing between this server and
    // the real one sees the deprecation at selection time rather than after
    // it has already spent a call here.
    const tool: RegisterTool = (name, description, shape, cb) =>
      register(name, `[DEPRECATED — see ${NEW_ENDPOINT}] ${description}`, shape, cb);
    tool(
      "get_top_shorts",
      "List the most shorted stocks on the ASX (Australian Securities Exchange), ranked by percentage of shares sold short. Data comes from official ASIC daily reports (T+4 delay). ETFs, bonds and non-equity instruments are excluded.",
      topShortsShape,
      async (args: unknown) => {
        const { limit } = args as { limit?: number };
        const data = await connectRpc<{
          timeSeries?: Array<{
            productCode?: string;
            name?: string;
            latestShortPosition?: number;
          }>;
        }>("GetTopShorts", { period: "max", limit: limit ?? 20, offset: 0, summaryOnly: true });
        const stocks = (data.timeSeries ?? []).map((t, i) => ({
          rank: i + 1,
          code: t.productCode,
          name: t.name,
          shortPercent: t.latestShortPosition,
          url: `https://shorted.com.au/shorts/${t.productCode}`,
        }));
        return textResult({ source: "ASIC short position reports (T+4)", stocks });
      },
    );

    tool(
      "get_stock",
      "Get the current short position summary for a single ASX stock by its ticker code (e.g. BHP, LOT, CBA): short interest %, reported short positions, total shares on issue, and industry.",
      stockShape,
      async (args: unknown) => {
        const { code } = args as { code: string };
        const data = await connectRpc<Record<string, unknown>>("GetStock", {
          productCode: code.toUpperCase(),
        });
        return textResult({
          ...data,
          url: `https://shorted.com.au/shorts/${code.toUpperCase()}`,
        });
      },
    );

    tool(
      "get_stock_history",
      "Get the short interest time series for an ASX stock over a period. Returns dated percentage-of-shares-shorted observations from ASIC reports.",
      historyShape,
      async (args: unknown) => {
        const { code, period } = args as { code: string; period?: (typeof PERIODS)[number] };
        const data = await connectRpc<{
          points?: Array<{ timestamp?: string; shortPosition?: number }>;
        }>("GetStockData", { productCode: code.toUpperCase(), period: period ?? "6m" });
        const points = data.points ?? [];
        // Cap the payload: agents need the shape, not 3,000 raw rows.
        const MAX_POINTS = 200;
        const step = Math.max(1, Math.ceil(points.length / MAX_POINTS));
        const sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
        return textResult({
          code: code.toUpperCase(),
          period,
          totalObservations: points.length,
          sampled: sampled.length,
          points: sampled.map((p) => ({
            date: p.timestamp,
            shortPercent: p.shortPosition,
          })),
        });
      },
    );

    tool(
      "get_industry_treemap",
      "Get short positions grouped by industry sector across the ASX — useful for questions like 'which sectors are most shorted'.",
      treemapShape,
      async (args: unknown) => {
        const { limit } = args as { limit?: number };
        const data = await connectRpc<Record<string, unknown>>(
          "GetIndustryTreeMap",
          { period: "3m", limit: limit ?? 10, viewMode: "CURRENT_CHANGE" },
        );
        return textResult(data);
      },
    );
  },
  {
    serverInfo: {
      // Name unchanged: client configs and saved tool grants key on it, and
      // renaming a deprecated server is a second breakage on top of the first.
      name: "shorted-asx-short-positions",
      version: "1.0.0-deprecated",
    },
    instructions: DEPRECATION_NOTICE,
  },
  {
    basePath: "/api/mcp",
    maxDuration: 60,
    verboseLogs: false,
  },
);

export { handler as GET, handler as POST, handler as DELETE };
