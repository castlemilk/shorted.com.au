/**
 * SSR Import Safety Tests for /shorts pages
 *
 * These tests verify that import chains don't pull in modules that break
 * during server-side rendering. Specifically:
 * - Client components must not import server-only modules (cache(), Redis, etc.)
 * - Server actions must use SHORTS_API_URL from config.ts, not direct env vars
 * - calculateMovers output must be JSON-serializable (no BigInt)
 *
 * Background: In March 2026, /shorts returned 500 for 1+ day because:
 * 1. top-shorts-client.tsx ("use client") imported server-only getTopShortsData
 * 2. getTopShortsData used stale env var instead of SHORTS_API_URL
 * 3. Protobuf BigInt fields couldn't be JSON.stringify'd for cache
 * See: memory/ssr-url-regression.md
 *
 * The last block guards the stock page's own boundary (spec section 5): its
 * layout, data loader and every tab page are server files, and Connect-RPC
 * must never be evaluated while one of them renders.
 */

import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const WEB_SRC = path.resolve(__dirname, "../../../..");

// ---------------------------------------------------------------------------
// Helpers for the stock page's import boundary. They read IMPORT STATEMENTS
// (`from "…"`, `import("…")`), never the bare substring: three tab pages name
// @connectrpc/connect in a comment, and a comment must neither pass nor fail.
// ---------------------------------------------------------------------------

const SRC_DIR = path.join(WEB_SRC, "src");
const STOCK_DIR = path.join(SRC_DIR, "app/shorts/[stockCode]");

function readSource(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

/** The source without comments, so prose that names a module is not an import of it. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

interface ImportRef {
  specifier: string;
  /** `import("…")`, as opposed to `from "…"` or a bare `import "…"`. */
  dynamic: boolean;
}

const IMPORT_STATEMENT =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;

/** Every module a file names in an import statement, static or dynamic. */
function importRefs(source: string): ImportRef[] {
  return Array.from(withoutComments(source).matchAll(IMPORT_STATEMENT)).map(
    (m) =>
      m[2] !== undefined
        ? { specifier: m[2], dynamic: true }
        : { specifier: (m[1] ?? m[3])!, dynamic: false },
  );
}

function importsConnect(source: string): boolean {
  return importRefs(source).some((ref) =>
    ref.specifier.startsWith("@connectrpc/"),
  );
}

/** Every layout and page beneath [stockCode], and the data loader they share. */
function stockServerFiles(dir: string = STOCK_DIR): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") found.push(...stockServerFiles(full));
    } else if (
      entry.name === "page.tsx" ||
      entry.name === "layout.tsx" ||
      (dir === STOCK_DIR && entry.name === "stock-page-data.ts")
    ) {
      found.push(full);
    }
  }
  return found.sort();
}

