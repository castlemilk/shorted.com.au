/**
 * Every JSON-LD script is a <JsonLd>, and no raw-HTML sink takes the output of
 * JSON.stringify.
 *
 * Security review SEC-07: 60 call sites rendered
 * `<script type="application/ld+json" dangerouslySetInnerHTML={{ __html:
 * JSON.stringify(x) }} />`. React writes that text verbatim and JSON.stringify
 * leaves `<` alone, so a stored value carrying `</script>` (company metadata, a
 * report narrative, a scraped or model-written field) closed the element and
 * ran as markup. The CSP allows inline script, so it would not have stopped
 * it. <JsonLd> (components/seo/json-ld.tsx) serialises with serializeJsonLd,
 * which escapes `<`, `>` and `&` (lib/seo/__tests__/json-ld.test.tsx renders
 * it).
 *
 * What it checks, in every .ts and .tsx file under src/ but tests, mocks and
 * generated code, read with TypeScript's own parser:
 *  1. a string literal "application/ld+json" appears only in
 *     components/seo/json-ld.tsx, so a JSON-LD script cannot be written
 *     anywhere else;
 *  2. no `dangerouslySetInnerHTML` value calls JSON.stringify, directly or
 *     through a variable the same file declares.
 * Comments do not count.
 *
 * What it cannot see: markup another module builds and hands over as a
 * finished string.
 */

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC_DIR = path.resolve(__dirname, "../..");
const JSON_LD_COMPONENT = "@/components/seo/json-ld.tsx";
const SKIPPED_DIRS = new Set(["__tests__", "__mocks__", "gen", "node_modules"]);

/** Every source file under src/, as paths from src/. */
function sourceFiles(dir: string = SRC_DIR): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...sourceFiles(full));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      found.push(path.relative(SRC_DIR, full).split(path.sep).join("/"));
    }
  }
  return found.sort();
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

const lineOf = (file: ts.SourceFile, node: ts.Node): number =>
  file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

/** Lines of the string literals that name the JSON-LD script type. */
function jsonLdTypeLiterals(file: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.trim().toLowerCase() === "application/ld+json"
    ) {
      lines.push(lineOf(file, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

/** Initialisers of every variable this file declares under the name. */
function declarations(file: ts.SourceFile, name: string): ts.Expression[] {
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
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
}

/** Whether evaluating the expression can call JSON.stringify. */
function callsJsonStringify(
  node: ts.Node,
  file: ts.SourceFile,
  seen: Set<string> = new Set(),
): boolean {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(file).replace(/\s+/g, "") === "JSON.stringify"
  ) {
    return true;
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    seen.add(node.text);
    if (declarations(file, node.text).some((value) => callsJsonStringify(value, file, seen))) {
      return true;
    }
  }
  return ts.forEachChild(node, (child) => callsJsonStringify(child, file, seen) || undefined) ?? false;
}

/** Lines of `dangerouslySetInnerHTML` values that call JSON.stringify. */
function stringifiedInnerHtml(file: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    // The JSX attribute, or the same prop handed to createElement.
    const value =
      ts.isJsxAttribute(node) && node.name.getText(file) === "dangerouslySetInnerHTML"
        ? node.initializer
        : ts.isPropertyAssignment(node) && node.name.getText(file) === "dangerouslySetInnerHTML"
          ? node.initializer
          : undefined;
    if (value && callsJsonStringify(value, file)) lines.push(lineOf(file, node));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

describe("the scan", () => {
  const OLD_CALL_SITE = `
    export function Schema({ schema }: { schema: object }) {
      return (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
        />
      );
    }`;

  it("flags the call site SEC-07 found, on both counts", () => {
    const file = parse("old.tsx", OLD_CALL_SITE);

    expect(jsonLdTypeLiterals(file)).toEqual([5]);
    expect(stringifiedInnerHtml(file)).toEqual([6]);
  });

  it("follows a variable the file declares", () => {
    const file = parse(
      "indirect.tsx",
      `const html = JSON.stringify(data);
       export const A = () => <div dangerouslySetInnerHTML={{ __html: html }} />;`,
    );

    expect(stringifiedInnerHtml(file)).toEqual([2]);
  });

  it("flags the prop handed to createElement", () => {
    const file = parse(
      "create.ts",
      `createElement("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: JSON.stringify(x) } });`,
    );

    expect(jsonLdTypeLiterals(file)).toEqual([1]);
    expect(stringifiedInnerHtml(file)).toEqual([1]);
  });

  it("passes <JsonLd>, other raw HTML and a comment naming the type", () => {
    const file = parse(
      "clean.tsx",
      `// renders an application/ld+json script through JsonLd
       const css = \`.a{color:red}\`;
       export const A = () => (
         <>
           <JsonLd data={{ "@type": "Thing", name: JSON.stringify(1) }} />
           <style dangerouslySetInnerHTML={{ __html: css }} />
         </>
       );`,
    );

    expect(jsonLdTypeLiterals(file)).toEqual([]);
    expect(stringifiedInnerHtml(file)).toEqual([]);
  });
});

describe("JSON-LD in src/", () => {
  const files = sourceFiles();
  const parsed = files.map((name) => ({
    name,
    file: parse(name, fs.readFileSync(path.join(SRC_DIR, name), "utf8")),
  }));

  it("reads the whole tree, the component included", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(JSON_LD_COMPONENT);
    expect(files).toContain("app/layout.tsx");
  });

  it("names the application/ld+json type only in <JsonLd>", () => {
    const offenders = parsed.flatMap(({ name, file }) =>
      name === JSON_LD_COMPONENT
        ? []
        : jsonLdTypeLiterals(file).map((line) => `${name}:${line}`),
    );

    // Render the schema with <JsonLd data={schema} /> from
    // "~/@/components/seo/json-ld" instead of writing the script element.
    expect(offenders).toEqual([]);
  });

  it("<JsonLd> writes its script with serializeJsonLd", () => {
    const component = parsed.find(({ name }) => name === JSON_LD_COMPONENT)!.file;

    expect(jsonLdTypeLiterals(component)).toHaveLength(1);
    expect(component.getFullText()).toMatch(/__html:\s*serializeJsonLd\(/);
  });

  it("hands no JSON.stringify output to dangerouslySetInnerHTML", () => {
    const offenders = parsed.flatMap(({ name, file }) =>
      stringifiedInnerHtml(file).map((line) => `${name}:${line}`),
    );

    // JSON.stringify does not escape "<": use <JsonLd>, or serializeJsonLd
    // for JSON in any other raw-HTML sink.
    expect(offenders).toEqual([]);
  });
});
