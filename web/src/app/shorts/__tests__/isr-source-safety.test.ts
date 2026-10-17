/**
 * ISR source safety for the stock segment (app/shorts/[stockCode]/**).
 *
 * Why this test exists. scripts/route-kinds.mjs gates the build on Next's
 * prerender manifest: a stock route that is not listed under `dynamicRoutes`
 * is rendered on every request. That catches a page that lost its ISR exports
 * (generateStaticParams) or opted out of the cache (`revalidate = 0`,
 * `dynamic = "force-dynamic"`). It cannot see a read of cookies(), headers(),
 * searchParams or a no-store fetch: every tab keeps an EMPTY
 * generateStaticParams, so Next renders nothing at build time, never observes
 * the read, and leaves the route listed. The read fails at request time
 * instead (a 500 under `next start`, measured on Next 14.2.13). The design's
 * rule, "No page or layout reads searchParams, cookies() or headers()" (the
 * stock-page-tab-routes spec, section 2), is therefore enforced here, from
 * source, and the build gate covers only the half it can see.
 *
 * What it checks:
 *  1. No source file in the segment (tests excluded) reads a dynamic API or
 *     opts out of the cache. DYNAMIC_READS below is the list.
 *  2. Every page.tsx in the segment exports the ISR trio: a literal positive
 *     `revalidate`, `dynamicParams = true` and `generateStaticParams`. The
 *     thread page is exempt: it is dynamic by design (it renders per request
 *     and the spec leaves it where it is).
 *
 * Comments do not count. Several files here name these APIs in a comment
 * precisely to say they are not used. Comments are removed with TypeScript's
 * own parser, which drives its scanner: a `//` inside a string, a template, a
 * regular expression or JSX text is not a comment, and a regex pass cannot
 * tell (the withoutComments helper in ssr-import-safety.test.ts says so). What
 * is left is searched as text, so a word inside a string or JSX text still
 * counts. That is conservative on purpose.
 *
 * What it cannot see. It reads the segment's own files. A dynamic-API read
 * inside a component or helper that a page imports from elsewhere, or behind
 * an aliased import (`import { cookies as jar }`), is out of its reach. A
 * request-level check covers those: the second request for a tab must be a
 * cache HIT (the spec's rollout checks, section 6).
 */

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { STOCK_TABS } from "~/@/lib/stocks/stock-tabs";

const STOCK_DIR = path.resolve(__dirname, "../[stockCode]");

/** Pages that are dynamic by design, and so are not held to the ISR trio. Their reads are still scanned. */
const DYNAMIC_BY_DESIGN = ["community/[threadId]/page.tsx"];

/**
 * Everything that makes a page dynamic, or opts it out of the cache, as it is
 * spelled in code. Whitespace and quote style do not matter. A longer or
 * differently cased name is not a match: `URLSearchParams` and `getHeaders(`
 * are fine, and `useSearchParams` has an entry of its own.
 */
