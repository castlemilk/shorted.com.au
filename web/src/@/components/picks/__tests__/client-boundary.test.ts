/**
 * The stock picker kit must stay composable from a client island.
 *
 * app/picks/[strategy]/picks-sorted-view.tsx is a "use client" island that
 * renders the filter view and the table (and the stock page's Strategy fit
 * card renders the table's pills and dots), and any future island may compose
 * the strategy panel. If a kit file imported
 * the generated protobuf modules or @connectrpc (directly or one hop away), the
 * protobuf runtime would follow it into the client bundle and the static build
 * would die with the undiagnosable "Element type is invalid" digest: the exact
 * failure that took /politicians down (see
 * ../../politicians/__tests__/client-boundary.test.ts). JEST DOES NOT CATCH
 * THAT; only a structural check or a full build does, so here is the check.
 *
 * It is TRANSITIVE: it follows every relative and aliased import from each kit
 * file through the rest of src/ and fails if the walk reaches ~/gen, the
 * protobuf runtime, @connectrpc, or a server action.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const COMPONENT_DIR = join(__dirname, "..");
/** `src/`: the root every path alias in tsconfig.json resolves against. */
const SRC_DIR = join(__dirname, "..", "..", "..", "..");
/** The /picks/[strategy] route: the sort island and its lazy fetch module. */
const ROUTE_DIR = join(SRC_DIR, "app", "picks", "[strategy]");
const ISLAND = join(ROUTE_DIR, "picks-sorted-view.tsx");
const SORT_FETCH = join(ROUTE_DIR, "picks-sort-fetch.ts");

const KIT_FILES = readdirSync(COMPONENT_DIR)
  .filter((entry) => /\.tsx?$/.test(entry))
  .map((entry) => join(COMPONENT_DIR, entry));

const FORBIDDEN_PACKAGES = /^(?:@bufbuild\/protobuf|@connectrpc\/)/;
const FORBIDDEN_LOCAL = [join(SRC_DIR, "gen"), join(SRC_DIR, "app", "actions")];

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
/** `import("./x")`: a lazy chunk, still shipped to the browser. */
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("~/")) base = join(SRC_DIR, spec.slice(2));
  else if (spec.startsWith("@/")) base = join(SRC_DIR, "@", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base; // unresolved: still checked against the forbidden prefixes
}

/**
 * Every value import reachable from `root`, as [importer, specifier, target].
 * With `dynamic`, lazy `import("...")` edges are followed too.
 */
function walk(
  root: string,
  { dynamic = false }: { dynamic?: boolean } = {},
): Array<[string, string, string | null]> {
  const seen = new Set<string>();
  const edges: Array<[string, string, string | null]> = [];
  const stack = [root];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file) || !existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    const specs: string[] = [];
    for (const match of source.matchAll(IMPORT_RE)) {
      // `import type` is erased at compile time and cannot pull a runtime in.
      if (match[1]) continue;
      specs.push(match[2]!);
    }
    if (dynamic) {
      for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) specs.push(match[1]!);
    }
    for (const spec of specs) {
      const target = resolveLocal(spec, file);
      edges.push([file, spec, target]);
      if (target && !FORBIDDEN_LOCAL.some((dir) => target.startsWith(dir))) {
        stack.push(target);
      }
    }
  }
  return edges;
}

function violationsFrom(root: string, dynamic = false): string[] {
  const violations: string[] = [];
  for (const [importer, spec, target] of walk(root, { dynamic })) {
    const forbidden =
      FORBIDDEN_PACKAGES.test(spec) ||
      (target !== null && FORBIDDEN_LOCAL.some((dir) => target.startsWith(dir)));
    if (forbidden) {
      violations.push(`${relative(SRC_DIR, root)}: ${relative(SRC_DIR, importer)} imports ${spec}`);
    }
  }
  return violations;
}

