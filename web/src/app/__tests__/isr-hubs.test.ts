/**
 * Hub pages that are ISR, and stay ISR.
 *
 * On 2026-10-21 /shorts, /scans and /scans/<slug> were served `private,
 * no-store` on every request. /shorts exported `revalidate = 600` beside
 * `dynamic = "force-dynamic"`, which wins, so the revalidate was inert; the
 * scan pages were force-dynamic outright. Their reads were ISR-safe all along.
 *
 * Two checks, read off the syntax tree (comments do not count):
 *  1. App-wide, no page exports a positive `revalidate` together with
 *     `dynamic = "force-dynamic"`: one of the two is a mistake.
 *  2. Each hub below exports a literal positive `revalidate`, no `dynamic`,
 *     and its own file reads no request-time API (searchParams, cookies(),
 *     headers(), auth(), noStore()). Any of those makes Next render the page
 *     per request whatever its revalidate says.
 *
 * Neither can see a dynamic read in a module a page imports; for transports
 * that is app/actions/__tests__/serverApiSurface.test.ts, and the request
 * level (a second request answering HIT) is the rollout check.
 */

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const APP_DIR = path.resolve(__dirname, "..");

/** Pages this partition keeps ISR. Paths are relative to app/. */
const HUBS = [
  "shorts/page.tsx",
  "scans/page.tsx",
  "scans/[slug]/page.tsx",
  "battlegrounds/page.tsx",
  "statistics/page.tsx",
  // Its ?price=&state= prefill is read in the browser (calculator-prefill.tsx).
  "housing/calculators/page.tsx",
];

/**
 * Pages that export both, each with its owner's fix. Empty since 2026-10-21,
 * when industry/page.tsx dropped its inert revalidate.
 */
const ALLOWED_BOTH: Record<string, string> = {};

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    fs.readFileSync(path.join(APP_DIR, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/** `export const <name> = …` initializers, by name. */
function exportedConsts(sourceFile: ts.SourceFile): Map<string, ts.Expression | undefined> {
  const found = new Map<string, ts.Expression | undefined>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (ts.isIdentifier(name)) found.set(name.text, initializer);
    }
  }
  return found;
}

const isPositiveLiteral = (e: ts.Expression | undefined): boolean =>
  e !== undefined && ts.isNumericLiteral(e) && Number(e.text) > 0;

const isForceDynamic = (e: ts.Expression | undefined): boolean =>
  e !== undefined && ts.isStringLiteralLike(e) && e.text === "force-dynamic";

const REQUEST_TIME_CALLS = new Set(["cookies", "headers", "auth", "noStore", "unstable_noStore"]);

/** The request-time APIs a source file reads, by name. */
function requestTimeReads(sourceFile: ts.SourceFile): string[] {
  const reads = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "searchParams") reads.add("searchParams");
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      REQUEST_TIME_CALLS.has(node.expression.text)
    ) {
      reads.add(`${node.expression.text}()`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...reads].sort();
}

function pages(dir: string = APP_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : pages(full);
    return entry.name === "page.tsx"
      ? [path.relative(APP_DIR, full).split(path.sep).join("/")]
      : [];
  });
}

const fixture = (code: string): ts.SourceFile =>
  ts.createSourceFile("page.tsx", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

describe("ISR hub pages", () => {
  it("no page exports a positive revalidate beside force-dynamic", () => {
    const both = pages().filter((page) => {
      const consts = exportedConsts(parse(page));
      return isPositiveLiteral(consts.get("revalidate")) && isForceDynamic(consts.get("dynamic"));
    });
    expect(both.filter((page) => !(page in ALLOWED_BOTH))).toEqual([]);
    // The allowlist can only shrink.
    for (const page of Object.keys(ALLOWED_BOTH)) expect(both).toContain(page);
  });

  it.each(HUBS)("%s exports a positive revalidate and no dynamic", (page) => {
    const consts = exportedConsts(parse(page));
    expect(isPositiveLiteral(consts.get("revalidate"))).toBe(true);
    expect(consts.has("dynamic")).toBe(false);
  });

  it.each(HUBS)("%s reads no request-time API", (page) => {
    expect(requestTimeReads(parse(page))).toEqual([]);
  });

  describe("the readers", () => {
    it("sees each request-time read, and not its look-alikes or comments", () => {
      expect(
        requestTimeReads(
          fixture(
            [
              "export default async function P({ searchParams }: { searchParams: Promise<object> }) {",
              "  const jar = cookies(); const list = headers(); const s = await auth(); noStore();",
              "  return null;",
              "}",
            ].join("\n"),
          ),
        ),
      ).toEqual(["auth()", "cookies()", "headers()", "noStore()", "searchParams"]);
      expect(
        requestTimeReads(
          fixture(
            [
              "// searchParams, cookies() and headers() are read client-side",
              "const q = useSearchParams(); const p = new URLSearchParams();",
              "fetch(u, { headers: { accept: 'text/html' } }); const h = getHeaders();",
            ].join("\n"),
          ),
        ),
      ).toEqual([]);
    });

    it("tells a literal positive revalidate and force-dynamic apart from the rest", () => {
      const consts = exportedConsts(
        fixture(
          [
            "export const revalidate = 600;",
            "export const dynamic = 'force-dynamic';",
            "const dynamicParams = true;",
          ].join("\n"),
        ),
      );
      expect(isPositiveLiteral(consts.get("revalidate"))).toBe(true);
      expect(isForceDynamic(consts.get("dynamic"))).toBe(true);
      expect(consts.has("dynamicParams")).toBe(false);
      expect(isPositiveLiteral(exportedConsts(fixture("export const revalidate = 0;")).get("revalidate"))).toBe(false);
    });
  });
});
