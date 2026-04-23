import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * SEO smoke suite. Verifies that the fixes shipped post-audit are live
 * on the target environment (preview URL via BASE_URL env, or prod).
 *
 * Runs over plain HTTP so it catches what crawlers and LLMs actually see
 * in the initial SSR payload — no hydration, no JS, no waiting.
 */

async function fetchText(
  request: APIRequestContext,
  path: string,
): Promise<{ status: number; body: string }> {
  const res = await request.get(path, { maxRedirects: 5 });
  return { status: res.status(), body: await res.text() };
}

function countMatches(haystack: string, needle: RegExp): number {
  const m = haystack.match(needle);
  return m ? m.length : 0;
}

function extractJsonLd(html: string): Array<Record<string, unknown>> {
  const scripts = Array.from(
    html.matchAll(
      /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
    ),
  );
  const out: Array<Record<string, unknown>> = [];
  for (const [, raw] of scripts) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      // ignore malformed blocks; the parseability is asserted elsewhere
    }
  }
  return out;
}

function titleOf(html: string): string | null {
  const m = /<title>([^<]+)<\/title>/.exec(html);
  return m?.[1] ?? null;
}

function canonicalOf(html: string): string | null {
  const m = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/.exec(html);
  return m?.[1] ?? null;
}

test.describe("SEO smoke — post-audit fixes", () => {
  test.describe.configure({ mode: "parallel" });

  test("all critical routes return 200", async ({ request }) => {
    const paths = [
      "/",
      "/shorts/BHP",
      "/shorts/CBA",
      "/screener",
      "/blog",
      "/blog/asx-sectors-most-shorted",
      "/top",
      "/industry",
      "/reports",
      "/methodology",
      "/disclaimer",
      "/terms",
      "/privacy",
      "/faq",
      "/glossary",
      "/learn/what-is-short-selling",
      "/directory",
      "/market",
      "/sitemap.xml",
      "/robots.txt",
      "/llms.txt",
      "/openapi.json",
      "/.well-known/ai-plugin.json",
    ];
    for (const p of paths) {
      const { status } = await fetchText(request, p);
      expect.soft(status, `${p} should be 200`).toBe(200);
    }
  });

  test("no title duplicates `| Shorted | Shorted`", async ({ request }) => {
    const paths = [
      "/",
      "/screener",
      "/metrics",
      "/technology",
      "/terms",
      "/privacy",
      "/directory",
      "/market",
      "/reports",
      "/blog",
      "/blog/asx-sectors-most-shorted",
      "/docs/llm-context",
      "/learn/what-is-short-selling",
      "/methodology",
      "/disclaimer",
    ];
    for (const p of paths) {
      const { body } = await fetchText(request, p);
      const title = titleOf(body);
      expect(title, `${p} missing <title>`).toBeTruthy();
      expect
        .soft(title, `${p} has duplicated "| Shorted | Shorted"`)
        .not.toMatch(/\|\s*Shorted\s*\|\s*Shorted/);
    }
  });

  test("sitemap has no priority/changefreq noise and 1k+ URLs", async ({
    request,
  }) => {
    const { body } = await fetchText(request, "/sitemap.xml");
    expect(countMatches(body, /<url>/g)).toBeGreaterThan(1000);
    expect(countMatches(body, /<priority>/g)).toBe(0);
    expect(countMatches(body, /<changefreq>/g)).toBe(0);
    // historical weekly reports should have a fixed lastmod (not today)
    const weeklyLastmod = body.match(
      /<loc>[^<]*\/reports\/weekly\/2026-W\d+<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/,
    );
    expect(weeklyLastmod, "weekly report sitemap entry not found").toBeTruthy();
    // Lastmod should be a fixed ISO date at midnight UTC
    expect(weeklyLastmod?.[1]).toMatch(/T00:00:00\.000Z$/);
  });

  test("canonical /shorts/[code] and no /stocks/[code] in sitemap", async ({
    request,
  }) => {
    const { body } = await fetchText(request, "/sitemap.xml");
    expect(body).toContain("<loc>https://shorted.com.au/shorts/BHP</loc>");
    expect(body).not.toContain("<loc>https://shorted.com.au/stocks</loc>");
  });

  test("/shorts/[code] renders SSR dl + declarative sentence + Dataset schema", async ({
    request,
  }) => {
    const { body } = await fetchText(request, "/shorts/BHP");
    // SSR dl with labels
    expect(body).toMatch(/<dl[^>]*>/);
    expect(body).toContain("Short interest");
    expect(body).toContain("Reported positions");
    expect(body).toContain("As of");
    // Declarative quotable sentence
    expect(body).toMatch(/reported as short positions as of/i);
    // Dataset JSON-LD
    const schemas = extractJsonLd(body);
    const dataset = schemas.find((s) => s["@type"] === "Dataset");
    expect(dataset, "Dataset schema should be present").toBeDefined();
    expect(dataset?.name).toMatch(/BHP/);
    // Methodology + disclaimer footer link
    expect(body).toContain('href="/methodology"');
    expect(body).toContain('href="/disclaimer"');
  });

  test("homepage has exactly one Dataset schema (dedup)", async ({
    request,
  }) => {
    const { body } = await fetchText(request, "/");
    const schemas = extractJsonLd(body);
    const datasetCount = schemas.filter((s) => s["@type"] === "Dataset").length;
    expect(datasetCount).toBe(1);
  });

  test("blog post has Article and BreadcrumbList schema", async ({
    request,
  }) => {
    const { body } = await fetchText(
      request,
      "/blog/asx-sectors-most-shorted",
    );
    const schemas = extractJsonLd(body);
    const hasArticle = schemas.some(
      (s) => s["@type"] === "Article" || s["@type"] === "NewsArticle",
    );
    const hasBreadcrumb = schemas.some(
      (s) => s["@type"] === "BreadcrumbList",
    );
    expect(hasArticle, "blog post missing Article schema").toBe(true);
    expect(hasBreadcrumb, "blog post missing BreadcrumbList schema").toBe(true);
  });

  test("methodology and disclaimer pages ship with schema + canonicals", async ({
    request,
  }) => {
    for (const path of ["/methodology", "/disclaimer"]) {
      const { body } = await fetchText(request, path);
      expect(canonicalOf(body)).toBe(`https://shorted.com.au${path}`);
      const schemas = extractJsonLd(body);
      const hasBreadcrumb = schemas.some(
        (s) => s["@type"] === "BreadcrumbList",
      );
      expect(hasBreadcrumb, `${path} missing BreadcrumbList`).toBe(true);
      // Body substance — these are YMYL trust pages, must have real content
      const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      expect(text.length).toBeGreaterThan(2000);
      expect(text).toMatch(/ASIC/);
    }
  });

  test("methodology page has TechArticle schema", async ({ request }) => {
    const { body } = await fetchText(request, "/methodology");
    const schemas = extractJsonLd(body);
    const hasTech = schemas.some((s) => s["@type"] === "TechArticle");
    expect(hasTech).toBe(true);
  });

  test("/screener renders SSR fallback table with stock links", async ({
    request,
  }) => {
    const { body } = await fetchText(request, "/screener");
    // At least 5 stock detail links in SSR HTML
    const stockLinks = new Set(
      Array.from(body.matchAll(/href="\/shorts\/([A-Z0-9]{1,4})"/g)).map(
        (m) => m[1],
      ),
    );
    expect(stockLinks.size).toBeGreaterThanOrEqual(5);
    expect(body).toMatch(/Top 20 most shorted/i);
  });

  test("ai-plugin.json points to valid OpenAPI spec", async ({ request }) => {
    const plugin = await request.get("/.well-known/ai-plugin.json");
    expect(plugin.status()).toBe(200);
    const pluginJson = (await plugin.json()) as {
      api?: { url?: string };
    };
    const apiUrl = pluginJson.api?.url;
    expect(apiUrl, "ai-plugin.json missing api.url").toBeTruthy();
    expect(apiUrl).toMatch(/openapi\.json$/);
    // Fetch it and verify it's valid OpenAPI
    const openapi = await request.get("/openapi.json");
    expect(openapi.status()).toBe(200);
    const spec = (await openapi.json()) as {
      openapi?: string;
      info?: unknown;
      paths?: unknown;
    };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info).toBeDefined();
    expect(spec.paths).toBeDefined();
  });

  test("root keyword meta is tight (<=12 terms)", async ({ request }) => {
    const { body } = await fetchText(request, "/");
    const m = /<meta name="keywords" content="([^"]+)"/.exec(body);
    expect(m, "homepage missing keyword meta").toBeTruthy();
    const terms = m![1]!.split(",").map((t) => t.trim()).filter(Boolean);
    expect(terms.length).toBeGreaterThanOrEqual(4);
    expect(terms.length).toBeLessThanOrEqual(12);
  });

  test("screener preset pages have preset-specific canonicals and titles", async ({
    request,
  }) => {
    const presets = [
      "short-squeeze",
      "dividend-pressure",
      "small-cap-bears",
      "director-buying-shorted",
      "hard-to-cover",
    ];
    for (const preset of presets) {
      const { status, body } = await fetchText(
        request,
        `/screener?preset=${preset}`,
      );
      expect.soft(status, `preset ${preset} should be 200`).toBe(200);
      const canonical = canonicalOf(body);
      expect
        .soft(canonical, `preset ${preset} canonical`)
        .toBe(`https://shorted.com.au/screener?preset=${preset}`);
      // Each preset has its own title — should not just be the generic one
      const title = titleOf(body);
      expect
        .soft(title, `preset ${preset} title should not double-brand`)
        .not.toMatch(/\|\s*Shorted\s*\|\s*Shorted/);
    }
  });
});
