/**
 * The workspace components (the page shell, the toolbar, the sub-nav and the
 * selection tray) are drawn by ownership and strategies pages, so they reach no
 * Connect, protobuf, generated code or server action. Only import specifiers are
 * read, so a comment that names one is not a violation.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE = join(__dirname, "..");

const FORBIDDEN: Array<[string, RegExp]> = [
  ["@connectrpc", /^@connectrpc\b/],
  ["the protobuf runtime", /^@bufbuild\/|protobuf/],
  ["generated protobuf code", /(^|\/)gen\/|_pb$/],
  ["a server action module", /(^|\/)actions(\/|$)/],
];

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) found.push(m[1]!);
  return found;
}

function modules(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => join(dir, f));
}

describe("workspace component client boundary", () => {
  const files = modules(WORKSPACE);

  it("finds the shared workspace modules", () => {
    expect(files.map((f) => f.slice(f.lastIndexOf("/") + 1)).sort()).toEqual(
      expect.arrayContaining(["selection-tray.tsx", "toolbar.tsx", "workspace-page.tsx", "workspace-sub-nav.tsx"]),
    );
  });

  it.each(files.map((f) => [f.slice(f.lastIndexOf("/") + 1), f]))("%s reaches no Connect, protobuf, generated code or action", (_name, file) => {
    const source = readFileSync(file as string, "utf8");
    const offenders: string[] = [];
    for (const spec of specifiers(source)) {
      for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(spec)) offenders.push(`${spec} (${label})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
