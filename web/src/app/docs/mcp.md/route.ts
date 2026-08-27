import { readFile } from "fs/promises";
import { NextResponse } from "next/server";
import path from "path";
import {
  SERVER_SHORTS_API_URL,
  serverFetchOutsideNextCache,
} from "~/app/actions/config";

// The connection guide for the MCP server, as plain markdown.
//
// The prose is a static file; the TOOL CATALOG at the bottom is fetched from
// the API's /mcp/catalog.json and rendered here, so this page cannot advertise
// a tool the server does not serve. That is the whole point — the server card
// used to hand-list four tools and was wrong about three of them.
//
// Note: cannot use the Edge runtime, we need fs/path.
export const revalidate = 3600;

interface CatalogTool {
  name: string;
  title?: string;
  description: string;
  domain?: string;
  rpc?: string;
}

interface CatalogPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; required?: boolean }>;
}

interface CatalogResource {
  uri: string;
  description?: string;
}

interface Catalog {
  toolCount?: number;
  tools?: CatalogTool[];
  prompts?: CatalogPrompt[];
  resources?: CatalogResource[];
}

const DOMAIN_TITLES: Record<string, string> = {
  market: "Market",
  stock: "Stock",
  discovery: "Discovery",
  news: "News",
  reports: "Reports",
  housing: "Housing",
  economy: "Economy",
  politics: "Politicians",
  politicians: "Politicians",
};

async function fetchCatalog(): Promise<Catalog | null> {
  try {
    const res = await serverFetchOutsideNextCache(
      `${SERVER_SHORTS_API_URL.trim().replace(/\/+$/, "")}/mcp/catalog.json`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as Catalog;
    return Array.isArray(body?.tools) ? body : null;
  } catch (error) {
    console.error("[docs/mcp.md] catalog fetch failed:", error);
    return null;
  }
}

function renderCatalog(catalog: Catalog): string {
  const lines: string[] = ["## Tool catalog", ""];

  const tools = catalog.tools ?? [];
  lines.push(
    `${tools.length} tools, live from ` +
      "[`/mcp/catalog.json`](https://api.shorted.com.au/mcp/catalog.json).",
    "",
  );

  const byDomain = new Map<string, CatalogTool[]>();
  for (const tool of tools) {
    const domain = tool.domain ?? "other";
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), tool]);
  }

  for (const [domain, domainTools] of byDomain) {
    lines.push(`### ${DOMAIN_TITLES[domain] ?? domain}`, "");
    for (const tool of domainTools) {
      // First sentence only: the full descriptions are long by design (they
      // carry the model's tool-selection guidance) and belong in the catalog,
      // not in a page a human reads top to bottom.
      const summary = (tool.description ?? "").split(/(?<=\.)\s/)[0] ?? "";
      lines.push(`- **\`${tool.name}\`** — ${summary}`);
    }
    lines.push("");
  }

  const resources = catalog.resources ?? [];
  if (resources.length) {
    lines.push("### Resources", "");
    for (const resource of resources) {
      lines.push(
        `- **\`${resource.uri}\`** — ${(resource.description ?? "").split(/(?<=\.)\s/)[0] ?? ""}`,
      );
    }
    lines.push("");
  }

  const prompts = catalog.prompts ?? [];
  if (prompts.length) {
    lines.push("### Prompts", "");
    for (const prompt of prompts) {
      const args = (prompt.arguments ?? [])
        .map((arg) => (arg.required ? arg.name : `${arg.name}?`))
        .join(", ");
      lines.push(
        `- **\`${prompt.name}(${args})\`** — ${(prompt.description ?? "").split(/(?<=\.)\s/)[0] ?? ""}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function GET() {
  let prose: string;
  try {
    // Deliberately NOT public/docs/mcp.md — a public file at the same path as
    // this route makes Next.js throw "conflicting public file and page file".
    prose = await readFile(
      path.join(process.cwd(), "public", "docs", "mcp-markdown.md"),
      "utf-8",
    );
  } catch {
    return NextResponse.json(
      { error: "Documentation not found" },
      { status: 404 },
    );
  }

  const catalog = await fetchCatalog();
  // Fail soft, same reasoning as the server card: connection instructions with
  // no tool table still get a client connected, and the client then reads the
  // real tools/list. A 500 helps nobody.
  const content = catalog
    ? `${prose.trimEnd()}\n\n${renderCatalog(catalog)}`
    : prose;

  return new NextResponse(content, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
      "X-Robots-Tag": "index, follow",
      "X-LLM-Friendly": "true",
      "X-AI-Indexable": "true",
      Link:
        '<https://api.shorted.com.au/mcp/catalog.json>; rel="service-desc"; type="application/json", ' +
        '</docs/api.md>; rel="alternate"; type="text/markdown"',
    },
  });
}
