/**
 * Editorial copy on the ownership surfaces: the register, the hub, the notice
 * feed and the register list, their components, the stock strip, the explorer's
 * server action that supplies the rows the feed and the list print, and the lib
 * that feeds them.
 *
 * Section 7 of the ownership explorer spec ("Copy") bans an em dash and four
 * phrases from this copy, because each one claims more than the source says.
 * "of the voting power" and "'s voting power" read a disclosed figure as a
 * share of the company, which it never is. "sold" and "sale" read a fall in a
 * notice's figure as a disposal, which it need not be. "index ETF" names the
 * wrong thing for a pooled file: Vanguard's files cover the wholesale fund
 * behind each ETF, not the ETF alone.
 *
 * What is read is the text a visitor can see or a screen reader can announce:
 * string literals, template text, JSX text and JSX attribute strings (with their
 * entities read, since `&mdash;` prints an em dash in either) and a literal `+`
 * chain, whose pieces are joined the way the browser joins them, so a phrase
 * split across two literals is one phrase. Runs of whitespace are read as one
 * space, as the browser shows them, so a phrase that Prettier wraps across lines
 * is one phrase too. Comments are not read: they print nowhere. A failure names
 * the rule and the line, and the fix is the copy, never this list. A test that
 * asserts a banned string is absent writes it as a regular expression literal,
 * which is not copy and is not read.
 */

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const APP_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.resolve(APP_DIR, "..");

/**
 * What is scanned: the pages, their components and the strip, the explorer's server action (its
 * rows are the copy the feed and the register list print), and the lib beneath them.
 */
const SCANNED = [
  path.join(APP_DIR, "ownership"),
  path.join(SRC_DIR, "@", "components", "ownership"),
  path.join(SRC_DIR, "@", "components", "stocks", "register-strip.tsx"),
  path.join(APP_DIR, "actions", "ownershipExplorer.ts"),
  path.join(SRC_DIR, "@", "lib", "ownership"),
];

