/**
 * The workspace islands and the vendored Gamma components (spec 14.6): each is a
 * client module the whole route bundle carries, so none may reach Connect, the
 * protobuf runtime, generated code or a server action. Only import specifiers are
 * read, so a comment that names one is not a violation.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE = join(__dirname, "..");
const GAMMA = join(WORKSPACE, "..", "..", "gamma");

const FORBIDDEN: Array<[string, RegExp]> = [
  ["@connectrpc", /^@connectrpc\b/],
  ["the protobuf runtime", /^@bufbuild\/|protobuf/],
  // lib/sector-images.ts and next/image are plain modules and allowed; the protobuf modules are not.
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

describe("workspace and gamma client boundary (spec 14.6)", () => {
  const files = [...modules(WORKSPACE), ...modules(GAMMA)];

  it("finds the workspace and gamma modules it walks", () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files.map((f) => [f.slice(f.indexOf("src/")), f]))("%s reaches no Connect, protobuf, generated code or action", (_name, file) => {
    const source = readFileSync(file as string, "utf8");
    const offenders: string[] = [];
    for (const spec of specifiers(source)) {
      for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(spec)) offenders.push(`${spec} (${label})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("refuses a server action file in the workspace as an import", () => {
    expect(specifiers('import { x } from "~/app/actions/getOwnership";')).toEqual(["~/app/actions/getOwnership"]);
    expect(FORBIDDEN.some(([, p]) => p.test("~/app/actions/getOwnership"))).toBe(true);
  });
});