describe("stock picker component boundary", () => {
  it("finds the kit files it means to check", () => {
    const names = KIT_FILES.map((file) => relative(COMPONENT_DIR, file));
    expect(names).toEqual(
      expect.arrayContaining([
        "strategy-panel.tsx",
        "picks-table.tsx",
        "picks-filter-view.tsx",
        "pick-fundamentals.tsx",
        "regime-banner.tsx",
      ]),
    );
  });

  it("keeps the strategy panel props-only and server-safe", () => {
    const source = readFileSync(join(COMPONENT_DIR, "strategy-panel.tsx"), "utf8");
    expect(source).not.toMatch(/^\s*["']use client["']/m);
    // Import specifiers only: the file's own comment names what it avoids.
    const specifiers = [...source.matchAll(IMPORT_RE)].map((match) => match[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec).not.toMatch(/_pb$|@bufbuild\/protobuf|@connectrpc|app\/actions/);
    }
  });

  // The one island lives with its route (app/picks/[strategy]); the kit
  // itself is all server-safe, props-only components.
  it("marks no kit file as a client component", () => {
    const clientFiles = KIT_FILES.filter((file) =>
      /^\s*["']use client["']/m.test(readFileSync(file, "utf8")),
    ).map((file) => relative(COMPONENT_DIR, file));
    expect(clientFiles).toEqual([]);
  });

  it("never reaches protobuf, @connectrpc or a server action, however indirectly", () => {
    expect(KIT_FILES.flatMap((file) => violationsFrom(file))).toEqual([]);
  });

  // The walk must actually see an import to be worth anything: prove it
  // follows the kit into the shared libs it depends on, including the stock
  // page's growth figures the picker's growth cells share.
  it("walks into the shared strategies lib and the shared growth figures", () => {
    const targets = walk(join(COMPONENT_DIR, "picks-filter-view.tsx"))
      .map(([, , target]) => (target ? relative(SRC_DIR, target) : ""))
      .filter(Boolean);
    expect(targets).toEqual(
      expect.arrayContaining([
        join("@", "lib", "strategies", "shortlist.ts"),
        join("@", "components", "picks", "picks-table.tsx"),
        join("@", "components", "stocks", "growth-figures.tsx"),
        join("@", "lib", "fundamentals", "format.ts"),
      ]),
    );
  });
});

describe("/picks sort island boundary", () => {
  it("is a client component, and the only one in the route", () => {
    expect(readFileSync(ISLAND, "utf8")).toMatch(/^\s*["']use client["']/);
    const clientFiles = readdirSync(ROUTE_DIR)
      .filter((entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      .filter((entry) =>
        /^\s*["']use client["']/m.test(readFileSync(join(ROUTE_DIR, entry), "utf8")),
      );
    expect(clientFiles).toEqual(["picks-sorted-view.tsx"]);
  });

  // The browser POSTs plain JSON through the same-origin rewrite: no ~/gen
  // descriptors, no protobuf runtime, no @connectrpc, no server action, at any
  // depth, including the lazily imported fetch module.
  it("never reaches ~/gen, protobuf, @connectrpc or a server action, lazy chunks included", () => {
    expect(violationsFrom(ISLAND, true)).toEqual([]);
    expect(violationsFrom(SORT_FETCH, true)).toEqual([]);
  });

  // The fetch code and the mapper load on first use, so they stay out of the
  // page's first-load JavaScript.
  it("loads the fetch module and the mapper lazily, never statically", () => {
    const eager = walk(ISLAND).map(([, , target]) => target ?? "");
    expect(eager).not.toContain(SORT_FETCH);
    expect(eager).not.toContain(join(SRC_DIR, "@", "lib", "strategies", "map.ts"));

    const lazy = walk(ISLAND, { dynamic: true }).map(([, , target]) => target ?? "");
    expect(lazy).toEqual(
      expect.arrayContaining([SORT_FETCH, join(SRC_DIR, "@", "lib", "strategies", "map.ts")]),
    );
  });
});
