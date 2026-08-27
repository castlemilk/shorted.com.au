import { NextResponse } from "next/server";
import {
  SERVER_SHORTS_API_URL,
  serverFetchOutsideNextCache,
} from "~/app/actions/config";

// ISR rather than force-static: the card renders from the Go server's tool
// catalog, so it has to be re-fetched when the API ships new tools. An hour
// is well inside the deploy cadence and keeps the card cheap.
export const revalidate = 3600;

/**
 * MCP Server Card (SEP-1649 draft) for agent discovery.
 * Served at /.well-known/mcp/server-card.json via a rewrite in
 * next.config.mjs (app router ignores dot-prefixed folders).
 *
 * This used to hand-list four tools. By the time the Go MCP server shipped,
 * three of those names no longer existed and the endpoint they pointed at was
 * a deprecated shim — the same drift Phase 1 hit with the OpenAPI spec. It now
 * renders from `GET /mcp/catalog.json`, which the API generates from its own
 * tool registry, so a tool cannot be advertised here without being registered
 * there.
 *
 * Phase 2 is anonymous: `authentication.required` is false because it is true,
 * not as a placeholder. Phase 3 adds OAuth and revisits it.
 */

const SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/server-card.json";
const ENDPOINT = "https://api.shorted.com.au/mcp";
const CONTACT = "support@shorted.com.au";
const WEBSITE = "https://shorted.com.au";

interface CatalogTool {
  name: string;
  title?: string;
  description: string;
  domain?: string;
  rpc?: string;
  inputSchema?: unknown;
}

interface CatalogResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

interface CatalogPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface Catalog {
  server: {
    name: string;
    title?: string;
    version: string;
    description?: string;
    protocolVersion?: string;
    endpoint?: string;
    transport?: string;
    documentation?: string;
    website?: string;
    contact?: string;
  };
  authentication?: { required: boolean; note?: string };
  tools?: CatalogTool[];
  resources?: CatalogResource[];
  prompts?: CatalogPrompt[];
}

function isCatalog(value: unknown): value is Catalog {
  if (typeof value !== "object" || value === null) return false;
  const server = (value as { server?: unknown }).server;
  if (typeof server !== "object" || server === null) return false;
  return typeof (server as { name?: unknown }).name === "string";
}

async function fetchCatalog(): Promise<Catalog | null> {
  try {
    const res = await serverFetchOutsideNextCache(
      `${SERVER_SHORTS_API_URL.trim().replace(/\/+$/, "")}/mcp/catalog.json`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      console.error(`[mcp-server-card] catalog fetch: HTTP ${res.status}`);
      return null;
    }
    const body: unknown = await res.json();
    if (!isCatalog(body)) {
      console.error("[mcp-server-card] catalog fetch: unexpected shape");
      return null;
    }
    return body;
  } catch (error) {
    console.error("[mcp-server-card] catalog fetch failed:", error);
    return null;
  }
}

/**
 * The card we serve when the catalog is unreachable.
 *
 * Deliberately NOT a 500 and NOT a stale hardcoded tool list. A 500 breaks
 * client discovery entirely; a hardcoded list is the drift this rewrite
 * exists to remove. So: correct identity, correct endpoint, an empty tool
 * list, and `degraded: true` so a client can tell "we could not enumerate the
 * tools" apart from "there are no tools". Clients that connect to the endpoint
 * get the real `tools/list` regardless — the card is discovery, not the
 * contract.
 */
function minimalCard() {
  return {
    $schema: SCHEMA_URL,
    serverInfo: {
      name: "shorted-au-market-data",
      title: "Shorted — Australian market and public-interest data",
      version: "1.0.0",
      description:
        "Read-only Model Context Protocol access to Australian market and public-interest data: " +
        "ASIC short positions for ASX-listed stocks, house prices, ABS/RBA economic series, and the " +
        "federal register of politicians' interests.",
      websiteUrl: WEBSITE,
      documentationUrl: `${WEBSITE}/docs/mcp.md`,
    },
    transport: { type: "streamable-http", endpoint: ENDPOINT },
    protocolVersion: "2026-07-28",
    authentication: { required: false },
    capabilities: { tools: { listChanged: false } },
    tools: [] as unknown[],
    degraded: true,
    contact: CONTACT,
  };
}

export async function GET() {
  const catalog = await fetchCatalog();

  const card = catalog ? renderCard(catalog) : minimalCard();

  return NextResponse.json(card, {
    headers: {
      // Shorter than the old 24h: a degraded card should not be pinned for a
      // day, and the underlying catalog only changes on deploy anyway.
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}

function renderCard(catalog: Catalog) {
  const tools = catalog.tools ?? [];
  const resources = catalog.resources ?? [];
  const prompts = catalog.prompts ?? [];

  return {
    $schema: SCHEMA_URL,
    serverInfo: {
      name: catalog.server.name,
      title: catalog.server.title,
      version: catalog.server.version,
      description: catalog.server.description,
      websiteUrl: catalog.server.website ?? WEBSITE,
      documentationUrl: catalog.server.documentation ?? `${WEBSITE}/docs/mcp.md`,
    },
    transport: {
      type: catalog.server.transport ?? "streamable-http",
      endpoint: catalog.server.endpoint ?? ENDPOINT,
    },
    protocolVersion: catalog.server.protocolVersion ?? "2026-07-28",
    authentication: {
      required: catalog.authentication?.required ?? false,
      ...(catalog.authentication?.note
        ? { note: catalog.authentication.note }
        : {}),
    },
    capabilities: {
      tools: { listChanged: false },
      ...(resources.length ? { resources: { listChanged: false } } : {}),
      ...(prompts.length ? { prompts: { listChanged: false } } : {}),
    },
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      // Domain is not part of SEP-1649, but it is how a client (or a human
      // reading the card) groups 24 tools into something legible.
      domain: tool.domain,
      inputSchema: tool.inputSchema,
    })),
    ...(resources.length
      ? {
          resources: resources.map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            title: resource.title,
            description: resource.description,
            mimeType: resource.mimeType,
          })),
        }
      : {}),
    ...(prompts.length
      ? {
          prompts: prompts.map((prompt) => ({
            name: prompt.name,
            title: prompt.title,
            description: prompt.description,
            arguments: prompt.arguments,
          })),
        }
      : {}),
    contact: catalog.server.contact ?? CONTACT,
  };
}
