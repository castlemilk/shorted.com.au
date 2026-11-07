/**
 * The private API docs bundle (docs.generated.ts) is the admin console's only
 * copy of the private documents. These pin that it matches its sources, that
 * nothing publishes them, and that only the admin page reads them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { PRIVATE_DOCS } from "../docs.generated";

const WEB = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(WEB, p), "utf8");

const SOURCES: Record<string, string> = {
  "market-moves": "src/server/private-docs/market-moves-api.md",
  "private-api": "src/server/private-docs/private-api.md",
  "admin-mcp": "../docs/mcp-admin.md",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("the private API docs bundle", () => {
  it("holds the three documents, in order", () => {
    expect(PRIVATE_DOCS.map((d) => d.slug)).toEqual(["market-moves", "private-api", "admin-mcp"]);
  });

  it.each(Object.entries(SOURCES))("is up to date with %s (run npm run docs:private)", (slug, file) => {
    const doc = PRIVATE_DOCS.find((d) => d.slug === slug);
    expect(doc?.markdown).toBe(read(file));
  });

  it("is not published: nothing of it is under public/", () => {
    const publicFiles = readdirSync(path.join(WEB, "public/docs"));
    expect(publicFiles.filter((f) => /private|market-moves/.test(f))).toEqual([]);
    expect(read("public/openapi.json")).not.toContain("/v1/market-moves");
    expect(read("public/openapi.json")).not.toContain("SaveStrategy");
  });

  it("is read only by the admin page", () => {
    const readers = walk(path.join(WEB, "src"))
      .filter((f) => !f.endsWith("docs.generated.ts"))
      .filter((f) => /private-docs\/docs\.generated/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(WEB, f));
    expect(readers).toEqual(["src/app/admin/api-docs/page.tsx"]);
  });

  it("the admin page gates on requireAdmin, renders per request and is not indexed", () => {
    const page = read("src/app/admin/api-docs/page.tsx");
    expect(page).toMatch(/await requireAdmin\(\);/);
    expect(page).toMatch(/export const dynamic = "force-dynamic";/);
    expect(page).toMatch(/robots: \{ index: false, follow: false \}/);
    expect(page).not.toMatch(/^["']use client["']/);
  });

  it("documents the posting API and only private rpcs", () => {
    const moves = PRIVATE_DOCS[0].markdown;
    expect(moves).toContain("POST /v1/market-moves");
    expect(moves).toContain("POST /v1/market-moves/retract");
    expect(moves).toContain("/admin/market-moves");
    const rpcs = PRIVATE_DOCS[1].markdown;
    expect(rpcs).toContain("/shorts.v1alpha1.MarketService/GetSyncStatus");
    expect(rpcs).toContain("/shorts.v1alpha1.EnrichmentService/ListPendingEnrichments");
    expect(rpcs).toContain("Who may call it: an administrator");
    expect(rpcs).not.toContain("/shorts.v1alpha1.MarketService/GetTopShorts");
    expect(rpcs).not.toContain("HandleStripe");
  });

  it("carries no secret", () => {
    for (const doc of PRIVATE_DOCS) {
      expect(doc.markdown).not.toMatch(/smm_[A-Za-z0-9_-]{43}/);
      expect(doc.markdown).not.toMatch(/sk_live_|whsec_|-----BEGIN/);
    }
  });
});