/** A repo module's file (the tsconfig aliases `~/` and `@/` included), or null. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("~/")) base = path.join(SRC_DIR, specifier.slice(2));
  else if (specifier.startsWith("@/"))
    base = path.join(SRC_DIR, "@", specifier.slice(2));
  else if (specifier.startsWith("."))
    base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function isClientModule(file: string): boolean {
  return /^["']use client["']/.test(
    withoutComments(readSource(file)).trimStart(),
  );
}

/** The argument text of every call to `name(`: parentheses balanced, strings skipped. */
function callArguments(code: string, name: string): string[] {
  const calls: string[] = [];
  const opener = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (let m = opener.exec(code); m; m = opener.exec(code)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      const ch = code[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        // A parenthesis inside a string is not code: skip the string whole.
        for (i++; i < code.length && code[i] !== ch; i++) {
          if (code[i] === "\\") i++;
        }
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    calls.push(code.slice(start, i - 1));
  }
  return calls;
}

interface DynamicLoad {
  specifier: string;
  /** The options carry `ssr: false`: the module is never evaluated during SSR. */
  ssrFalse: boolean;
}

/** What a file loads through next/dynamic, under whatever name it imported it as. */
function nextDynamicLoads(source: string): DynamicLoad[] {
  const code = withoutComments(source);
  const local = /\bimport\s+(\w+)\s+from\s*["']next\/dynamic["']/.exec(
    code,
  )?.[1];
  if (!local) return [];
  return callArguments(code, local).flatMap((args) => {
    const specifier = /\bimport\s*\(\s*["']([^"']+)["']/.exec(args)?.[1];
    return specifier
      ? [{ specifier, ssrFalse: /\bssr\s*:\s*false\b/.test(args) }]
      : [];
  });
}

/**
 * The client widgets that reach Connect-RPC, by the server file that owns each.
 * A server file loads one with nextDynamic(() => import(…), { ssr: false }),
 * never with a static import. A page that gains an island lists it here, and
 * the test below fails until it does.
 */
const CONNECT_ISLANDS: Record<string, string[]> = {
  "layout.tsx": ["~/@/components/charts/StockChartPanel"],
  "short-interest/page.tsx": [
    "~/@/components/company/peer-comparison-table",
    "~/@/components/company/stock-signals",
    "~/@/components/company/stock-verdict",
  ],
  "strategy/page.tsx": ["~/@/components/strategy/strategy-levels-chart"],
  "financials/page.tsx": ["~/@/components/company/dividend-history"],
  "company/page.tsx": [
    "~/@/components/company/director-trades-table",
    "~/@/components/company/stock-connections",
  ],
  "news/page.tsx": ["~/@/components/company/event-timeline"],
};

describe("/shorts SSR Import Safety", () => {
  describe("Client component import validation", () => {
    it("top-shorts-client.tsx must NOT import server-side getTopShorts action", () => {
      const filePath = path.join(
        WEB_SRC,
        "src/app/shorts/components/top-shorts-client.tsx",
      );
      const content = fs.readFileSync(filePath, "utf-8");

      // Must NOT import from the server-side action (has cache(), Redis, @connectrpc)
      expect(content).not.toMatch(
        /from\s+["']~\/app\/actions\/getTopShorts["']/,
      );
      expect(content).not.toMatch(
        /from\s+["']\.\.\/\.\.\/actions\/getTopShorts["']/,
      );

      // MUST import from the client-side action
      expect(content).toMatch(
        /from\s+["']~\/app\/actions\/client\/getTopShorts["']/,
      );
    });

    it("top-shorts-client.tsx must have 'use client' directive", () => {
      const filePath = path.join(
        WEB_SRC,
        "src/app/shorts/components/top-shorts-client.tsx",
      );
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content.trimStart()).toMatch(/^["']use client["']/);
    });

    it("/shorts/page.tsx must use dynamic import for TopShortsClient (ssr: false)", () => {
      const filePath = path.join(WEB_SRC, "src/app/shorts/page.tsx");
      const content = fs.readFileSync(filePath, "utf-8");

      // Must NOT have a static import of TopShortsClient
      expect(content).not.toMatch(
        /^import\s+\{?\s*TopShortsClient\s*\}?\s+from/m,
      );

      // Must have a dynamic import with ssr: false
      expect(content).toMatch(/ssr:\s*false/);
      expect(content).toMatch(/top-shorts-client/);
    });
  });

  describe("Server action URL consistency", () => {
    it("server actions must use SHORTS_API_URL, not process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT directly", () => {
      const actionsDir = path.join(WEB_SRC, "src/app/actions");
      const actionFiles = fs
        .readdirSync(actionsDir)
        .filter((f) => f.endsWith(".ts") && f !== "config.ts");

      const violations: string[] = [];
      for (const file of actionFiles) {
        const filePath = path.join(actionsDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) continue;

        const content = fs.readFileSync(filePath, "utf-8");
        // Check for direct env var usage in transport baseUrl
        // Allow the import of SHORTS_API_URL (that's correct)
        // Disallow: process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT in baseUrl
        if (
          content.includes("process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT") &&
          content.includes("baseUrl")
        ) {
          violations.push(file);
        }
      }

      expect(violations).toEqual([]);
    });
  });

  describe("[stockCode] import boundary: the layout, the data loader and every tab page", () => {
    const files = stockServerFiles().map(
      (file) => [path.relative(STOCK_DIR, file), file] as const,
    );

    it("covers the layout, the data loader and all seven tab pages", () => {
      expect(files.map(([name]) => name)).toEqual(
        expect.arrayContaining([
          "layout.tsx",
          "stock-page-data.ts",
          "page.tsx",
          "short-interest/page.tsx",
          "strategy/page.tsx",
          "financials/page.tsx",
          "company/page.tsx",
          "news/page.tsx",
          "community/page.tsx",
        ]),
      );
    });

    it.each(files)(
      "%s must NOT directly import any @connectrpc package",
      (_name, file) => {
        expect(
          importRefs(readSource(file))
            .map((ref) => ref.specifier)
            .filter((specifier) => specifier.startsWith("@connectrpc/")),
        ).toEqual([]);
      },
    );

    it.each(files)(
      "%s loads everything it hands to next/dynamic with ssr: false",
      (_name, file) => {
        expect(
          nextDynamicLoads(readSource(file))
            .filter((load) => !load.ssrFalse)
            .map((load) => load.specifier),
        ).toEqual([]);
      },
    );

    it.each(files)(
      "%s loads exactly its Connect-RPC islands through next/dynamic, and imports none statically",
      (name, file) => {
        const expected = CONNECT_ISLANDS[name] ?? [];
        const source = readSource(file);
        expect(
          nextDynamicLoads(source)
            .map((load) => load.specifier)
            .sort(),
        ).toEqual([...expected].sort());
        const staticImports = importRefs(source)
          .filter((ref) => !ref.dynamic)
          .map((ref) => ref.specifier);
        for (const island of expected) {
          expect(staticImports).not.toContain(island);
        }
      },
    );

    it.each(files)(
      "%s statically imports no client module that imports @connectrpc itself",
      (_name, file) => {
        const offenders = importRefs(readSource(file))
          .filter((ref) => !ref.dynamic)
          .map((ref) => resolveLocal(ref.specifier, file))
          .filter(
            (target): target is string =>
              target !== null &&
              isClientModule(target) &&
              importsConnect(readSource(target)),
          )
          .map((target) => path.relative(SRC_DIR, target));
        expect(offenders).toEqual([]);
      },
    );
  });
});
