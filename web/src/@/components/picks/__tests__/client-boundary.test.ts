/**
 * The stock picker kit must stay composable from a client island.
 *
 * picks-status-filter.tsx is a "use client" island that renders the table,
 * and any future island may compose the strategy panel. If a kit file imported
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

const KIT_FILES = readdirSync(COMPONENT_DIR)
  .filter((entry) => /\.tsx?$/.test(entry))
  .map((entry) => join(COMPONENT_DIR, entry));

const FORBIDDEN_PACKAGES = /^(?:@bufbuild\/protobuf|@connectrpc\/)/;
const FORBIDDEN_LOCAL = [join(SRC_DIR, "gen"), join(SRC_DIR, "app", "actions")];

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;

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

/** Every value import reachable from `root`, as [importer, specifier, target]. */
function walk(root: string): Array<[string, string, string | null]> {
  const seen = new Set<string>();
  const edges: Array<[string, string, string | null]> = [];
  const stack = [root];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file) || !existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      // `import type` is erased at compile time and cannot pull a runtime in.
      if (match[1]) continue;
      const spec = match[2]!;
      const target = resolveLocal(spec, file);
      edges.push([file, spec, target]);
      if (target && !FORBIDDEN_LOCAL.some((dir) => target.startsWith(dir))) {
        stack.push(target);
      }
    }
  }
  return edges;
}

describe("stock picker component boundary", () => {
  it("finds the kit files it means to check", () => {
    const names = KIT_FILES.map((file) => relative(COMPONENT_DIR, file));
    expect(names).toEqual(
      expect.arrayContaining([
        "strategy-panel.tsx",
        "picks-table.tsx",
        "picks-status-filter.tsx",
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

  it("marks only the status filter island as a client component", () => {
    const clientFiles = KIT_FILES.filter((file) =>
      /^\s*["']use client["']/m.test(readFileSync(file, "utf8")),
    ).map((file) => relative(COMPONENT_DIR, file));
    expect(clientFiles).toEqual(["picks-status-filter.tsx"]);
  });

  it("never reaches protobuf, @connectrpc or a server action, however indirectly", () => {
    const violations: string[] = [];
    for (const file of KIT_FILES) {
      for (const [importer, spec, target] of walk(file)) {
        const forbidden =
          FORBIDDEN_PACKAGES.test(spec) ||
          (target !== null && FORBIDDEN_LOCAL.some((dir) => target.startsWith(dir)));
        if (forbidden) {
          violations.push(
            `${relative(SRC_DIR, file)}: ${relative(SRC_DIR, importer)} imports ${spec}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // The walk must actually see an import to be worth anything: prove it
  // follows the kit into the shared lib it depends on.
  it("walks into the shared strategies lib", () => {
    const targets = walk(join(COMPONENT_DIR, "picks-status-filter.tsx"))
      .map(([, , target]) => (target ? relative(SRC_DIR, target) : ""))
      .filter(Boolean);
    expect(targets).toEqual(
      expect.arrayContaining([
        join("@", "lib", "strategies", "shortlist.ts"),
        join("@", "components", "picks", "picks-table.tsx"),
      ]),
    );
  });
});
