/**
 * No page or layout title may carry the brand: the root layout's template
 * (`%s | Shorted`) appends it.
 *
 * A title that brings its own brand renders it twice. The 2026-10-21 probe
 * found "ASX Short Selling Datasets | Open Data Hub | Shorted | Shorted"
 * (/data), "… Director Trades | Shorted | Shorted" (/insider-trading),
 * "Alerts — Shorted | Shorted" and the near-doubles "Press & Media Kit —
 * Shorted.com.au | Shorted" and "Product Roadmap | Shorted Feature Development |
 * Shorted" (seo-review finding 12). A page whose title must lead with the brand,
 * or already ends with it, says so with `title: { absolute }` (the homepage and
 * /top do).
 *
 * What it checks. The document title of every metadata object in a page or
 * layout under app/: the `metadata` export and the objects `generateMetadata`
 * returns. `title`, `title.default` and a same-file variable passed as either
 * are read with TypeScript's own parser, through ternaries and `??`; a template
 * placeholder `${siteConfig.name}` counts as the brand. A title fails when the
 * brand follows a separator (`| Shorted`, `— Shorted`, `- Shorted`, so a
 * mid-title "| Shorted API" too) or names the domain (`Shorted.com.au`).
 * `title.absolute` and `title.template` are exempt, and so are openGraph and
 * twitter titles: the template does not apply to them.
 *
 * What it cannot see. A title built in another module (lib/seo builders) or
 * returned through a helper is out of its reach.
 */

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const APP_DIR = path.resolve(__dirname, "..");

/**
 * Files with a known doubled brand that another workstream owns. The scan
 * skips them, and a check below fails once one no longer carries the brand:
 * delete the entry when its fix lands, so the scan covers the file again.
 */
const KNOWN_OFFENDERS: Record<string, string> = {};

/** The brand after a separator, or the domain. "Most Shorted ASX" is fine. */
const BRAND = /(?:[|—–]|\s-)\s*Shorted\b|Shorted\.com\.au/;

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

const nameOf = (node: ts.ObjectLiteralElementLike): string | undefined =>
  node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ? node.name.text
    : undefined;

/** Every value the file assigns to a variable of this name. */
function assignedValues(file: ts.SourceFile, name: string): ts.Expression[] {
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      values.push(node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      values.push(node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
}

/** The literal texts an expression can produce; placeholders stay as `${…}`. */
function texts(node: ts.Expression, file: ts.SourceFile, seen = new Set<string>()): string[] {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return [value.text];
  }
  if (ts.isTemplateExpression(value)) {
    let text = value.head.text;
    for (const span of value.templateSpans) {
      const expression = span.expression.getText(file);
      text += /\bsiteConfig\.name$/.test(expression) ? "Shorted" : `\${${expression}}`;
      text += span.literal.text;
    }
    return [text];
  }
  if (ts.isConditionalExpression(value)) {
    return [...texts(value.whenTrue, file, seen), ...texts(value.whenFalse, file, seen)];
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...texts(value.left, file, seen), ...texts(value.right, file, seen)];
  }
  if (ts.isIdentifier(value) && !seen.has(value.text)) {
    seen.add(value.text);
    return assignedValues(file, value.text).flatMap((v) => texts(v, file, seen));
  }
  return [];
}

