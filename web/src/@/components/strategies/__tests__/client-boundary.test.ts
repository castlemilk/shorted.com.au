/**
 * The strategy kit must stay server-safe and composable from a client island.
 *
 * PR-19's backtest chart and PR-20's explorer are client islands that compose
 * these components. If a kit file reached the protobuf runtime, @connectrpc,
 * a generated ~/gen module or a server action, directly or one import away, the
 * client bundle would carry the generated descriptors and the static build would
 * die with the undiagnosable "Element type is invalid" (see
 * components/picks/__tests__/client-boundary.test.ts, the pattern this copies).
 * Jest does not catch that, so this walks the import graph, lazy import() edges
 * included, from every kit file through the rest of src/.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const COMPONENT_DIR = join(__dirname, "..");
/** `src/`: the root every path alias in tsconfig.json resolves against. */
const SRC_DIR = join(__dirname, "..", "..", "..", "..");

const FORBIDDEN_PACKAGES = /^(?:@bufbuild\/protobuf|@connectrpc\/)/;
const FORBIDDEN_LOCAL = [join(SRC_DIR, "gen"), join(SRC_DIR, "app", "actions")];

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;
/** `import("./x")`: a lazy chunk, still shipped to the browser. */
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function kitFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory())
      return entry === "__tests__" ? [] : kitFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

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
 * `import type` is erased at compile time and is not followed.
 */
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
    const specs: string[] = [];
    for (const match of source.matchAll(IMPORT_RE)) {
      if (match[1]) continue;
      specs.push(match[2]!);
    }
    for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) specs.push(match[1]!);
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

function violationsFrom(root: string): string[] {
  const violations: string[] = [];
  for (const [importer, spec, target] of walk(root)) {
    const forbidden =
      FORBIDDEN_PACKAGES.test(spec) ||
      (target !== null && FORBIDDEN_LOCAL.some((dir) => target.startsWith(dir)));
    if (forbidden) {
      violations.push(
        `${relative(SRC_DIR, root)}: ${relative(SRC_DIR, importer)} imports ${spec}`,
      );
    }
  }
  return violations;
}

const KIT_FILES = kitFiles(COMPONENT_DIR);

describe("strategy components stay server-safe, however indirectly", () => {
  it("finds the kit files it means to check", () => {
    const names = KIT_FILES.map((file) => relative(COMPONENT_DIR, file));
    expect(names).toEqual(
      expect.arrayContaining([
        "returns-heatmap-table.tsx",
        "coverage-strip.tsx",
        "equity-sparkline.tsx",
      ]),
    );
  });

  it("marks no kit file as a client component: the kit is server markup", () => {
    const clientFiles = KIT_FILES.filter((file) =>
      /^\s*["']use client["']/m.test(readFileSync(file, "utf8")),
    ).map((file) => relative(COMPONENT_DIR, file));
    expect(clientFiles).toEqual([]);
  });

  it("never reaches protobuf, @connectrpc, ~/gen or a server action, lazy chunks included", () => {
    expect(KIT_FILES.flatMap((file) => violationsFrom(file))).toEqual([]);
  });

  // The walk must see an import to be worth anything: prove it follows the
  // heatmap into the shared returns scale, the one place the colour rule lives.
  it("walks into the returns scale the heatmap paints from", () => {
    const targets = walk(join(COMPONENT_DIR, "returns-heatmap-table.tsx"))
      .map(([, , target]) => (target ? relative(SRC_DIR, target) : ""))
      .filter(Boolean);
    expect(targets).toEqual(
      expect.arrayContaining([join("@", "lib", "strategies", "returns-scale.ts")]),
    );
  });
});
