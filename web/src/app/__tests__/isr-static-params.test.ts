/**
 * A dynamic route's `revalidate` is inert without generateStaticParams.
 *
 * Next 14 statically optimises a route with a dynamic segment ([slug],
 * [stockCode], ...) only when generateStaticParams EXISTS, for the page or
 * for a layout above it. Without one the route renders on every request,
 * served `private, no-store`, whatever its `revalidate` says. That was ~940
 * sitemap URLs on 2026-10-21: every blog post, take, compare pair and insider
 * page. The fix is the stock pages' rule: an empty generateStaticParams with
 * `dynamicParams = true`, so nothing renders at build and each URL generates
 * on its first request (see app/shorts/[stockCode]/page.tsx). Only for a page
 * whose render fails, or caps its lifetime, when a read fails: ISR caches
 * whatever a regeneration returns, so a page that answers a failed read with
 * a 404 or an empty list would serve that for its whole revalidate
 * (isr-degraded-render.test.ts checks each such page). Takes and insider
 * pages were kept per request for that until their reads failed closed.
 *
 * The check: every page.tsx under a dynamic segment that exports `revalidate`
 * also has a generateStaticParams export, in the page or in a layout.tsx
 * between it and app/. Exports are read off the syntax tree, so a
 * commented-out export does not count. What this cannot see is a read that
 * makes the generated route dynamic again (searchParams, cookies, a no-store
 * fetch); app/shorts/__tests__/isr-source-safety.test.ts covers the stock
 * segment's own files and serverApiSurface.test.ts the transports.
 */

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const APP_DIR = path.resolve(__dirname, "..");

/**
 * Pages that export `revalidate` but have no generateStaticParams, on purpose
 * or until their owner fixes them. Paths are relative to app/. Each entry must
 * still be a page that breaks the rule (checked below), so the list can only
 * shrink.
 */
const ALLOWED: Record<string, string> = {
  // Per request by design: an operator console that reads the session
  // (`dynamic = "force-dynamic"`, `revalidate = 0`).
  "admin/register/politicians/[slug]/page.tsx": "admin console, per request by design",
};

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/**
 * The names a module exports as `export const x`, `export function x` or
 * `export { x }`. Default exports are left out.
 */
function exportedNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported =
      modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true &&
      !modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (exported && ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (exported && ts.isVariableStatement(statement)) {
      for (const { name } of statement.declarationList.declarations) {
        if (ts.isIdentifier(name)) names.add(name.text);
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
    }
  }
  return names;
}

const isDynamicSegment = (segment: string): boolean => /^\[.+\]$/.test(segment);

/** Every page.tsx under app/ whose path has a dynamic segment, relative to app/. */
function dynamicPages(dir: string = APP_DIR): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") found.push(...dynamicPages(full));
    } else if (entry.name === "page.tsx") {
      const relative = path.relative(APP_DIR, full).split(path.sep).join("/");
      if (relative.split("/").slice(0, -1).some(isDynamicSegment)) found.push(relative);
    }
  }
  return found.sort();
}

/** True when the page, or a layout above it inside app/, exports generateStaticParams. */
function hasStaticParams(page: string): boolean {
  const segments = page.split("/").slice(0, -1);
  if (exportedNames(parse(path.join(APP_DIR, page))).has("generateStaticParams")) return true;
  for (let depth = segments.length; depth > 0; depth--) {
    const layout = path.join(APP_DIR, ...segments.slice(0, depth), "layout.tsx");
    if (fs.existsSync(layout) && exportedNames(parse(layout)).has("generateStaticParams")) {
      return true;
    }
  }
  return false;
}

/** The dynamic pages whose `revalidate` export is inert. */
function inertRevalidates(): string[] {
  return dynamicPages().filter(
    (page) =>
      exportedNames(parse(path.join(APP_DIR, page))).has("revalidate") && !hasStaticParams(page),
  );
}

describe("dynamic routes that export revalidate", () => {
  it("finds the dynamic pages, nested ones included", () => {
    expect(dynamicPages()).toEqual(
      expect.arrayContaining([
        "blog/[slug]/page.tsx",
        "news/[slug]/page.tsx",
        "compare/[pair]/page.tsx",
        "insider-trading/[stockCode]/page.tsx",
        "shorts/[stockCode]/page.tsx",
        "shorts/[stockCode]/company/page.tsx",
        "housing/[state]/[suburb]/page.tsx",
      ]),
    );
  });

  it("export generateStaticParams, in the page or a layout above it", () => {
    expect(inertRevalidates().filter((page) => !(page in ALLOWED))).toEqual([]);
  });

  it("allow only pages that exist and still break the rule", () => {
    const inert = inertRevalidates();
    for (const page of Object.keys(ALLOWED)) {
      expect(fs.existsSync(path.join(APP_DIR, page))).toBe(true);
      expect(inert).toContain(page);
    }
  });

  describe("exportedNames", () => {
    const names = (code: string) =>
      exportedNames(
        ts.createSourceFile("page.tsx", code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX),
      );

    it("reads every spelling a route file uses", () => {
      expect(
        names(
          [
            "export const revalidate = 3600;",
            "export function generateStaticParams() { return []; }",
            "export async function generateMetadata() { return {}; }",
            "const dynamicParams = true; export { dynamicParams };",
          ].join("\n"),
        ),
      ).toEqual(new Set(["revalidate", "generateStaticParams", "generateMetadata", "dynamicParams"]));
    });

    it("ignores comments, unexported declarations and default exports", () => {
      expect(
        names(
          [
            "// export function generateStaticParams() { return []; }",
            "/* export const revalidate = 60; */",
            "const revalidate = 60;",
            "export default function generateStaticParams() { return []; }",
          ].join("\n"),
        ),
      ).toEqual(new Set());
    });
  });
});
