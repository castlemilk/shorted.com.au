/**
 * A file that prints an industry asks industryLabel.
 *
 * Why this test exists. The ASX writes "Not Applic" or "Class Pend" in the
 * industry field of a security it has not classified, and a surface that
 * prints the field as it comes prints the placeholder. On production
 * (2026-10-14) AFI's Company tab listed six peers as "Not Applic", its Short
 * interest tab offered "5 largest Not Applic peers", and the weekly report's
 * industry table had a "Class Pend" row. industry-placeholder.ts holds the one
 * list; this test finds a file that prints the field without asking it.
 *
 * What counts as printing: a `.industry` read that is the whole of a JSX child
 * (`{row.industry}`, `{row.industry || "—"}`), of a printed attribute (title,
 * alt, aria-label, content, placeholder), or of a template literal's
 * substitution (`${row.industry}`). Source is read with TypeScript's parser,
 * so a comment or a string never matches. A key, a value, a prop handed on to
 * another component and a comparison are not printing.
 *
 * The rule is per file: a file that prints one passes once it imports
 * industryLabel, so a component can label its rows once (drop a placeholder's
 * row, then print the rest) instead of wrapping every print. The cost is that a
 * second, raw print in a file that already imports the helper goes unseen, as
 * does an industry printed under another name (`{industry}`), read with
 * brackets, or built by concatenation. The component tests that hand a
 * placeholder in cover those.
 */

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC = path.resolve(__dirname, "../..");

const SKIPPED_DIRS = new Set(["gen", "__tests__", "__mocks__", "mocks", "node_modules"]);
const SKIPPED_FILE = /\.(test|spec|stories)\.tsx?$/;
const PRINTED_ATTRIBUTES = new Set(["title", "alt", "aria-label", "content", "placeholder"]);

/**
 * Files whose printed `.industry` is never a security's raw field. Each entry
 * says what it prints instead.
 */
const PRINTS_NO_RAW_FIELD: Record<string, string> = {
  [path.join("@", "components", "search", "stock-search-filters.tsx")]:
    "the reader's own filter, chosen from the file's fixed INDUSTRIES list",
  [path.join("app", "statistics", "page.tsx")]:
    'getShortStatistics\'s groups, keyed by industryLabel(...) || "Other"',
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !SKIPPED_FILE.test(entry.name) ? [full] : [];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function importsIndustryLabel(source: ts.SourceFile): boolean {
  return source.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      /(^|\/)industry-placeholder$/.test(s.moduleSpecifier.text) &&
      s.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some((e) => e.name.text === "industryLabel"),
  );
}

/** `x.industry`, or one on the left of `||` / `??` (a fallback is still the field). */
function readsIndustry(expression: ts.Expression): boolean {
  let e = expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e)) return e.name.text === "industry";
  if (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return readsIndustry(e.left);
  }
  return false;
}

/** The lines of `source` that print a `.industry` read. */
function industryPrints(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isJsxExpression(node) && node.expression && readsIndustry(node.expression)) {
      const parent = node.parent;
      const printed =
        ts.isJsxElement(parent) ||
        ts.isJsxFragment(parent) ||
        (ts.isJsxAttribute(parent) && PRINTED_ATTRIBUTES.has(parent.name.getText(source)));
      if (printed) lines.push(lineOf(node));
    }
    if (ts.isTemplateSpan(node) && readsIndustry(node.expression)) lines.push(lineOf(node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe("printed industries", () => {
  const files = sourceFiles(SRC);

  it("come from files that ask industryLabel, so no ASX placeholder reaches a reader", () => {
    const unlabelled = files.flatMap((file) => {
      const relative = path.relative(SRC, file);
      if (relative in PRINTS_NO_RAW_FIELD) return [];
      const source = parse(file);
      if (importsIndustryLabel(source)) return [];
      return industryPrints(source).map((line) => `${relative}:${line}`);
    });
    expect(unlabelled).toEqual([]);
  });

  it("are looked for where they are printed", () => {
    const relative = files.map((f) => path.relative(SRC, f));
    expect(relative).toContain(path.join("@", "components", "company", "stock-connections.tsx"));
    expect(relative).toContain(path.join("app", "shorts", "[stockCode]", "page.tsx"));
    expect(relative).not.toContain(path.join("@", "lib", "industry-placeholder-usage.test.ts"));
  });

  it("have exemptions only for files that still print one", () => {
    for (const relative of Object.keys(PRINTS_NO_RAW_FIELD)) {
      expect(industryPrints(parse(path.join(SRC, relative))).length).toBeGreaterThan(0);
    }
  });
});