const DYNAMIC_READS: ReadonlyArray<{ read: string; pattern: RegExp }> = [
  { read: "cookies(", pattern: /\bcookies\s*\(/ },
  { read: "headers(", pattern: /\bheaders\s*\(/ },
  { read: "auth(", pattern: /\bauth\s*\(/ },
  { read: "searchParams", pattern: /\bsearchParams\b/ },
  { read: "useSearchParams", pattern: /\buseSearchParams\b/ },
  { read: "unstable_noStore", pattern: /\bunstable_noStore\b/ },
  { read: "noStore(", pattern: /\bnoStore\s*\(/ },
  { read: 'cache: "no-store"', pattern: /\bcache["']?\s*:\s*(["'`])no-store\1/ },
  {
    read: 'dynamic = "force-dynamic"',
    pattern: /\bdynamic\s*=\s*(["'`])force-dynamic\1/,
  },
  // `revalidate = 0` in a segment config, and `{ next: { revalidate: 0 } }` on a fetch.
  { read: "revalidate = 0", pattern: /\brevalidate\s*[:=]\s*0(?![\d.])/ },
];

const parse = (source: string, fileName: string): ts.SourceFile =>
  ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/**
 * The source with every comment blanked to spaces, so offsets and line breaks
 * survive. The parser finds the tokens; whatever sits between two tokens is
 * trivia, so what is not whitespace there is a comment. JSDoc nodes are
 * skipped for the same reason: they are comments the parser happens to
 * understand.
 */
function withoutComments(source: string, fileName: string): string {
  const sourceFile = parse(source, fileName);
  const tokens: Array<[start: number, end: number]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) tokens.push([node.getStart(sourceFile), node.end]);
    else children.forEach(visit);
  };
  visit(sourceFile);

  let code = "";
  let from = 0;
  for (const [start, end] of tokens) {
    code += source.slice(from, start).replace(/\S/g, " ") + source.slice(start, end);
    from = end;
  }
  return code + source.slice(from).replace(/\S/g, " ");
}

/** The entries of DYNAMIC_READS that this source contains, comments aside. */
function dynamicReads(source: string, fileName = "fixture.tsx"): string[] {
  const code = withoutComments(source, fileName);
  return DYNAMIC_READS.filter(({ pattern }) => pattern.test(code)).map(({ read }) => read);
}

interface ExportedValue {
  initializer: ts.Expression | undefined;
  /** What the export is, for the message: its initializer's text, or "a function". */
  text: string;
}

/**
 * What is wrong with a page's ISR exports, one message per problem. Read off
 * the syntax tree, so a commented-out export does not count. Only
 * `export const x = …` and `export function x` count as exports, the two
 * spellings the tab pages use; a re-export or a default export is reported as
 * missing, so a page that changes how it exports has to change this on purpose.
 */
function isrExportProblems(source: string, fileName = "page.tsx"): string[] {
  const sourceFile = parse(source, fileName);
  const exported = new Map<string, ExportedValue>();
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const isNamedExport =
      modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true &&
      !modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (!isNamedExport) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      exported.set(statement.name.text, { initializer: undefined, text: "a function" });
    } else if (ts.isVariableStatement(statement)) {
      for (const { name, initializer } of statement.declarationList.declarations) {
        if (ts.isIdentifier(name)) {
          exported.set(name.text, {
            initializer,
            text: initializer?.getText(sourceFile) ?? "no value",
          });
        }
      }
    }
  }

  const problems: string[] = [];
  const revalidate = exported.get("revalidate");
  if (!revalidate) {
    problems.push("revalidate is not exported");
  } else if (
    !(
      revalidate.initializer &&
      ts.isNumericLiteral(revalidate.initializer) &&
      Number(revalidate.initializer.text) > 0
    )
  ) {
    problems.push(`revalidate must be a literal positive number, found ${revalidate.text}`);
  }
  const dynamicParams = exported.get("dynamicParams");
  if (!dynamicParams) {
    problems.push("dynamicParams is not exported");
  } else if (dynamicParams.initializer?.kind !== ts.SyntaxKind.TrueKeyword) {
    problems.push(`dynamicParams must be true, found ${dynamicParams.text}`);
  }
  if (!exported.has("generateStaticParams")) {
    problems.push("generateStaticParams is not exported");
  }
  return problems;
}

/** Every .ts/.tsx file beneath the segment except tests, sorted. */
function segmentSourceFiles(dir: string = STOCK_DIR): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") found.push(...segmentSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}

const read = (file: string): string => fs.readFileSync(file, "utf-8");

/** [path from the segment root, absolute path], with "/" separators. */
const files = segmentSourceFiles().map(
  (file) => [path.relative(STOCK_DIR, file).split(path.sep).join("/"), file] as const,
);
const pages = files.filter(([name]) => path.posix.basename(name) === "page.tsx");
const isrPages = pages.filter(([name]) => !DYNAMIC_BY_DESIGN.includes(name));

describe("stock segment ISR source safety", () => {
  describe("the segment's own files", () => {
    it("finds the layout, the loader, the OG image, the thread page and every tab page", () => {
      expect(files.map(([name]) => name)).toEqual(
        expect.arrayContaining([
          "layout.tsx",
          "stock-page-data.ts",
          "opengraph-image.tsx",
          "page.tsx",
          "short-interest/page.tsx",
          "strategy/page.tsx",
          "financials/page.tsx",
          "company/page.tsx",
          "news/page.tsx",
          "community/page.tsx",
          "community/[threadId]/page.tsx",
        ]),
      );
    });

    it.each(files)(
      "%s reads no dynamic API and does not opt out of the cache",
      (_name, file) => {
        expect(dynamicReads(read(file), file)).toEqual([]);
      },
    );

    it("holds a page for every tab in the registry to the ISR trio", () => {
      const tabPages = STOCK_TABS.map((tab) =>
        tab.segment ? `${tab.segment}/page.tsx` : "page.tsx",
      );
      expect(isrPages.map(([name]) => name)).toEqual(expect.arrayContaining(tabPages));
    });

    it("exempts only pages that exist", () => {
      expect(pages.map(([name]) => name)).toEqual(expect.arrayContaining(DYNAMIC_BY_DESIGN));
    });

    it.each(isrPages)(
      "%s exports a literal positive revalidate, dynamicParams = true and generateStaticParams",
      (_name, file) => {
        expect(isrExportProblems(read(file), file)).toEqual([]);
      },
    );
  });

  describe("the scan's own readers", () => {
    describe("withoutComments", () => {
      it("blanks every kind of comment and keeps every offset", () => {
        const source = [
          "// line",
          "const a = 1; /* block */ const b = 2; /** doc */",
          "export const c = 3; // trailing",
        ].join("\n");
        const code = withoutComments(source, "fixture.ts");
        expect(code).toHaveLength(source.length);
        expect(code.split(/\s+/).filter(Boolean)).toEqual(
          "const a = 1; const b = 2; export const c = 3;".split(" "),
        );
      });
    });

    describe("dynamicReads", () => {
      // One line of code per read. Each must be flagged under its own name and
      // under no other, and must not be flagged once it is only a comment.
      const READS: ReadonlyArray<readonly [read: string, code: string]> = [
        ["cookies(", 'import { cookies } from "next/headers"; const jar = cookies();'],
        ["headers(", 'import { headers } from "next/headers"; const list = headers();'],
        ["auth(", 'import { auth } from "@/auth"; const session = await auth();'],
        [
          "searchParams",
          "export default function P({ searchParams }: { searchParams: Promise<object> }) { return null; }",
        ],
        [
          "useSearchParams",
          'import { useSearchParams } from "next/navigation"; const q = useSearchParams();',
        ],
        ["unstable_noStore", 'import { unstable_noStore } from "next/cache"; unstable_noStore();'],
        ["noStore(", "noStore();"],
        ['cache: "no-store"', 'const res = await fetch(url, { cache: "no-store" });'],
        ['dynamic = "force-dynamic"', 'export const dynamic = "force-dynamic";'],
        ["revalidate = 0", "export const revalidate = 0;"],
      ];

      it("has a case for every read it looks for", () => {
        expect(READS.map(([read]) => read)).toEqual(DYNAMIC_READS.map(({ read }) => read));
      });

      it.each(READS)("flags %s, and nothing else", (read, code) => {
        expect(dynamicReads(code)).toEqual([read]);
      });

      it.each(READS)("ignores %s in a line, block, doc or JSX comment", (_read, code) => {
        expect(dynamicReads(`// ${code}`)).toEqual([]);
        expect(dynamicReads(`/* ${code} */`)).toEqual([]);
        expect(dynamicReads(`/** ${code} */\nexport const a = 1;`)).toEqual([]);
        expect(dynamicReads(`export const A = () => <p>{/* ${code} */}</p>;`)).toEqual([]);
      });

      it("spots the other spellings of a read", () => {
        expect(dynamicReads("cookies ()")).toEqual(["cookies("]);
        expect(dynamicReads("cookies\n()")).toEqual(["cookies("]);
        expect(dynamicReads("fetch(u, { cache:'no-store' })")).toEqual(['cache: "no-store"']);
        expect(dynamicReads("fetch(u, { cache : `no-store` })")).toEqual(['cache: "no-store"']);
        expect(dynamicReads("fetch(u, { next: { revalidate: 0 } })")).toEqual(["revalidate = 0"]);
        expect(dynamicReads("export const dynamic='force-dynamic'")).toEqual([
          'dynamic = "force-dynamic"',
        ]);
        expect(
          dynamicReads('import { unstable_noStore as noStore } from "next/cache"; noStore();'),
        ).toEqual(["unstable_noStore", "noStore("]);
      });

      it("still sees a read after a // inside a string, a template, a regex or JSX text", () => {
        for (const code of [
          'const u = "https://x.test"; cookies();',
          "const t = `${a}//${b} it's`; cookies();",
          "const r = /https?:\\/\\/x/; cookies();",
          "export const A = () => <p>see http://x.test {cookies()}</p>;",
        ]) {
          expect(dynamicReads(code)).toEqual(["cookies("]);
        }
      });

      it("does not mistake a longer or differently cased name for a read", () => {
        for (const code of [
          "const q = new URLSearchParams({ a: '1' });",
          "const h = getHeaders(); const o = oauth(); const a = getAuth(); const l = new Headers();",
          "fetch(u, { headers: { accept: 'text/html' } });",
          "export const revalidate = 3600; fetch(u, { next: { revalidate: 600 } });",
          "fetch(u, { cache: 'force-cache' });",
        ]) {
          expect(dynamicReads(code)).toEqual([]);
        }
      });
    });

    describe("isrExportProblems", () => {
      const REVALIDATE = "export const revalidate = 3600;";
      const DYNAMIC_PARAMS = "export const dynamicParams = true;";
      const GENERATE = "export function generateStaticParams() { return []; }";
      const page = (...lines: string[]): string => lines.join("\n");

      it("accepts the trio however a tab page spells it", () => {
        expect(isrExportProblems(page(REVALIDATE, DYNAMIC_PARAMS, GENERATE))).toEqual([]);
        expect(
          isrExportProblems(
            page(
              "export const revalidate = 600;",
              DYNAMIC_PARAMS,
              "export const generateStaticParams = async () => [];",
            ),
          ),
        ).toEqual([]);
        expect(
          isrExportProblems(
            page(
              REVALIDATE,
              DYNAMIC_PARAMS,
              "export async function generateStaticParams(): Promise<never[]> { return []; }",
            ),
          ),
        ).toEqual([]);
      });

      it.each([
        ["revalidate", page(DYNAMIC_PARAMS, GENERATE)],
        ["dynamicParams", page(REVALIDATE, GENERATE)],
        ["generateStaticParams", page(REVALIDATE, DYNAMIC_PARAMS)],
      ])("reports %s when it is missing", (name, source) => {
        expect(isrExportProblems(source)).toEqual([`${name} is not exported`]);
      });

      it("reports everything a page without exports lacks", () => {
        expect(isrExportProblems("export default function Page() { return null; }")).toEqual([
          "revalidate is not exported",
          "dynamicParams is not exported",
          "generateStaticParams is not exported",
        ]);
      });

      it.each([
        ["export const revalidate = 0;", "revalidate must be a literal positive number, found 0"],
        [
          "export const revalidate = false;",
          "revalidate must be a literal positive number, found false",
        ],
        [
          "export const revalidate = 60 * 60;",
          "revalidate must be a literal positive number, found 60 * 60",
        ],
        ["const revalidate = 3600;", "revalidate is not exported"],
      ])("reports `%s`", (line, problem) => {
        expect(isrExportProblems(page(line, DYNAMIC_PARAMS, GENERATE))).toEqual([problem]);
      });

      it.each([
        ["export const dynamicParams = false;", "dynamicParams must be true, found false"],
        ["export const dynamicParams = 1;", "dynamicParams must be true, found 1"],
        ["const dynamicParams = true;", "dynamicParams is not exported"],
      ])("reports `%s`", (line, problem) => {
        expect(isrExportProblems(page(REVALIDATE, line, GENERATE))).toEqual([problem]);
      });

      it.each([
        ["not exported", "function generateStaticParams() { return []; }"],
        ["a default export", "export default function generateStaticParams() { return []; }"],
        ["in a line comment", "// export function generateStaticParams() { return []; }"],
        ["in a block comment", "/* export function generateStaticParams() { return []; } */"],
      ])("reports a generateStaticParams that is %s", (_how, line) => {
        expect(isrExportProblems(page(REVALIDATE, DYNAMIC_PARAMS, line))).toEqual([
          "generateStaticParams is not exported",
        ]);
      });
    });
  });
});
