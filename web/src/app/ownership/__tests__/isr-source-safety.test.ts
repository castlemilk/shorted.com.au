/**
 * ISR source safety for the ownership section (app/ownership/**).
 *
 * The stock segment's rule (app/shorts/__tests__/isr-source-safety.test.ts),
 * held for the ownership pages. scripts/route-kinds.mjs gates the two dynamic
 * routes and the three static ones on Next's prerender manifest. For the two
 * dynamic routes it cannot see a read of searchParams, cookies(), headers(),
 * auth() or a no-store fetch: their generateStaticParams lists are empty, so
 * Next renders nothing at build time, the route stays listed as ISR, and the
 * read fails at request time instead. For the static pages (the hub, the notice
 * feed and the register list) it does see a read that runs during the build
 * render, since Next then renders the page per request and drops it from
 * `routes`. This file is the source half of the check. It also catches a read on
 * a code path the build render does not take, and one in a module that a page
 * imports from this folder.
 *
 * What it checks:
 *  1. No non-test file under app/ownership reads a request-time API or opts out
 *     of the cache. DYNAMIC_READS below is the list.
 *  2. Every page.tsx exports a literal positive `revalidate`. A page under a
 *     dynamic segment also exports `dynamicParams = true` and
 *     `generateStaticParams`, so it is on-demand ISR and not per request. A
 *     static page (the hub, the notice feed, the register list) exports no
 *     `dynamic` segment config: its revalidate alone keeps it ISR.
 *
 * Comments do not count: several files name these APIs to say they are not
 * used. Comments are removed with TypeScript's own parser (withoutComments), as
 * the stock scan does.
 *
 * What it cannot see: a read in a module that a page imports from outside this
 * folder. For the transports that is app/actions/__tests__/serverApiSurface.test.ts,
 * and a second request for each page answering x-nextjs-cache HIT is the rollout
 * check.
 */

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const OWNERSHIP_DIR = path.resolve(__dirname, "..");

