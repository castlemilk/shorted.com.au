// Legacy `/shorts/:code?tab=<value>` deep links and the tab routes they now go to.
//
// No imports, on purpose. next.config.mjs imports this file, and so does
// scripts/tests/stock-tab-redirects.test.mjs, which runs in the repo-hygiene CI
// job where nothing under web/ is installed. That test cannot import
// next.config.mjs itself (it pulls in @next/mdx, rehype-prism-plus and the env
// validator), so everything it checks lives here.
//
// There is no `overview` entry, and there must not be one. A redirect from
// `/shorts/:code` to `/shorts/:code` loops: Next forwards the request's query
// string to the destination, so `?tab=overview` arrives again and matches the
// same rule (reproduced on Next 14.2.13). The old client reader treated
// `?tab=overview` as "stay on the Overview", and the page does the same: it
// renders for any value that is not in this map.

/**
 * Legacy `?tab=` value -> the tab route segment under `/shorts/:code/`.
 *
 * @type {Record<string, string>}
 */
export const stockTabRedirects = {
  news: "news",
  timeline: "news",
  financials: "financials",
  dividends: "financials",
  directors: "company",
  peers: "short-interest",
  community: "community",
};

/**
 * One permanent redirect per entry in the map, matched on the query at the
 * routing layer so no function runs. Every destination is a deeper path than
 * the source `/shorts/:code`, which that source cannot match again.
 *
 * @returns {{
 *   source: string,
 *   has: { type: string, key: string, value: string }[],
 *   destination: string,
 *   permanent: boolean,
 * }[]}
 */
export function legacyTabRedirects() {
  return Object.entries(stockTabRedirects).map(([tab, segment]) => ({
    source: "/shorts/:code",
    has: [{ type: "query", key: "tab", value: tab }],
    destination: `/shorts/:code/${segment}`,
    permanent: true,
  }));
}
