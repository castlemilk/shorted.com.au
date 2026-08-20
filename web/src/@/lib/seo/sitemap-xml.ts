/**
 * Sitemap XML serialisation + the child-sitemap registry.
 *
 * Deliberately DEPENDENCY-FREE (no connect-rpc, no protobuf, no data fetches):
 * `/sitemap.xml` is now a sitemapindex that must stay cheap and static-safe,
 * so it imports only this file. All data fetching lives in
 * `sitemap-sections.ts`, which only the child routes import.
 */

export type SitemapEntry = {
  url: string;
  /**
   * Omitted deliberately when we have no honest change signal. A fabricated
   * lastmod (the same deploy/data constant on every URL) makes Google discard
   * lastmod for the WHOLE sitemap — that was the pre-August-2026 behaviour.
   */
  lastModified?: string;
};

/**
 * The child sitemaps referenced by /sitemap.xml, in crawl-priority order.
 *
 * URL MAP — every URL that used to live in the single flat urlset now lives in
 * exactly ONE of these (see the builder in sitemap-sections.ts for each):
 *
 *   core        static marketing + /top + /statistics + /battlegrounds +
 *               /seasonality + /screener + /scans(+slugs) + /industry(+slugs) +
 *               /industry-intelligence + /glossary(+terms) + /directory(+a–z) +
 *               /market(+dated snapshots) + /learn(+articles) + /blog(+posts) +
 *               /authors(+slugs) + /docs/* + /faq + /privacy + /data + /press +
 *               /economy(+states) + /features/* + /news + /news/[slug] takes
 *   shorts      /shorts + /shorts/[code] + /shorts/[code]/news +
 *               /insider-trading(+[code]) + /compare(+/compare/[pair])
 *   reports     /reports + weekly/monthly/yearly report pages
 *   housing     /housing + /housing/calculators + /price-drops +
 *               /housing/[state] + /housing/[state]/[suburb]
 *   politicians /politicians hubs + /politicians/[slug]
 *
 * Removed vs the flat sitemap: /developer (auth-gated dashboard stub — it
 * renders a spinner for anonymous crawlers).
 * Added: /docs/api, /docs/api/[endpoint], /docs/api/clients/[language].
 */
export const SITEMAP_CHILDREN = [
  "sitemap-core.xml",
  "sitemap-shorts.xml",
  "sitemap-reports.xml",
  "sitemap-housing.xml",
  "sitemap-politicians.xml",
] as const;

export type SitemapChild = (typeof SITEMAP_CHILDREN)[number];

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Normalise Date | string | undefined to a W3C datetime string. */
export function toLastMod(value: Date | string | undefined | null): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return value;
}

/** Newest of a set of lastmods (used for hub pages over a collection). */
export function newestLastMod(
  values: Array<string | undefined>,
): string | undefined {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

/**
 * Drop repeat <loc>s, keeping the first (and its lastmod).
 *
 * Not theoretical: the glossary term list contains a duplicate slug
 * (short-interest-ratio), so the old flat sitemap shipped that URL twice.
 */
export function dedupeEntries(entries: SitemapEntry[]): SitemapEntry[] {
  const seen = new Set<string>();
  const out: SitemapEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
  }
  return out;
}

export function renderUrlset(input: SitemapEntry[]): string {
  const body = dedupeEntries(input)
    .map((entry) => {
      const lastmod = entry.lastModified
        ? `\n    <lastmod>${xmlEscape(entry.lastModified)}</lastmod>`
        : "";
      return `  <url>\n    <loc>${xmlEscape(entry.url)}</loc>${lastmod}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function renderSitemapIndex(
  children: Array<{ url: string; lastModified?: string }>,
): string {
  const body = children
    .map((child) => {
      const lastmod = child.lastModified
        ? `\n    <lastmod>${xmlEscape(child.lastModified)}</lastmod>`
        : "";
      return `  <sitemap>\n    <loc>${xmlEscape(child.url)}</loc>${lastmod}\n  </sitemap>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

/** Shared response shape for every sitemap route. */
export function sitemapResponse(xml: string): Response {
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      // Edge/CDN caching only — the origin render stays dynamic so a deploy
      // never bakes a degenerate build-time fallback (July 2026 GSC regression).
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
