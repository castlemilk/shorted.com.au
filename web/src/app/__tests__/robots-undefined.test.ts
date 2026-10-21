/**
 * No page or layout may declare a `robots` value that can be undefined.
 *
 * Next 14.2 merges metadata with `for (key in source)`, so an own key holding
 * undefined still replaces the parent's value. `robots: indexable ? undefined :
 * NOINDEX` therefore does not "inherit the default" when indexable: it wipes the
 * root layout's robots, and the page emits no robots or googlebot meta at all,
 * losing `max-image-preview:large` and `max-snippet:-1`. Found 2026-10-21 on
 * 6,655 sitemap URLs (suburbs, politicians, the three report series and the
 * insider pages; docs/seo-audit follow-up, finding 3). The fix is to omit the
 * key: `...(noindex ? { robots: NOINDEX } : {})`, as lib/seo/stock-tab-metadata
 * does.
 *
 * What it checks. Every `robots:` property in a page or layout under app/, read
 * with TypeScript's own parser, whose value can be undefined: a ternary or a
 * `??` / `||` with an undefined, null or void branch, any `cond && X` (false is
 * no better than undefined), or a bare `undefined`. A shorthand `{ robots }`
 * is checked against the file's own `robots` declarations.
 *
 * What it cannot see. A value computed in another module (a helper returning
 * `undefined`) is out of its reach; the per-route metadata tests pin those
 * routes' rendered output.
 */

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const APP_DIR = path.resolve(__dirname, "..");

/** Every page and layout under app/, tests excluded, as paths from app/. */
function routeFiles(dir: string = APP_DIR): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") found.push(...routeFiles(full));
    } else if (/^(page|layout)\.tsx?$/.test(entry.name)) {
      found.push(path.relative(APP_DIR, full).split(path.sep).join("/"));
    }
  }
  return found.sort();
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isEmptyValue(node: ts.Expression): boolean {
  const value = unwrap(node);
  return (
    (ts.isIdentifier(value) && value.text === "undefined") ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value)
  );
}

/** True when the expression can evaluate to undefined, null, void or false. */
function canBeEmpty(node: ts.Expression): boolean {
  const value = unwrap(node);
  if (isEmptyValue(value)) return true;
  if (ts.isConditionalExpression(value)) {
    return canBeEmpty(value.whenTrue) || canBeEmpty(value.whenFalse);
  }
  if (ts.isBinaryExpression(value)) {
    const op = value.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return true;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return canBeEmpty(value.right);
    }
  }
  return false;
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Every `robots` property in the source whose value can be empty, as "line: text". */
function emptyRobots(fileName: string, source: string): string[] {
  const file = parse(fileName, source);
  const declared: ts.Expression[] = [];
  const shorthand: ts.ShorthandPropertyAssignment[] = [];
  const found: string[] = [];
  const at = (node: ts.Node) =>
    `${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${node
      .getText(file)
      .replace(/\s+/g, " ")}`;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "robots" &&
      node.initializer
    ) {
      declared.push(node.initializer);
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === "robots" &&
      canBeEmpty(node.initializer)
    ) {
      found.push(at(node));
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "robots") {
      shorthand.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (declared.some(canBeEmpty)) found.push(...shorthand.map(at));
  return found;
}

describe("robots metadata", () => {
  const files = routeFiles();

  it("finds the app's pages and layouts", () => {
    // A broken walk would pass the scan below vacuously.
    expect(files).toContain("layout.tsx");
    expect(files).toContain("housing/[state]/[suburb]/page.tsx");
    expect(files.length).toBeGreaterThan(100);
  });

  it("is never a value that can be undefined in any page or layout", () => {
    const offenders = files.flatMap((file) =>
      emptyRobots(file, fs.readFileSync(path.join(APP_DIR, file), "utf8")).map(
        (hit) => `${file}:${hit}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  // The scan has to recognise the shapes it exists to stop, or it passes on
  // nothing. These are the six lines it found on 2026-10-21, and their kin.
  it.each([
    "robots: indexable ? undefined : { index: false, follow: true },",
    "robots: noindex ? { index: false, follow: true } : undefined,",
    "robots: noindex ? NOINDEX : void 0,",
    "robots: noindex && NOINDEX,",
    "robots: override ?? undefined,",
    "robots: undefined,",
    "robots: (noindex ? NOINDEX : null) as Metadata['robots'],",
  ])("flags %s", (line) => {
    expect(emptyRobots("page.tsx", `const m = { ${line} };`)).toHaveLength(1);
  });

  it("flags a shorthand robots whose declaration can be undefined", () => {
    const source = `
      const robots = noindex ? NOINDEX : undefined;
      export const metadata = { title: "t", robots };
    `;
    expect(emptyRobots("page.tsx", source)).toHaveLength(1);
  });

  it.each([
    "...(noindex ? { robots: NOINDEX } : {}),",
    "robots: { index: false, follow: true },",
    "robots: noindex ? NOINDEX : INDEX,",
    'robots: "noindex, nofollow",',
    "robots: override ?? NOINDEX,",
  ])("allows %s", (line) => {
    expect(emptyRobots("page.tsx", `const m = { ${line} };`)).toEqual([]);
  });
});