/** Section 7's rule, one entry per ban. A failure names the rule, so the fix is the copy. */
const RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  { rule: "an em dash", pattern: /\u2014/ },
  { rule: "of the voting power", pattern: /of the voting power/i },
  { rule: "'s voting power", pattern: /['’]s voting power/i },
  { rule: "sold or sale", pattern: /\b(?:sold|sale)\b/i },
  { rule: "index ETF", pattern: /index ETF/i },
];

/**
 * JSX text and JSX attribute strings are raw source, so an entity can print what
 * the rule forbids. React decodes both, so the scan does too.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&mdash;|&#0*8212;|&#x0*2014;/gi, "\u2014")
    .replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, " ")
    .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
    .replace(/&rsquo;|&#0*8217;|&#x0*2019;/gi, "’");
}

/** The text a `+` chain of literals builds, or undefined when any operand is not a literal. */
function literalChain(node: ts.Expression): string | undefined {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalChain(node.left);
    const right = literalChain(node.right);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** The outermost `+` of a chain: the one whose parent is not another `+`, so each chain is read once. */
function isPlusChainRoot(node: ts.BinaryExpression): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  const parent = node.parent;
  return !(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken);
}

/** Every piece of text a source file prints, with its offset. */
function copyStrings(source: string, fileName: string): Array<{ text: string; at: number }> {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: Array<{ text: string; at: number }> = [];
  const visit = (node: ts.Node): void => {
    const at = node.getStart(sourceFile);
    if (ts.isBinaryExpression(node) && isPlusChainRoot(node)) {
      const joined = literalChain(node);
      if (joined !== undefined) found.push({ text: joined, at });
    } else if (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent)) {
      found.push({ text: decodeEntities(node.text), at });
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push({ text: node.text, at });
    } else if (ts.isJsxText(node)) {
      found.push({ text: decodeEntities(node.text), at });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** One message per rule a piece of copy breaks, with its line. */
function copyProblems(source: string, fileName: string): string[] {
  return copyStrings(source, fileName).flatMap(({ text, at }) => {
    const line = source.slice(0, at).split("\n").length;
    // The browser prints a line break in the source as a space (JSX and HTML both collapse it),
    // so a phrase that Prettier wraps is one phrase to the rules.
    const printed = text.replace(/\s+/g, " ");
    return RULES.filter(({ pattern }) => pattern.test(printed)).map(
      ({ rule }) => `${rule} at line ${line}: ${JSON.stringify(printed.slice(0, 120))}`,
    );
  });
}

/** Every .ts and .tsx file under a path, tests included: a test string prints nowhere, but it is held to the same rule. */
function sourceFilesUnder(target: string): string[] {
  if (fs.statSync(target).isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const read = (file: string): string => fs.readFileSync(file, "utf-8");

/** The path under web/src, with "/" separators, as a test name prints it. */
const relative = (file: string): string => path.relative(SRC_DIR, file).split(path.sep).join("/");

const files = SCANNED.flatMap((target) => sourceFilesUnder(target)).sort();

describe("ownership editorial copy", () => {
  it("reads the ownership pages, their components, the strip, the explorer's action and the lib", () => {
    expect(files.map(relative)).toEqual(
      expect.arrayContaining([
        "app/ownership/page.tsx",
        "app/ownership/stocks/[code]/page.tsx",
        "app/ownership/notices/page.tsx",
        "app/ownership/stocks/page.tsx",
        "@/components/ownership/ownership-parts.tsx",
        "@/components/ownership/notice-feed-explorer.tsx",
        "@/components/ownership/notice-week-bars.tsx",
        "@/components/ownership/notice-mark.tsx",
        "@/components/ownership/registers-explorer.tsx",
        "@/components/ownership/register-rows-table.tsx",
        "@/components/stocks/register-strip.tsx",
        "app/actions/ownershipExplorer.ts",
        "@/lib/ownership/trace.ts",
      ]),
    );
  });

  it.each(files.map((file) => [relative(file), file] as const))(
    "%s prints no em dash and none of the phrases section 7 bans",
    (_name, file) => {
      expect(copyProblems(read(file), file)).toEqual([]);
    },
  );

  describe("the scanner", () => {
    const flagged = (code: string): string[] => copyProblems(code, "fixture.tsx");

    it.each([
      ["an em dash", 'export const a = "Notices \u2014 read";'],
      ["of the voting power", 'export const a = "a share of the voting power";'],
      ["'s voting power", 'export const a = "Vanguard\'s voting power";'],
      ["sold or sale", 'export const a = "the holder sold";'],
      ["sold or sale", 'export const a = "a sale";'],
      ["index ETF", 'export const a = "Index ETFs";'],
    ])("flags %s in a string literal", (rule, code) => {
      const problems = flagged(code);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${rule} at line 1`);
    });

    it("flags a phrase in a template, in template text before a substitution, and in JSX", () => {
      expect(flagged("export const a = `a share of the voting power`;")).toHaveLength(1);
      expect(flagged("export const a = `of the voting power ${b}`;")).toHaveLength(1);
      expect(flagged("export const A = () => <p>Notices \u2014 read</p>;")).toHaveLength(1);
      expect(flagged("export const A = () => <p>Notices &mdash; read</p>;")).toHaveLength(1);
      expect(flagged("export const A = () => <p>Vanguard&apos;s voting power</p>;")).toHaveLength(1);
      expect(flagged('export const A = () => <img alt="Sold out" />;')).toHaveLength(1);
    });

    it("reads the entities of a JSX attribute string, as React does", () => {
      const alt = flagged('export const A = () => <img alt="Notices &mdash; read" />;');
      expect(alt).toHaveLength(1);
      expect(alt[0]).toContain("an em dash at line 1");
      expect(flagged('export const A = () => <p aria-label="Vanguard&apos;s voting power" />;')).toHaveLength(1);
      expect(flagged('export const A = () => <p title="Vanguard&#x2019;s voting power" />;')).toHaveLength(1);
      expect(flagged('export const A = () => <img alt="Notices read" />;')).toEqual([]);
    });

    it("reads a phrase split across a + chain of literals as one phrase", () => {
      const problems = flagged('export const a = "of the " + "voting power";');
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("of the voting power at line 1");
    });

    it("reads a line break as the space the browser prints, so a phrase that Prettier wraps is one phrase", () => {
      const jsx = flagged("export const A = () => (\n  <p>\n    a share of the voting\n    power\n  </p>\n);");
      expect(jsx).toHaveLength(1);
      expect(jsx[0]).toContain("of the voting power at line 3");
      const template = flagged("export const a = `a share of the voting\n    power`;");
      expect(template).toHaveLength(1);
      expect(template[0]).toContain("of the voting power at line 1");
      expect(flagged("export const A = () => <p>of the voting&nbsp;power</p>;")).toHaveLength(1);
    });

    it("gives the line of the copy, not of the file", () => {
      expect(flagged('export const a = 1;\nexport const b = "a sale";')[0]).toContain(
        "sold or sale at line 2",
      );
    });

    it("ignores comments, identifiers, and words that only contain a banned one", () => {
      expect(flagged("// the holder sold a share of the voting power\nexport const a = 1;")).toEqual([]);
      expect(flagged("/** an index ETF */\nexport const sold = 1; export const sale = 2;")).toEqual([]);
      expect(flagged('export const a = "wholesale and the sales desk";')).toEqual([]);
    });
  });
});
