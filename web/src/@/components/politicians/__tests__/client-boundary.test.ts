/**
 * A "use client" politician surface must not drag the generated protobuf module
 * across the client boundary.
 *
 * THIS HAS NOW BITTEN TWICE. The failure mode is documented in CLAUDE.md and is
 * uniquely horrible to diagnose: the build reports
 *
 *   Error: Element type is invalid: expected a string (for built-in components)
 *   or a class/function (for composite components) but got: undefined.
 *
 * with a minified digest and no file name. It took the whole static build of
 * /politicians down when politician-explorer.tsx imported PartyChip from
 * compliance.tsx — compliance has no "use client" directive and imports
 * RegisterHolder from ~/gen/…/politicians_pb, so the protobuf runtime followed
 * it into the client bundle.
 *
 * JEST DOES NOT CATCH THIS. Every component test passed while the production
 * build failed, because jest resolves the module graph without the RSC client
 * boundary. Only a structural check or a full build finds it — so here is the
 * structural check.
 *
 * The fix is always the same: import from `@/lib/politics/party-palette`, which
 * was split out of the heavy modules for exactly this reason and is pure data.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const COMPONENT_DIR = join(__dirname, "..");

function collect(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "__tests__" || entry === "__snapshots__") return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collect(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const FILES = collect(COMPONENT_DIR);

const CLIENT_FILES = FILES.filter((f) => {
  const src = readFileSync(f, "utf8");
  return /^\s*["']use client["']/m.test(src);
});

/**
 * Components that are NEVER server-rendered, and so cannot cause the prerender
 * failure this file exists to prevent.
 *
 * suburb-politician-property-card.tsx is reached only through its sibling
 * loader, which is `dynamic(…, { ssr: false })` — deliberately, and its comment
 * says why: it keeps politicians_pb in its own async chunk instead of the hot
 * /housing/[state]/[suburb] bundle. It never prerenders, so importing the
 * compliance kit costs bundle weight rather than breaking the build.
 *
 * The exemption is for the SSR rule only. It is listed here rather than filtered
 * out silently so that the trade-off stays visible, and the test below checks
 * the loader really is ssr:false rather than trusting this comment.
 */
const NEVER_SERVER_RENDERED = ["suburb-politician-property-card.tsx"];

/** Modules that pull @bufbuild/protobuf or @connectrpc/connect in behind them. */
const FORBIDDEN_IMPORT = /from\s+["'](~\/gen\/|@bufbuild\/protobuf|@connectrpc\/connect)/;

/**
 * compliance.tsx is server-side: no "use client", and it imports the generated
 * RegisterHolder enum. A client component importing it inherits that.
 */
const FORBIDDEN_TRANSITIVE = /from\s+["'][^"']*\/compliance["']/;

describe("politician client boundary", () => {
  it("finds the client components it means to check", () => {
    // A guard on the guard: if the discovery ever returns nothing, every
    // assertion below passes vacuously and the check silently stops working.
    expect(CLIENT_FILES.length).toBeGreaterThan(0);
  });

  it.each(CLIENT_FILES)("%s does not import generated protobuf modules", (file) => {
    const src = readFileSync(file, "utf8");
    const match = src.match(FORBIDDEN_IMPORT);
    expect(match?.[0] ?? null).toBeNull();
  });

  it.each(CLIENT_FILES.filter((f) => !NEVER_SERVER_RENDERED.some((n) => f.endsWith(n))))(
    "%s does not import the server-side compliance kit",
    (file) => {
      const src = readFileSync(file, "utf8");
      const match = src.match(FORBIDDEN_TRANSITIVE);
      expect(match?.[0] ?? null).toBeNull();
    },
  );

  it.each(NEVER_SERVER_RENDERED)("%s is genuinely never server-rendered", (name) => {
    // The exemption above is only sound while this holds. If someone drops the
    // loader or flips ssr back on, the exempted component starts prerendering
    // with the protobuf runtime behind it and takes a route's build down.
    const loader = readFileSync(
      join(COMPONENT_DIR, name.replace(/\.tsx$/, "-loader.tsx")),
      "utf8",
    );
    expect(loader).toMatch(/ssr:\s*false/);
  });

  it("compliance.tsx is still the server-side module this rule assumes", () => {
    // If someone adds "use client" to compliance.tsx the rule above becomes
    // unnecessary — and this test should be revisited rather than left asserting
    // something that no longer means anything.
    const compliance = readFileSync(join(COMPONENT_DIR, "compliance.tsx"), "utf8");
    expect(/^\s*["']use client["']/m.test(compliance)).toBe(false);
    expect(compliance).toMatch(/from\s+["']~\/gen\//);
  });
});