/**
 * Everything that makes a page dynamic, or opts it out of the cache, as it is
 * spelled in code. Whitespace and quote style do not matter; a longer or
 * differently cased name is not a match (`URLSearchParams`, `oauth(`).
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
  { read: 'dynamic = "force-dynamic"', pattern: /\bdynamic\s*=\s*(["'`])force-dynamic\1/ },
  // `revalidate = 0` in a segment config, and `{ next: { revalidate: 0 } }` on a fetch.
  { read: "revalidate = 0", pattern: /\brevalidate\s*[:=]\s*0(?![\d.])/ },
];

/** One line of code per read, each reading that one and nothing else. */
const READS: ReadonlyArray<readonly [name: string, code: string]> = [
  ["cookies(", 'import { cookies } from "next/headers"; const jar = cookies();'],
  ["headers(", "const list = headers();"],
  ["auth(", "const session = await auth();"],
  ["searchParams", "export default function P({ searchParams }: Props) { return null; }"],
  ["useSearchParams", "const q = useSearchParams();"],
  ["unstable_noStore", "unstable_noStore();"],
  ["noStore(", "noStore();"],
  ['cache: "no-store"', 'const res = await fetch(url, { cache: "no-store" });'],
  ['dynamic = "force-dynamic"', 'export const dynamic = "force-dynamic";'],
  ["revalidate = 0", "export const revalidate = 0;"],
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
 * survive. The parser finds the tokens; whatever sits between two of them is
 * trivia, so what is not whitespace there is a comment. JSDoc is skipped for
 * the same reason: it is a comment the parser happens to understand.
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
 * The named exports of a module, read off the syntax tree so a commented-out
 * export does not count. A default export is not a named one.
 */
function namedExports(sourceFile: ts.SourceFile): Map<string, ExportedValue> {
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
  return exported;
}

/**
 * What is wrong with a page's ISR exports, one message per problem. A static
 * page has no params to generate, so only a dynamic page is held to
 * dynamicParams and generateStaticParams. A static page exports no `dynamic`
 * segment config either: force-dynamic turned the revalidate off on /shorts
 * (2026-10-21, app/__tests__/isr-hubs.test.ts), so the revalidate must be the
 * only thing that keeps it ISR. `dynamic` here is whether the page has a
 * dynamic segment; the export is read separately.
 */
function isrExportProblems(source: string, dynamic: boolean, fileName = "page.tsx"): string[] {
  const exported = namedExports(parse(source, fileName));
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
  if (dynamic) {
    const dynamicParams = exported.get("dynamicParams");
    if (!dynamicParams) {
      problems.push("dynamicParams is not exported");
    } else if (dynamicParams.initializer?.kind !== ts.SyntaxKind.TrueKeyword) {
      problems.push(`dynamicParams must be true, found ${dynamicParams.text}`);
    }
    if (!exported.has("generateStaticParams")) {
      problems.push("generateStaticParams is not exported");
    }
  }
  const dynamicConfig = exported.get("dynamic");
  if (!dynamic && dynamicConfig) {
    problems.push(`dynamic must not be exported on a static page, found ${dynamicConfig.text}`);
  }
  return problems;
}

/** Every .ts and .tsx file beneath a folder except tests and their folders, sorted. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") found.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}

const read = (file: string): string => fs.readFileSync(file, "utf-8");

/** [path under app/ownership, absolute path], with "/" separators. */
const files = sourceFiles(OWNERSHIP_DIR).map(
  (file) => [path.relative(OWNERSHIP_DIR, file).split(path.sep).join("/"), file] as const,
);
const pages = files.filter(([name]) => path.posix.basename(name) === "page.tsx");

/** Whether a route has a dynamic segment, such as [slug] or stocks/[code]. */
const isDynamicPage = (name: string): boolean =>
  name
    .split("/")
    .slice(0, -1)
    .some((segment) => /^\[.+\]$/.test(segment));

describe("ownership ISR source safety", () => {
  describe("the ownership files", () => {
    it("finds the hub, the institution page and the register with its data module", () => {
      expect(files.map(([name]) => name)).toEqual(
        expect.arrayContaining([
          "page.tsx",
          "opengraph-image.tsx",
          "[slug]/page.tsx",
          "[slug]/opengraph-image.tsx",
          "stocks/[code]/page.tsx",
          "stocks/[code]/register-data.ts",
          "stocks/[code]/loading.tsx",
          "stocks/[code]/opengraph-image.tsx",
          "funds/[fund]/page.tsx",
          "funds/[fund]/loading.tsx",
        ]),
      );
    });

    it("leaves out the tests and their folders", () => {
      expect(files.filter(([name]) => /__tests__|\.(test|spec)\./.test(name))).toEqual([]);
    });

    it("holds the hub and the dynamic pages, the fund page included, to the rule", () => {
      expect(pages.map(([name]) => name)).toEqual(
        expect.arrayContaining(["page.tsx", "[slug]/page.tsx", "stocks/[code]/page.tsx", "funds/[fund]/page.tsx"]),
      );
    });

    // The notice feed and the register list have no dynamic segment, so the source scan holds them
    // to the static half of the rule: a revalidate, and no `dynamic` export (checked per page below).
    it("finds the two static pages the explorer adds, and classes them as static", () => {
      expect(files.map(([name]) => name)).toEqual(
        expect.arrayContaining([
          "notices/page.tsx",
          "notices/loading.tsx",
          "notices/opengraph-image.tsx",
          "stocks/page.tsx",
          "stocks/loading.tsx",
        ]),
      );
      const staticPages = pages.map(([name]) => name).filter((name) => !isDynamicPage(name));
      expect(staticPages).toEqual(expect.arrayContaining(["page.tsx", "notices/page.tsx", "stocks/page.tsx"]));
    });

    it.each(files)("%s reads no dynamic API and does not opt out of the cache", (_name, file) => {
      expect(dynamicReads(read(file), file)).toEqual([]);
    });

    it.each(pages)(
      "%s exports a literal positive revalidate, and the rule for its kind (ISR trio or no dynamic export)",
      (name, file) => {
        expect(isrExportProblems(read(file), isDynamicPage(name), file)).toEqual([]);
      },
    );
  });

  // The hub's desk (spec 13.7) is drawn by islands and loaders outside app/ownership, so the
  // page-level scan above does not reach them. A read of searchParams, cookies() or headers() in
  // any of them would turn the hub dynamic for every visitor, so they are held to the same list.
  describe("the desk the hub draws", () => {
    const APP_DIR = path.resolve(OWNERSHIP_DIR, "..");
    const DESK_DIR = path.resolve(APP_DIR, "..", "@", "components", "ownership", "desk");
    const DESK_LOADER = path.join(APP_DIR, "actions", "ownershipDesk.ts");
    const desk = [...sourceFiles(DESK_DIR), DESK_LOADER].map(
      (file) => [path.relative(APP_DIR, file).split(path.sep).join("/"), file] as const,
    );

    it("finds the desk's islands, its static drawings, the stock panel and the loaders", () => {
      expect(desk.map(([name]) => name)).toEqual(
        expect.arrayContaining([
          "../@/components/ownership/desk/ownership-map.tsx",
          "../@/components/ownership/desk/ownership-flows.tsx",
          "../@/components/ownership/desk/movement-heatmap.tsx",
          "../@/components/ownership/desk/fund-positions.tsx",
          "../@/components/ownership/desk/stock-panel.tsx",
          "actions/ownershipDesk.ts",
        ]),
      );
    });

    // Every island reads the URL itself (spec 13.1): useSearchParams under its own Suspense, with
    // the server's default view as the fallback, so the static prerender takes the fallback and
    // the URL read never reaches the page. Those two reads are the only ones the desk may make.
    const URL_READS = ["searchParams", "useSearchParams"];
    const requestTimeReads = (file: string) =>
      dynamicReads(read(file), file).filter((name) => !URL_READS.includes(name));

    it.each(desk)("%s reads no dynamic API and does not opt out of the cache", (_name, file) => {
      expect(requestTimeReads(file)).toEqual([]);
    });

    // Each island wraps its live part in a Suspense whose fallback is the default view, so the
    // static prerender draws the view and the URL read sits under that boundary (spec 13.1).
    it("wraps each island's live part in a Suspense with the default view as its fallback", () => {
      const islands = ["ownership-map.tsx", "ownership-flows.tsx", "movement-heatmap.tsx", "fund-positions.tsx"];
      for (const island of islands) {
        const code = withoutComments(read(path.join(DESK_DIR, island)), island);
        expect({ island, boundary: /<Suspense\s+fallback=\{/.test(code) }).toEqual({ island, boundary: true });
      }
    });

    it("reads the URL only from client islands", () => {
      const urlReaders = desk.filter(([, file]) => dynamicReads(read(file), file).some((name) => URL_READS.includes(name)));
      expect(urlReaders.length).toBeGreaterThan(0);
      const notIslands = urlReaders
        .filter(([, file]) => !/^["']use client["']/.test(withoutComments(read(file), file).trimStart()))
        .map(([name]) => name);
      expect(notIslands).toEqual([]);
    });
  });

  // The workspace (spec 14.3) draws its pages from its inspectors, its islands, the vendored Gamma
  // components and the funds' loaders, none of them under app/ownership. They are held to the desk's
  // rule: no request-time read, and the URL is read only from a client module.
  describe("the workspace the pages draw", () => {
    const APP_DIR = path.resolve(OWNERSHIP_DIR, "..");
    const COMPONENTS_DIR = path.resolve(APP_DIR, "..", "@", "components");
    const WORKSPACE_FILES = [
      ...sourceFiles(path.join(COMPONENTS_DIR, "ownership", "workspace")),
      ...sourceFiles(path.join(COMPONENTS_DIR, "workspace")),
      ...sourceFiles(path.join(COMPONENTS_DIR, "ownership", "funds")),
      ...sourceFiles(path.join(COMPONENTS_DIR, "ownership", "holders")),
      ...sourceFiles(path.join(COMPONENTS_DIR, "gamma")),
      path.join(APP_DIR, "actions", "ownershipFunds.ts"),
      path.join(APP_DIR, "actions", "ownershipHolders.ts"),
    ].map((file) => [path.relative(APP_DIR, file).split(path.sep).join("/"), file] as const);

    const URL_READS = ["searchParams", "useSearchParams"];
    const requestTimeReads = (file: string) =>
      dynamicReads(read(file), file).filter((name) => !URL_READS.includes(name));

    it("finds the inspectors, the funds, the holders, the Gamma components and the funds loader", () => {
      expect(WORKSPACE_FILES.map(([name]) => name)).toEqual(
        expect.arrayContaining([
          "../@/components/ownership/workspace/inspector.tsx",
          "../@/components/ownership/workspace/ownership-nav.tsx",
          "../@/components/ownership/funds/fund-model.ts",
          "../@/components/ownership/holders/holder-browser.tsx",
          "../@/components/gamma/DisclosureStack.tsx",
          "actions/ownershipFunds.ts",
          "actions/ownershipHolders.ts",
        ]),
      );
    });

    it.each(WORKSPACE_FILES)("%s reads no dynamic API and does not opt out of the cache", (_name, file) => {
      expect(requestTimeReads(file)).toEqual([]);
    });

    it("reads the URL only from client modules", () => {
      const urlReaders = WORKSPACE_FILES.filter(([, file]) =>
        dynamicReads(read(file), file).some((name) => URL_READS.includes(name)),
      );
      const notClient = urlReaders
        .filter(([, file]) => !/^["']use client["']/.test(withoutComments(read(file), file).trimStart()))
        .map(([name]) => name);
      expect(notClient).toEqual([]);
    });
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
      it("has a case for every read it looks for", () => {
        expect(READS.map(([name]) => name)).toEqual(DYNAMIC_READS.map(({ read }) => read));
      });

      it.each(READS)("flags %s, and nothing else", (name, code) => {
        expect(dynamicReads(code)).toEqual([name]);
      });

      it.each(READS)("ignores %s in a line, block, doc or JSX comment", (_name, code) => {
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

      it("accepts a static page with a literal positive revalidate", () => {
        expect(isrExportProblems(REVALIDATE, false)).toEqual([]);
      });

      it("accepts a dynamic page with the trio, however it spells generateStaticParams", () => {
        expect(isrExportProblems(page(REVALIDATE, DYNAMIC_PARAMS, GENERATE), true)).toEqual([]);
        expect(
          isrExportProblems(
            page(
              "export const revalidate = 600;",
              DYNAMIC_PARAMS,
              "export const generateStaticParams = async () => [];",
            ),
            true,
          ),
        ).toEqual([]);
        expect(
          isrExportProblems(
            page(
              REVALIDATE,
              DYNAMIC_PARAMS,
              "export async function generateStaticParams(): Promise<never[]> { return []; }",
            ),
            true,
          ),
        ).toEqual([]);
      });

      it("does not hold a static page to dynamicParams or generateStaticParams", () => {
        expect(isrExportProblems(page(REVALIDATE, "export const dynamicParams = false;"), false)).toEqual(
          [],
        );
      });

      it("holds a static page to no dynamic export, whatever its revalidate", () => {
        expect(isrExportProblems(page(REVALIDATE, 'export const dynamic = "auto";'), false)).toEqual([
          'dynamic must not be exported on a static page, found "auto"',
        ]);
        expect(
          isrExportProblems(page("export const revalidate = 600;", "export const dynamic = 'force-dynamic';"), false),
        ).toEqual(["dynamic must not be exported on a static page, found 'force-dynamic'"]);
      });

      it("reports a revalidate that is missing or not a literal positive number", () => {
        expect(isrExportProblems("export default function Page() { return null; }", false)).toEqual([
          "revalidate is not exported",
        ]);
        expect(isrExportProblems("const revalidate = 3600;", false)).toEqual([
          "revalidate is not exported",
        ]);
        expect(isrExportProblems("export const revalidate = 0;", false)).toEqual([
          "revalidate must be a literal positive number, found 0",
        ]);
        expect(isrExportProblems("export const revalidate = 60 * 60;", false)).toEqual([
          "revalidate must be a literal positive number, found 60 * 60",
        ]);
        expect(isrExportProblems("export const revalidate = false;", false)).toEqual([
          "revalidate must be a literal positive number, found false",
        ]);
      });

      it("reports everything a dynamic page without exports lacks", () => {
        expect(isrExportProblems("export default function Page() { return null; }", true)).toEqual([
          "revalidate is not exported",
          "dynamicParams is not exported",
          "generateStaticParams is not exported",
        ]);
      });

      it.each([
        ["dynamicParams", page(REVALIDATE, GENERATE), "dynamicParams is not exported"],
        [
          "generateStaticParams",
          page(REVALIDATE, DYNAMIC_PARAMS),
          "generateStaticParams is not exported",
        ],
      ])("reports %s missing from a dynamic page", (_name, source, problem) => {
        expect(isrExportProblems(source, true)).toEqual([problem]);
      });

      it.each([
        ["export const dynamicParams = false;", "dynamicParams must be true, found false"],
        ["export const dynamicParams = 1;", "dynamicParams must be true, found 1"],
      ])("reports `%s` on a dynamic page", (line, problem) => {
        expect(isrExportProblems(page(REVALIDATE, line, GENERATE), true)).toEqual([problem]);
      });

      it.each([
        ["not exported", "function generateStaticParams() { return []; }"],
        ["a default export", "export default function generateStaticParams() { return []; }"],
        ["in a line comment", "// export function generateStaticParams() { return []; }"],
        ["in a block comment", "/* export function generateStaticParams() { return []; } */"],
      ])("reports a generateStaticParams that is %s", (_how, line) => {
        expect(isrExportProblems(page(REVALIDATE, DYNAMIC_PARAMS, line), true)).toEqual([
          "generateStaticParams is not exported",
        ]);
      });
    });
  });
});

// A page in the shell re-prime (config/isr-shell-pages.json) is re-primed only when its HTML
// carries data-isr-shell="empty" (warm-cache/route.ts readPage). A page without the marker
// reports success while it serves the empty build render, so every /ownership page in the
// list must draw the marker on its failed read path.
describe("ownership shell pages draw the empty marker", () => {
  const SHELL_LIST = path.resolve(OWNERSHIP_DIR, "..", "..", "config", "isr-shell-pages.json");
  const shellPages = (JSON.parse(read(SHELL_LIST)) as string[]).filter((entry) =>
    entry.startsWith("/ownership/"),
  );

  it("lists the ownership shell pages", () => {
    expect(shellPages.length).toBeGreaterThan(0);
  });

  it.each(shellPages)("%s has a page.tsx that draws data-isr-shell=\"empty\"", (entry) => {
    const file = path.join(OWNERSHIP_DIR, ...entry.replace(/^\/ownership\/?/, "").split("/"), "page.tsx");
    expect(fs.existsSync(file)).toBe(true);
    // Matched in the code, not a comment, and as a rendered element: a marker only mentioned in a
    // comment or in a string would pass a plain substring check.
    expect(withoutComments(read(file), file)).toMatch(/<span[^>]*data-isr-shell="empty"/);
  });
});
