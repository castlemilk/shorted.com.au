/**
 * ISR source safety for the strategy profile segment (app/strategies/[strategy]/**).
 *
 * The same reasoning as app/shorts/__tests__/isr-source-safety.test.ts: every
 * profile route keeps an empty or static param list, so Next renders nothing
 * at build and never observes a read of cookies(), headers(), searchParams or a
 * no-store fetch. The read would then fail per request. This test reads the
 * segment's own files and holds them to the rule from source.
 *
 * What it checks:
 *  1. No source file in the segment (tests excluded) reads a dynamic API or
 *     opts out of the cache.
 *  2. The layout owns the params: generateStaticParams and dynamicParams = false.
 *  3. Every page in the segment exports a literal positive revalidate.
 *
 * Comments do not count: they are blanked with TypeScript's own scanner before
 * the reads are searched for, so a comment that names cookies() to say it is
 * not used is not a read.
 */

/// <reference types="jest" />
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SEGMENT_DIR = path.resolve(__dirname, "../[strategy]");

/** Everything that makes a page dynamic, or opts it out of the cache. */
const DYNAMIC_READS: ReadonlyArray<{ read: string; pattern: RegExp }> = [
  { read: "cookies(", pattern: /\bcookies\s*\(/ },
  { read: "headers(", pattern: /\bheaders\s*\(/ },
  { read: "auth(", pattern: /\bauth\s*\(/ },
  { read: "searchParams", pattern: /\bsearchParams\b/ },
  { read: "useSearchParams", pattern: /\buseSearchParams\b/ },
  { read: "unstable_noStore", pattern: /\bunstable_noStore\b/ },
  { read: "noStore(", pattern: /\bnoStore\s*\(/ },
  {
    read: 'cache: "no-store"',
    pattern: /\bcache["']?\s*:\s*(["'`])no-store\1/,
  },
  {
    read: 'dynamic = "force-dynamic"',
    pattern: /\bdynamic\s*=\s*(["'`])force-dynamic\1/,
  },
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

/** The source with every comment blanked to spaces, offsets kept. */
function withoutComments(source: string, fileName: string): string {
  const sourceFile = parse(source, fileName);
  const tokens: Array<[start: number, end: number]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0)
      tokens.push([node.getStart(sourceFile), node.end]);
    else children.forEach(visit);
  };
  visit(sourceFile);

  let code = "";
  let from = 0;
  for (const [start, end] of tokens) {
    code +=
      source.slice(from, start).replace(/\S/g, " ") + source.slice(start, end);
    from = end;
  }
  return code + source.slice(from).replace(/\S/g, " ");
}

/**
 * A client module (`"use client"`) may read the query string (useSearchParams,
 * and the local it fills): the filters and the sort are read client-side, under
 * its own <Suspense>, so the static HTML is unaffected. A server module may not.
 */
const CLIENT_MODULE = /^\s*(?:\/\/[^\n]*\n\s*)*(["'])use client\1/;

function dynamicReads(source: string, fileName: string): string[] {
  const code = withoutComments(source, fileName);
  const client = CLIENT_MODULE.test(source);
  return DYNAMIC_READS.filter(({ read, pattern }) => {
    if (client && (read === "useSearchParams" || read === "searchParams"))
      return false;
    return pattern.test(code);
  }).map(({ read }) => read);
}

/** The named exports of a module, with their initializers' text. */
function namedExports(
  source: string,
  fileName: string,
): Map<string, ts.Expression | "function"> {
  const sourceFile = parse(source, fileName);
  const exported = new Map<string, ts.Expression | "function">();
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    const isNamed =
      modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true &&
      !modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (!isNamed) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      exported.set(statement.name.text, "function");
    } else if (ts.isVariableStatement(statement)) {
      for (const { name, initializer } of statement.declarationList
        .declarations) {
        if (ts.isIdentifier(name) && initializer)
          exported.set(name.text, initializer);
      }
    }
  }
  return exported;
}

function segmentSourceFiles(dir: string = SEGMENT_DIR): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") found.push(...segmentSourceFiles(full));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name)
    ) {
      found.push(full);
    }
  }
  return found.sort();
}

const read = (file: string): string => fs.readFileSync(file, "utf-8");
const relative = (file: string): string =>
  path.relative(SEGMENT_DIR, file).split(path.sep).join("/");

const files = segmentSourceFiles();
const pages = files.filter((file) => path.basename(file) === "page.tsx");

describe("strategy profile segment ISR source safety", () => {
  it("finds the layout, the loading boundary and the Overview page", () => {
    expect(files.map(relative)).toEqual(
      expect.arrayContaining([
        "layout.tsx",
        "loading.tsx",
        "page.tsx",
        "opengraph-image.tsx",
      ]),
    );
  });

  it.each(files.map((file) => [relative(file), file] as const))(
    "%s reads no dynamic API and does not opt out of the cache",
    (_name, file) => {
      expect(dynamicReads(read(file), file)).toEqual([]);
    },
  );

  it("owns the params in the layout, not in a page, with dynamicParams off", () => {
    const layout = namedExports(
      read(path.join(SEGMENT_DIR, "layout.tsx")),
      "layout.tsx",
    );
    expect(layout.has("generateStaticParams")).toBe(true);
    const dynamic = layout.get("dynamicParams");
    expect(dynamic && dynamic !== "function" && dynamic.kind).toBe(
      ts.SyntaxKind.FalseKeyword,
    );
    for (const page of pages) {
      expect(namedExports(read(page), page).has("generateStaticParams")).toBe(
        false,
      );
    }
  });

  it.each(pages.map((file) => [relative(file), file] as const))(
    "%s exports a literal positive revalidate",
    (_name, file) => {
      const revalidate = namedExports(read(file), file).get("revalidate");
      expect(
        revalidate &&
          revalidate !== "function" &&
          ts.isNumericLiteral(revalidate),
      ).toBe(true);
      expect(
        revalidate &&
          revalidate !== "function" &&
          Number((revalidate as ts.NumericLiteral).text),
      ).toBeGreaterThan(0);
    },
  );
});

describe("the scan's own reader", () => {
  it("lets a client module read the query string, and no server module", () => {
    expect(
      dynamicReads(
        '"use client";\nconst searchParams = useSearchParams();',
        "a.tsx",
      ),
    ).toEqual([]);
    expect(dynamicReads("const q = useSearchParams();", "a.tsx")).toEqual([
      "useSearchParams",
    ]);
  });

  it.each(DYNAMIC_READS.map(({ read: name }) => name))("flags %s", (name) => {
    const cases: Record<string, string> = {
      "cookies(": "const jar = cookies();",
      "headers(": "const list = headers();",
      "auth(": "const session = await auth();",
      searchParams:
        "export default function P({ searchParams }: X) { return null; }",
      useSearchParams: "const q = useSearchParams();",
      unstable_noStore: "unstable_noStore();",
      "noStore(": "noStore();",
      'cache: "no-store"': 'fetch(u, { cache: "no-store" });',
      'dynamic = "force-dynamic"': 'export const dynamic = "force-dynamic";',
      "revalidate = 0": "export const revalidate = 0;",
    };
    expect(dynamicReads(cases[name]!, "fixture.tsx")).toEqual([name]);
    expect(dynamicReads(`// ${cases[name]!}`, "fixture.tsx")).toEqual([]);
  });
});
