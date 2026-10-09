#!/usr/bin/env node
// ISR gate for the stock segment.
//
// Every route under /shorts/[stockCode] must be on-demand ISR: generated on
// first request and served from the cache for `revalidate` seconds. A route
// that Next renders on every request runs a function per page view — the one
// regression the stock page's cost model cannot survive.
//
// Per-request routes never appear in .next/prerender-manifest.json; ISR
// dynamic routes appear under `dynamicRoutes`. So presence there is the test.
// Run after `next build`:
//   node scripts/route-kinds.mjs [--manifest .next/prerender-manifest.json]
//
// What it sees, measured on Next 14.2.13: a page that lost its
// generateStaticParams export, or sets `revalidate = 0` or
// `dynamic = "force-dynamic"`, drops out of dynamicRoutes. What it cannot see:
// a read of cookies(), headers(), searchParams or a no-store fetch under a page
// that keeps its (empty) generateStaticParams. Next renders nothing at build
// time for an empty list, so such a route stays listed and fails at request
// time instead (a 500 under `next start`). Those reads are caught from source by
//   web/src/app/shorts/__tests__/isr-source-safety.test.ts
// (Jest, in the web test run), which also requires every tab page to keep its
// revalidate, dynamicParams and generateStaticParams exports. A read inside a
// component imported from outside the segment is beyond both and needs a
// request-level check.

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STOCK_ROUTES = [
  "/shorts/[stockCode]",
  "/shorts/[stockCode]/short-interest",
  "/shorts/[stockCode]/strategy",
  "/shorts/[stockCode]/financials",
  "/shorts/[stockCode]/company",
  "/shorts/[stockCode]/news",
  "/shorts/[stockCode]/community",
];

export function missingIsrRoutes(manifest, expected = STOCK_ROUTES) {
  const dynamicRoutes = manifest?.dynamicRoutes ?? {};
  return expected.filter((route) => !(route in dynamicRoutes));
}

function main(argv) {
  const i = argv.indexOf("--manifest");
  const path = resolve(i >= 0 ? argv[i + 1] : ".next/prerender-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`route-kinds: cannot read ${path}: ${err.message}. Run \`next build\` first.`);
    return 2;
  }
  const missing = missingIsrRoutes(manifest);
  if (missing.length) {
    console.error("route-kinds: these stock routes are NOT ISR (absent from prerender-manifest dynamicRoutes):");
    for (const r of missing) console.error(`  ${r}`);
    console.error(
      "A page or layout under /shorts/[stockCode] has lost its generateStaticParams export, or sets " +
        'revalidate = 0 or dynamic = "force-dynamic". (With a non-empty generateStaticParams, a ' +
        "searchParams/cookies/headers read drops a route out too.)",
    );
    console.error(
      "With the empty generateStaticParams every tab exports, such a read does not show up here: " +
        "web/src/app/shorts/__tests__/isr-source-safety.test.ts is the check for it.",
    );
    return 1;
  }
  console.log(`route-kinds: ${STOCK_ROUTES.length} stock routes are ISR.`);
  return 0;
}

// Run only when executed directly, not when imported. Both sides go through
// realpath: Node resolves the entry module's symlinks for import.meta.url but
// leaves process.argv[1] as typed, so a checkout reached through a symlink
// (macOS /tmp and /var are) or a path with a space would otherwise skip main()
// and exit 0 having checked nothing.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exit(main(process.argv.slice(2)));
}
