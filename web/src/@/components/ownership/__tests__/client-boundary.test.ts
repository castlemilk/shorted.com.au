/**
 * Two boundaries the ownership tables rest on, which no render test sees
 * (only a build would):
 *
 *  1. The table island (ownership-tables.tsx) must not reach the generated
 *     protobuf modules, the protobuf runtime, @connectrpc or a server action:
 *     the protobuf runtime in a client bundle is the "Element type is
 *     invalid" failure (CLAUDE.md, SSR Issues). Its rows arrive formatted
 *     (lib/ownership/rows.ts) and it imports only their types.
 *  2. The stock page's Company tab draws StockOwnershipView. Next ships every
 *     "use client" module a route's server graph reaches, rendered or not, so
 *     the card must reach no client module, the island included: NoticeTable
 *     lives in notice-table.tsx, not ownership-parts.tsx, for this reason.
 *
 * Both walks are transitive over value imports (`import type` is erased).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const DIR = join(__dirname, "..");
/** `src/`: the root the `~/` and `@/` aliases resolve against. */
const SRC = join(DIR, "..", "..", "..");

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

describe("ownership client boundary", () => {
  it("keeps the table island free of protobuf, Connect and server actions", () => {
    const { files, packages } = reach(join(DIR, "ownership-tables.tsx"));
    expect(files).toContain("@/components/ownership/external-link-glyph.tsx");
    expect(packages.filter((p) => /^(?:@bufbuild\/protobuf|@connectrpc\/)/.test(p))).toEqual([]);
    expect(files.filter((f) => f.startsWith("gen/") || f.startsWith("app/actions/"))).toEqual([]);
  });

  it("keeps the Company tab's ownership card from reaching any client module", () => {
    const { files } = reach(join(DIR, "stock-ownership-view.tsx"));
    expect(files).toContain("@/components/ownership/ownership-parts.tsx");
    expect(files.filter(isClientModule)).toEqual([]);
  });
});