/** The `metadata` export's object and every object `generateMetadata` returns. */
function metadataObjects(file: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const objects: ts.ObjectLiteralExpression[] = [];
  const collect = (node: ts.Expression): void => {
    const value = unwrap(node);
    if (ts.isObjectLiteralExpression(value)) objects.push(value);
    if (ts.isConditionalExpression(value)) {
      collect(value.whenTrue);
      collect(value.whenFalse);
    }
  };
  const collectReturns = (body: ts.Node): void => {
    const visit = (node: ts.Node): void => {
      // A nested function's returns are not generateMetadata's.
      if (node !== body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) collect(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(body);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === "metadata") collect(node.initializer);
      if (node.name.text === "generateMetadata") {
        const fn = unwrap(node.initializer);
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
          if (ts.isBlock(fn.body)) collectReturns(fn.body);
          else collect(fn.body);
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "generateMetadata" && node.body) {
      collectReturns(node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return objects;
}

/** The document-title texts of one metadata object. */
function documentTitles(meta: ts.ObjectLiteralExpression, file: ts.SourceFile): string[] {
  const titles: string[] = [];
  for (const property of meta.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === "title") {
      titles.push(...texts(property.name, file));
    }
    if (!ts.isPropertyAssignment(property) || nameOf(property) !== "title") continue;
    const value = unwrap(property.initializer);
    if (ts.isObjectLiteralExpression(value)) {
      // `absolute` opts out of the template; `template` is the template.
      for (const part of value.properties) {
        if (ts.isPropertyAssignment(part) && nameOf(part) === "default") {
          titles.push(...texts(part.initializer, file));
        }
      }
    } else {
      titles.push(...texts(value, file));
    }
  }
  return titles;
}

function brandedTitles(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return metadataObjects(file)
    .flatMap((meta) => documentTitles(meta, file))
    .filter((title) => BRAND.test(title));
}

describe("page titles", () => {
  const files = routeFiles();

  it("finds the app's pages and layouts", () => {
    // A broken walk would pass the scan below vacuously.
    expect(files).toContain("data/page.tsx");
    expect(files.length).toBeGreaterThan(100);
    for (const known of Object.keys(KNOWN_OFFENDERS)) expect(files).toContain(known);
  });

  it("never carry the brand the root template appends", () => {
    const offenders = files
      .filter((file) => !(file in KNOWN_OFFENDERS))
      .flatMap((file) =>
        brandedTitles(file, fs.readFileSync(path.join(APP_DIR, file), "utf8")).map(
          (title) => `${file}: ${title}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  // A skipped file whose fix has landed would stay out of the scan for good:
  // nothing else fails when its entry goes stale.
  it("skips only files that still carry the brand (delete an entry once its fix lands)", () => {
    const fixed = Object.keys(KNOWN_OFFENDERS).filter(
      (file) => brandedTitles(file, fs.readFileSync(path.join(APP_DIR, file), "utf8")).length === 0,
    );
    expect(fixed).toEqual([]);
  });

  // The scan has to recognise the shapes it exists to stop, or it passes on
  // nothing.
  it.each([
    ['export const metadata = { title: "Alerts — Shorted" };', "an em-dash brand"],
    ['export const metadata = { title: "ASX Insider Trading | Shorted" };', "a pipe brand"],
    ['export const metadata = { title: "Roadmap - Shorted" };', "a hyphen brand"],
    ['export const metadata = { title: "Press & Media Kit — Shorted.com.au" };', "the domain"],
    ['export const metadata = { title: "Product Roadmap | Shorted Feature Development" };', "a mid-title brand"],
    ["export const metadata = { title: `${name} | ${siteConfig.name}` };", "the brand placeholder"],
    ['export const metadata = { title: { default: "Docs | Shorted", template: "%s" } };', "title.default"],
    [
      'export async function generateMetadata() { if (!a) return { title: "Author Not Found | Shorted" }; return { title: "x" }; }',
      "an early return",
    ],
    [
      "export async function generateMetadata() { const title = `${a.name} — ${a.role} | Shorted`; return { title }; }",
      "a shorthand title variable",
    ],
    [
      'export const generateMetadata = async () => ({ title: ok ? "Ok" : "Missing | Shorted" });',
      "a ternary branch in an arrow",
    ],
  ])("flags %s (%s)", (source) => {
    expect(brandedTitles("page.tsx", source)).toHaveLength(1);
  });

  it.each([
    ['export const metadata = { title: "Most Shorted ASX Stocks" };', "brand-free"],
    ['export const metadata = { title: { absolute: "Most Shorted ASX Stocks | Shorted" } };', "absolute"],
    [
      'export async function generateMetadata() { let title = "Top | Shorted"; return { title: { absolute: title } }; }',
      "an absolute variable",
    ],
    [
      'export const metadata = { title: "Data", openGraph: { title: "Data | Shorted" }, twitter: { title: "Data | Shorted" } };',
      "social titles",
    ],
    ['const sections = [{ title: "Using Shorted.com.au" }];', "a non-metadata object"],
  ])("allows %s (%s)", (source) => {
    expect(brandedTitles("page.tsx", source)).toEqual([]);
  });
});
