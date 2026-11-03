/**
 * @jest-environment node
 */
/**
 * A request with a `next` option that is not a GET must go through
 * serverFetchWithUserAgent (or serverFetchOutsideNextCache). A raw
 * `fetch(url, { method: "POST", next })` keeps the option on the fetch, so Next
 * 15 stores its answer in the data cache for the revalidate window: one empty
 * answer (a cold materialized view, the kill switch) would then reach every
 * caller until it expired. applyRoutePolicy (actions/config.ts) is what keeps
 * that out, and only the approved wrappers call it.
 *
 * GET requests are not checked: their `next` option is what the data cache is
 * for (an image, a GCS listing, the edge read).
 */
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";

const srcRoot = path.resolve(__dirname, "../../..");
// Not application code: generated protobuf and the test harness.
const SKIP_ROOTS = [path.join(srcRoot, "gen"), path.join(srcRoot, "test")];
const SKIP_DIRS = new Set(["__tests__", "__mocks__"]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_ROOTS.includes(full)) return [];
      return sourceFiles(full);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.(test|spec|stories)\.(ts|tsx)$/.test(entry.name)) return [];
    return [full];
  });
}

function propertyName(
  property: ts.ObjectLiteralElementLike,
  sf: ts.SourceFile,
): string | undefined {
  if (!("name" in property) || property.name === undefined) return undefined;
  return property.name.getText(sf).replace(/^["'`]|["'`]$/g, "");
}

/** True when the init object sends something other than a GET or HEAD. */
function isNonGetInit(init: ts.ObjectLiteralExpression, sf: ts.SourceFile): boolean {
  const method = init.properties.find((p) => propertyName(p, sf) === "method");
  if (method) {
    // A method we cannot read as a literal is treated as non-GET.
    if (
      !ts.isPropertyAssignment(method) ||
      !(
        ts.isStringLiteral(method.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(method.initializer)
      )
    ) {
      return true;
    }
    return !["GET", "HEAD"].includes(method.initializer.text.toUpperCase());
  }
  // No method means GET, unless the request carries a body.
  return init.properties.some((p) => propertyName(p, sf) === "body");
}

/** Lines of raw `fetch(url, { …, next })` calls that are not GET or HEAD. */
function rawNonGetNextLines(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "fetch"
    ) {
      const init = node.arguments[1];
      if (
        init &&
        ts.isObjectLiteralExpression(init) &&
        init.properties.some((p) => propertyName(p, sf) === "next") &&
        isNonGetInit(init, sf)
      ) {
        lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe("a next option on a non-GET request", () => {
  it("is never sent on a raw fetch in application code", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const text = fs.readFileSync(file, "utf8");
      // Cheap pre-filter: most files have neither a fetch call nor a next key.
      if (!/\bfetch\(/.test(text) || !/\bnext\s*:/.test(text)) continue;
      const sf = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      for (const line of rawNonGetNextLines(sf)) {
        violations.push(`${path.relative(srcRoot, file)}:${line}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("tells a raw non-GET next option from the approved wrappers and from GETs", () => {
    const scan = (code: string) =>
      rawNonGetNextLines(
        ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      );

    expect(scan(`fetch(u, { method: "POST", body: "{}", next: { revalidate: 60 } });`)).toEqual([1]);
    expect(scan(`fetch(u, { method: "POST", next: { revalidate: 60 } });`)).toEqual([1]);
    expect(scan(`fetch(u, { method: verb, next: { revalidate: 60 } });`)).toEqual([1]);
    expect(scan(`fetch(u, { body: "{}", next: { revalidate: 60 } });`)).toEqual([1]);

    expect(scan(`fetch(u, { next: { revalidate: 60 } });`)).toEqual([]);
    expect(scan(`fetch(u, { method: "GET", next: { revalidate: 60 } });`)).toEqual([]);
    expect(scan(`fetch(u, { method: "HEAD", next: { revalidate: 60 } });`)).toEqual([]);
    expect(scan(`fetch(u, { method: "POST", body: "{}" });`)).toEqual([]);
    expect(
      scan(`serverFetchWithUserAgent(u, { method: "POST", body: "{}", next: { revalidate: 60 } });`),
    ).toEqual([]);
  });
});
