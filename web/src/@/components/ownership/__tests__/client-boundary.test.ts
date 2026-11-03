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
 *  4. The notice explorer's islands and the parts they draw (the stage 2 feed
 *     and register list) reach neither generated code, protobuf, Connect nor an
 *     action: the action arrives as a prop, and the islands import its type only.
 *
 * Every walk is transitive over value imports (`import type` is erased), and an
 * import that names no file is a failure, never a branch the walk skips.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import * as ts from "typescript";

const DIR = join(__dirname, "..");
/** `src/`: the root the `~/` and `@/` aliases resolve against. */
const SRC = join(DIR, "..", "..", "..");
/** The Overview's register strip lives beside the stock components, not here. */
const STRIP = join(DIR, "..", "stocks", "register-strip.tsx");

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;

/** `web/`, the root web/tsconfig.json sits in. */
const WEB = join(SRC, "..");

/**
 * The aliases web/tsconfig.json declares, read with the compiler's own reader so
 * its comments parse. This is the table the walk resolves by. jest's moduleNameMapper
 * is a different one (`@/` is src/@ there), and `@/app`, `@/server`, `@/styles` and
 * `@/auth` live outside src/@: a walk that assumed src/@ would miss them.
 */
interface Alias {
  prefix: string;
  wildcard: boolean;
  target: string;
}
const ALIASES: Alias[] = Object.entries(
  (ts.readConfigFile(join(WEB, "tsconfig.json"), ts.sys.readFile).config?.compilerOptions?.paths ??
    {}) as Record<string, string[]>,
).map(([key, [target = ""]]) =>
  key.endsWith("/*")
    ? { prefix: key.slice(0, -1), wildcard: true, target: target.slice(0, -1) }
    : { prefix: key, wildcard: false, target },
);

/** The file an import names. An import that names no file is a throw: a hole in the walk, never a skip. */
function existingFile(base: string, spec: string, fromFile: string): string {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`unresolved import "${spec}" in ${relative(WEB, fromFile)}`);
}

/** The file a local import names, or null for a package. */
function resolveLocal(spec: string, fromFile: string): string | null {
  if (spec.startsWith(".")) return existingFile(resolve(dirname(fromFile), spec), spec, fromFile);
  // The longest alias wins, so `@/registry/new-york/ui/x` takes its own entry over `@/registry/*`.
  const alias = ALIASES.filter((a) => (a.wildcard ? spec.startsWith(a.prefix) : spec === a.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  )[0];
  if (alias) {
    return existingFile(join(WEB, alias.target, alias.wildcard ? spec.slice(alias.prefix.length) : ""), spec, fromFile);
  }
  // An alias this table does not hold is a missing mapping, not a package.
  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    throw new Error(`no tsconfig path for "${spec}" in ${relative(WEB, fromFile)}`);
  }
  return null;
}

/** A file's source, or undefined for one that is not on disk. */
const onDisk = (file: string): string | undefined =>
  existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : undefined;

/**
 * Every local module an entry reaches through value imports, and the packages they
 * name. `source` reads a file; a test may supply one for a fixture that is not on disk.
 */
function reach(
  entry: string,
  source: (file: string) => string | undefined = onDisk,
): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = source(file);
    if (text === undefined) continue;
    for (const [, typeOnly, spec] of text.matchAll(IMPORT_RE)) {
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

describe("notice explorer client boundary", () => {
  it.each(["notice-feed-explorer", "registers-explorer", "notice-mark", "notice-week-bars", "register-rows-table"])(
    "keeps %s free of protobuf, Connect, generated code and server actions",
    (name) => {
      const { files, packages } = reach(join(DIR, `${name}.tsx`));
      expect(packages.filter(isProtobufOrConnect)).toEqual([]);
      expect(files.filter(isGeneratedOrAction)).toEqual([]);
    },
  );

  it("follows the feed's own imports, so the check reaches the parts it draws", () => {
    const { files } = reach(join(DIR, "notice-feed-explorer.tsx"));
    expect(files).toContain("@/components/ownership/notice-week-bars.tsx");
    expect(files).toContain("@/components/politicians/explorer/screen-reader-table.tsx");
  });

  it("flags a value import of a server action through the @/app alias", () => {
    const fixture = join(DIR, "__fixture__.tsx");
    const { files } = reach(fixture, (file) =>
      file === fixture
        ? `"use client";\nimport { loadPage } from "@/app/actions/ownershipExplorer";\n`
        : onDisk(file),
    );
    expect(files).toContain("app/actions/ownershipExplorer.ts");
    expect(files.filter(isGeneratedOrAction)).toContain("app/actions/ownershipExplorer.ts");
  });

  it("fails on an import that names no file, rather than skipping it", () => {
    const fixture = join(DIR, "__fixture__.tsx");
    expect(() =>
      reach(fixture, (file) =>
        file === fixture ? `import { x } from "@/components/ownership/no-such-file";\n` : onDisk(file),
      ),
    ).toThrow(/unresolved import "@\/components\/ownership\/no-such-file"/);
  });
});
