/**
 * The stock page's fundamentals kit must stay props-only and client-safe
 * (docs/plans/fundamentals-coverage.md §7.1).
 *
 * financial-statements.tsx is the kit's ONE "use client" island, and the
 * server cards are composed into the stock pages beside it. If a kit file
 * imported the generated protobuf modules, the protobuf runtime,
 * @connectrpc or a server action (directly or at any depth), that runtime
 * would follow it into the route's client bundle and the static build would
 * die with the undiagnosable "Element type is invalid" digest (see
 * ../../picks/__tests__/client-boundary.test.ts). Jest does not catch that;
 * only a structural check or a full build does, so here is the check.
 *
 * It is TRANSITIVE: it follows every relative and aliased import from each kit
 * file through the rest of src/. `import type` is erased at compile time and
 * is allowed (the cards type their props from the server actions).
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
      if (match[1]) continue; // `import type`
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

describe("stock fundamentals component boundary", () => {
  it("finds the kit files it means to check", () => {
    const names = KIT_FILES.map((file) => relative(COMPONENT_DIR, file));
    expect(names).toEqual(
      expect.arrayContaining([
        "financials-tab.tsx",
        "financial-statements.tsx",
        "latest-result-card.tsx",
        "key-ratios-card.tsx",
        "strategy-fit-card.tsx",
        "fundamentals-summary.tsx",
        "statements-shape.ts",
        "statement-lines.ts",
      ]),
    );
  });

  it("marks only the statements island as a client component", () => {
    const clientFiles = KIT_FILES.filter((file) =>
      /^\s*["']use client["']/m.test(readFileSync(file, "utf8")),
    ).map((file) => relative(COMPONENT_DIR, file));
    expect(clientFiles).toEqual(["financial-statements.tsx"]);
  });

  it("never reaches ~/gen, protobuf, @connectrpc or a server action, however indirectly", () => {
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

  it("keeps the island's own imports free of server-only shaping", () => {
    // Row definitions and formatters live client-side; the shaper is the
    // server's. The island must not import it (it would ship to the browser).
    const island = walk(join(COMPONENT_DIR, "financial-statements.tsx"))
      .map(([, , target]) => (target ? relative(SRC_DIR, target) : ""))
      .filter(Boolean);
    expect(island).not.toContain(join("@", "components", "stocks", "statements-shape.ts"));
  });

  // The walk must actually see imports to be worth anything.
  it("walks into the shared fundamentals vocabulary and the picks kit", () => {
    const fromIsland = walk(join(COMPONENT_DIR, "financial-statements.tsx"))
      .map(([, , target]) => (target ? relative(SRC_DIR, target) : ""))
      .filter(Boolean);
    expect(fromIsland).toEqual(
      expect.arrayContaining([
        join("@", "lib", "fundamentals", "format.ts"),
        join("@", "components", "stocks", "statement-lines.ts"),
      ]),
    );
    const fromFitCard = walk(join(COMPONENT_DIR, "strategy-fit-card.tsx"))
      .map(([, , target]) => (target ? relative(SRC_DIR, target) : ""))
      .filter(Boolean);
    expect(fromFitCard).toEqual(
      expect.arrayContaining([join("@", "components", "picks", "picks-table.tsx")]),
    );
  });
});
