#!/usr/bin/env node
// ISR gate for the stock segment and the ownership pages: the three dynamic
// ownership routes and the nine static ones.
//
// Every route under /shorts/[stockCode] must be on-demand ISR: generated on
// first request and served from the cache for `revalidate` seconds. A route
// that Next renders on every request runs a function per page view, the one
// regression the stock page's cost model cannot survive.
//
// Per-request routes never appear in .next/prerender-manifest.json; ISR
// dynamic routes appear under `dynamicRoutes`. So presence there is the test.
// Run after `next build`:
//   node scripts/route-kinds.mjs [--manifest .next/prerender-manifest.json]
//
// What it sees, measured on Next 14.2.13 and on a Next 15.5 test build: a page
// that lost its generateStaticParams export, or sets `revalidate = 0` or
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
//
// The ownership section has three dynamic routes, the institution page
// /ownership/[slug], the register /ownership/stocks/[code] and the fund page
// /ownership/funds/[fund] (OWNERSHIP_ROUTES below), under the same rule. Their reads are caught from
// source, in a file under app/ownership, by
//   web/src/app/ownership/__tests__/isr-source-safety.test.ts
// A read in a module imported from outside that folder is beyond both, as for
// the stock segment, and needs a request-level check.
//
// The nine static ownership pages, the hub /ownership, the notice feed
// /ownership/notices, the register list /ownership/stocks and the six
// workspace pages (map, connections, activity, funds, holders, changes;
// OWNERSHIP_STATIC_ROUTES below), have no dynamic segment, so none is in
// dynamicRoutes. Next writes an ISR page of that kind under `routes`, with its
// revalidate in initialRevalidateSeconds: a number for an ISR page, false for
// one with no revalidate. That entry is what this gate reads. A request-time
// read that runs during such a page's build render makes Next render it per
// request, so it drops out of `routes` and this gate fails. A read on a branch
// the build render does not take is caught only from source, and only in a
// file under app/ownership (the scan named above). A read in a module imported
// from outside that folder is beyond the scan, and on such a branch beyond this
// gate too: it needs a request-level check (a second request answering
// x-nextjs-cache: HIT). Each static page's own file is also checked for
// request-time reads, by
//   web/src/app/__tests__/isr-hubs.test.ts

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

// The three dynamic routes of the ownership section, the institution page, the
// register and the fund page. All export generateStaticParams with dynamicParams
// on, so a slug, code or fund Next cannot prerender renders on its first request
// and is cached for its revalidate, as the stock tabs are.
export const OWNERSHIP_ROUTES = ["/ownership/[slug]", "/ownership/stocks/[code]", "/ownership/funds/[fund]"];

// The nine static ownership pages: the hub, the notice feed, the register list and
// the six workspace pages. Each exports a revalidate and takes no dynamic segment,
// so each is listed under `routes` (see the header).
export const OWNERSHIP_STATIC_ROUTES = [
  "/ownership",
  "/ownership/notices",
  "/ownership/stocks",
  "/ownership/map",
  "/ownership/connections",
  "/ownership/activity",
  "/ownership/funds",
  "/ownership/holders",
  "/ownership/changes",
];

export function missingIsrRoutes(manifest, expected = STOCK_ROUTES) {
  const dynamicRoutes = manifest?.dynamicRoutes ?? {};
  return expected.filter((route) => !(route in dynamicRoutes));
}

// A static page is ISR when `routes` lists it with a positive number of seconds.
// Under dynamicRoutes it is not static at all, whatever `routes` says.
export function missingStaticIsrRoutes(manifest, expected = OWNERSHIP_STATIC_ROUTES) {
  const routes = manifest?.routes ?? {};
  const dynamicRoutes = manifest?.dynamicRoutes ?? {};
  return expected.filter((route) => {
    const seconds = routes[route]?.initialRevalidateSeconds;
    return !(typeof seconds === "number" && seconds > 0) || route in dynamicRoutes;
  });
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
  // Every list is checked before the verdict, so a manifest that slips on several names every route it lost.
  let failed = false;
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
    failed = true;
  } else {
    console.log(`route-kinds: ${STOCK_ROUTES.length} stock routes are ISR.`);
  }
  const missingOwnership = missingIsrRoutes(manifest, OWNERSHIP_ROUTES);
  if (missingOwnership.length) {
    console.error("route-kinds: these ownership routes are NOT ISR (absent from prerender-manifest dynamicRoutes):");
    for (const r of missingOwnership) console.error(`  ${r}`);
    console.error(
      "A page under /ownership/[slug], /ownership/stocks/[code] or /ownership/funds/[fund] has lost its generateStaticParams export, or sets " +
        'revalidate = 0 or dynamic = "force-dynamic".',
    );
    console.error(
      "The reads this gate cannot see are checked from source, in a file under app/ownership: " +
        "web/src/app/ownership/__tests__/isr-source-safety.test.ts.",
    );
    failed = true;
  } else {
    console.log(`route-kinds: ${OWNERSHIP_ROUTES.length} ownership routes are ISR.`);
  }
  const missingStatic = missingStaticIsrRoutes(manifest);
  if (missingStatic.length) {
    console.error(
      "route-kinds: these static ownership pages are NOT ISR (no positive initialRevalidateSeconds under prerender-manifest routes, or listed under dynamicRoutes):",
    );
    for (const r of missingStatic) console.error(`  ${r}`);
    console.error(
      "A static page under /ownership (the hub, the notice feed, the register list or a workspace page) has lost its `export const revalidate` " +
        "(Next then builds it once and never regenerates it), or sets revalidate = 0 or " +
        'dynamic = "force-dynamic", or reads a request-time API during its build render ' +
        "(Next then renders it per request).",
    );
    console.error(
      "The reads this gate cannot see are checked from source too, in a file under app/ownership: " +
        "web/src/app/ownership/__tests__/isr-source-safety.test.ts.",
    );
    failed = true;
  } else {
    console.log(`route-kinds: ${OWNERSHIP_STATIC_ROUTES.length} static ownership routes are ISR.`);
  }
  return failed ? 1 : 0;
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
