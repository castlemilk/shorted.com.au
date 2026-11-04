/**
 * The funds' client boundary and copy rules (spec 14.6, 14.3, 7):
 *
 *  1. The fund islands and the pure modules beside them reach no Connect, no
 *     protobuf runtime, no generated code and no server action. The actions arrive
 *     as props, typed structurally, so a client module never imports one.
 *  2. The inspector builders this package adds (workspace/inspectors/fund-, holding-
 *     and change-inspector) are plain data a server action carries across the
 *     boundary: the same rule.
 *  3. No em dash in any file this package adds, comments included (section 7).
 *     The character is written as a code point, so this file holds none either.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FUNDS = join(__dirname, "..");
const WORKSPACE = join(FUNDS, "..", "workspace");
const INSPECTORS = join(WORKSPACE, "inspectors");
const WEB = join(FUNDS, "..", "..", "..", "..", "..");
const PAGES = [
  join(WEB, "src", "app", "ownership", "funds"),
  join(WEB, "src", "app", "ownership", "changes"),
];
const ACTION = join(WEB, "src", "app", "actions", "ownershipFunds.ts");

const FORBIDDEN: Array<[string, RegExp]> = [
  ["@connectrpc", /^@connectrpc\b/],
  ["the protobuf runtime", /^@bufbuild\/|protobuf/],
  ["generated protobuf code", /(^|\/)gen\/|_pb$/],
  ["a server action module", /(^|\/)actions(\/|$)/],
];

const EM_DASH = String.fromCharCode(0x2014);

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) found.push(m[1]!);
  return found;
}

/** Every .ts and .tsx file under a folder, tests excluded, recursing into subfolders. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sources(full);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [full] : [];
  });
}

/** The three inspector builders this package writes; the workspace's other inspectors are not walked here. */
const OWN_INSPECTORS = ["fund-inspector.tsx", "holding-inspector.tsx", "change-inspector.tsx"].map((name) =>
  join(INSPECTORS, name),
);
const clientFiles = [...sources(FUNDS), ...OWN_INSPECTORS];

describe("funds client boundary (spec 14.6)", () => {
  it("walks the funds islands, the pure modules and the inspector builders", () => {
    expect(clientFiles.length).toBeGreaterThanOrEqual(14);
    expect(clientFiles.some((file) => file.endsWith("fund-exposure-map.tsx"))).toBe(true);
    expect(clientFiles.some((file) => file.endsWith("change-inspector.tsx"))).toBe(true);
  });

  it.each(clientFiles.map((file) => [file.slice(file.indexOf("components/")), file]))(
    "%s reaches no Connect, protobuf, generated code or action",
    (_name, file) => {
      const offenders: string[] = [];
      for (const spec of specifiers(readFileSync(file as string, "utf8"))) {
        for (const [label, pattern] of FORBIDDEN) {
          if (pattern.test(spec)) offenders.push(`${spec} (${label})`);
        }
      }
      expect(offenders).toEqual([]);
    },
  );
});

describe("funds copy and copy rules", () => {
  const written = [
    ...clientFiles,
    ...PAGES.flatMap((dir) => sources(dir)),
    ACTION,
  ];

  it("walks every page, loading file and the action this package adds", () => {
    expect(written).toEqual(expect.arrayContaining([ACTION]));
    expect(written.filter((file) => file.includes(join("app", "ownership", "funds")))).toHaveLength(4);
  });

  it.each(written.map((file) => [file.slice(file.indexOf("src/")), file]))(
    "%s has no em dash",
    (_name, file) => {
      expect(readFileSync(file as string, "utf8")).not.toContain(EM_DASH);
    },
  );
});
