/**
 * Boundaries the ownership components rest on, which no render test sees
 * (only a build would):
 *
 *  1. The table islands (ownership-tables.tsx) must not reach the generated
 *     protobuf modules, the protobuf runtime, @connectrpc or a server action:
 *     the protobuf runtime in a client bundle is the "Element type is
 *     invalid" failure (CLAUDE.md, SSR Issues). Their rows arrive formatted
 *     (lib/ownership/rows.ts) and they import only the types of those rows.
 *  2. The stock page's Company tab draws StockOwnershipView. Next ships every
 *     "use client" module a route's server graph reaches, rendered or not, so
 *     the card must reach no client module, the island included: NoticeTable
 *     lives in notice-table.tsx, not ownership-parts.tsx, for this reason. The
 *     register's server components are held to the same rule, so a page can
 *     draw them without pulling a chunk into its tab.
 *  3. The leaf figures (disclosed-bar, kind-badge, pooled-fund-mark) are drawn
 *     on the server by pages and tables alike, so they reach neither the
 *     generated code nor an action.
 *
 * Both walks are transitive over value imports (`import type` is erased).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const DIR = join(__dirname, "..");
/** `src/`: the root the `~/` and `@/` aliases resolve against. */
const SRC = join(DIR, "..", "..", "..");
/** The Overview's register strip lives beside the stock components, not here. */
const STRIP = join(DIR, "..", "stocks", "register-strip.tsx");

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("~/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith("@/")) base = join(SRC, "@", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return base; // unresolved (e.g. ~/gen, ignored by jest): still reported
}

/** Every local module an entry reaches through value imports, and the packages they name. */
function reach(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    for (const [, typeOnly, spec] of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      if (typeOnly || !spec) continue;
      const local = resolveLocal(spec, file);
      if (local) queue.push(local);
      else packages.add(spec);
    }
  }
  return { files: [...files].map((f) => relative(SRC, f)), packages: [...packages] };
}

const isClientModule = (file: string) =>
  existsSync(join(SRC, file)) && /^\s*["']use client["']/.test(readFileSync(join(SRC, file), "utf8"));

const isProtobufOrConnect = (pkg: string) => /^(?:@bufbuild\/protobuf|@connectrpc\/)/.test(pkg);
const isGeneratedOrAction = (file: string) => file.startsWith("gen/") || file.startsWith("app/actions/");

describe("ownership client boundary", () => {
  it("keeps the table island free of protobuf, Connect and server actions", () => {
    const { files, packages } = reach(join(DIR, "ownership-tables.tsx"));
    expect(files).toContain("@/components/ownership/external-link-glyph.tsx");
    expect(packages.filter(isProtobufOrConnect)).toEqual([]);
    expect(files.filter(isGeneratedOrAction)).toEqual([]);
  });

  it("keeps the Company tab's ownership card from reaching any client module", () => {
    const { files } = reach(join(DIR, "stock-ownership-view.tsx"));
    expect(files).toContain("@/components/ownership/ownership-parts.tsx");
    expect(files.filter(isClientModule)).toEqual([]);
  });

  it.each(["holder-lanes", "register-readout", "stock-fund-table", "stock-ownership-view"])(
    "keeps %s from reaching any client module",
    (name) => {
      const { files } = reach(join(DIR, `${name}.tsx`));
      expect(files.filter(isClientModule)).toEqual([]);
    },
  );

  // register-strip.tsx arrives with the stock pages. Until it is in the tree
  // there is nothing to walk, so the check is registered once the file exists.
  if (existsSync(STRIP)) {
    it("keeps the Overview's register strip from reaching any client module", () => {
      const { files } = reach(STRIP);
      expect(files.filter(isClientModule)).toEqual([]);
    });
  }

  it.each(["ownership-tables", "disclosed-bar", "kind-badge", "pooled-fund-mark"])(
    "keeps %s free of protobuf, Connect, generated code and server actions",
    (name) => {
      const { files, packages } = reach(join(DIR, `${name}.tsx`));
      expect(packages.filter(isProtobufOrConnect)).toEqual([]);
      expect(files.filter(isGeneratedOrAction)).toEqual([]);
    },
  );
});
