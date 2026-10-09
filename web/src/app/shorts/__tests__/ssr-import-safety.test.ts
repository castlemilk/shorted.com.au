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
 * should not be evaluated while one of them renders. It follows static imports
 * from each of those files through every module they reach, and fails when a
 * client module on the way reaches @connectrpc. Imports are read with
 * TypeScript's own scanner and resolved with the project's tsconfig paths, so a
 * comment, a string, or the `~/`, `@/` or relative spelling of a path cannot
 * hide one.
 *
 * It does not hold for three pre-existing "use client" modules, which still
 * reach @connectrpc by static imports and are allowlisted in
 * KNOWN_CLIENT_CONNECT below: company-profile-with-retry and
 * company-stats-with-retry (under the layout) and company-info-with-retry (on
 * the Overview). The server components companyProfile, companyStats and
 * companyInfo render them when their own getStockDetails read resolves
 * undefined, so Connect-RPC IS evaluated during server rendering in exactly
 * that case, which is the failure that answered 500 on the Financials route
 * when the tax card was rendered inline. The old page header had the same
 * exposure. The allowlist is pinned, so it can only shrink; each entry is a
 * risk, not a fix. Loading the three through nextDynamic(..., { ssr: false })
 * is a separate change to shared UI, to be reproduced under `next start`
 * first.
 */

import { describe, it, expect, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";

const WEB_SRC = path.resolve(__dirname, "../../../..");

// ---------------------------------------------------------------------------
// Helpers for the stock page's import boundary. Imports are read with
// TypeScript's own import scanner, never with a regex over the text: three tab
// pages name @connectrpc/connect in a comment, and a comment, a string or a
// template must neither pass nor fail a check.
// ---------------------------------------------------------------------------

const SRC_DIR = path.join(WEB_SRC, "src");
const STOCK_DIR = path.join(SRC_DIR, "app/shorts/[stockCode]");

function readSource(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

/**
 * The source without comments. ONLY for finding what a next/dynamic call is
 * handed (nextDynamicLoads): a `//` inside a string or JSX text makes it drop
 * the rest of that line, so it must never be used to look for an import.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

interface ImportRef {
  specifier: string;
  /** `import("…")`, as opposed to `from "…"`, a bare `import "…"` or `require("…")`. */
  dynamic: boolean;
}

/** `import(` and any block comments, just before a specifier: a dynamic import. */
const DYNAMIC_IMPORT_LEAD = /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*$/;

/**
 * Every module a file names in an import, an export-from, an import() or a
 * require(). TypeScript's scanner finds them, so one named in a comment, a
 * string or a template is not an import, and a `//` inside a string cannot
 * swallow the code after it. Type-only imports count too (conservative: none of
 * the chains found today is one). The scanner does not say which are dynamic;
 * the text just before the specifier does.
 */
function importRefs(source: string): ImportRef[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map(({ fileName, pos }) => ({
      specifier: fileName,
      dynamic: DYNAMIC_IMPORT_LEAD.test(
        source.slice(Math.max(0, pos - 400), pos),
      ),
    }));
}

// Resolved the way the build resolves them, from tsconfig's own `paths`. `~/*`
// is src/*, but `@/` is not one alias for src/@/: `@/auth` is src/server/auth.ts
// and `@/app/*` is src/app/*, so a guess at `@/` would lose those edges.
const COMPILER_OPTIONS = ts.convertCompilerOptionsFromJson(
  ts.readConfigFile(path.join(WEB_SRC, "tsconfig.json"), readSource).config
    .compilerOptions,
  WEB_SRC,
).options;
const RESOLUTION_HOST: ts.ModuleResolutionHost = {
  fileExists: (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
  readFile: (file) => (fs.existsSync(file) ? readSource(file) : undefined),
  directoryExists: (dir) =>
    fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
};
const RESOLUTION_CACHE = ts.createModuleResolutionCache(
  WEB_SRC,
  (name) => name,
  COMPILER_OPTIONS,
);

/** A repo module's file (aliases and relative paths included), or null for a package or a file that is not there. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    fromFile,
    COMPILER_OPTIONS,
    RESOLUTION_HOST,
    RESOLUTION_CACHE,
  );
  return resolvedModule && !resolvedModule.isExternalLibraryImport
    ? resolvedModule.resolvedFileName
    : null;
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

/** The file's directive prologue: the string statements before any code ("use client", "use server"). */
function directivesOf(source: string): string[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const found: string[] = [];
  let token = scanner.scan();
  while (token === ts.SyntaxKind.StringLiteral) {
    found.push(scanner.getTokenValue());
    token = scanner.scan();
    if (token === ts.SyntaxKind.SemicolonToken) token = scanner.scan();
  }
  return found;
}

interface ModuleInfo {
  /** "use client": evaluated in the browser AND during SSR. */
  client: boolean;
  /** "use server": a client module that imports it gets a reference, and none of its code. */
  serverActions: boolean;
  /** The @connectrpc/* packages it imports statically. */
  connect: string[];
  /** The repo files it imports statically; packages and files that are not there are left out. */
  local: string[];
}

const moduleInfos = new Map<string, ModuleInfo>();

function moduleInfo(file: string): ModuleInfo {
  let info = moduleInfos.get(file);
  if (!info) {
    const source = readSource(file);
    const directives = directivesOf(source);
    const statics = importRefs(source).filter((ref) => !ref.dynamic);
    info = {
      client: directives.includes("use client"),
      serverActions: directives.includes("use server"),
      connect: statics
        .map((ref) => ref.specifier)
        .filter((specifier) => specifier.startsWith("@connectrpc/")),
      local: statics.flatMap((ref) => resolveLocal(ref.specifier, file) ?? []),
    };
    moduleInfos.set(file, info);
  }
  return info;
}

/** The first chain of static imports from `start` to an @connectrpc package: the files, then the package. */
function connectChain(start: string): string[] | null {
  const seen = new Set<string>();
  const walk = (file: string): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    const info = moduleInfo(file);
    const [pkg] = info.connect;
    if (pkg) return [file, pkg];
    for (const dep of info.local) {
      if (moduleInfo(dep).serverActions) continue;
      const rest = walk(dep);
      if (rest) return [file, ...rest];
    }
    return null;
  };
  return walk(start);
}

interface ClientConnect {
  /** A "use client" module the server file reaches by static imports. */
  client: string;
  /** Its chain of static imports to @connectrpc: the files, then the package. */
  chain: string[];
}

/**
 * Every "use client" module a server file reaches by static imports, through
 * any server modules in between, that itself reaches @connectrpc at any depth.
 * A client module ends the search on its branch: what it imports is in its own
 * bundle, which connectChain has already walked. A dynamic import is a lazy
 * boundary and is not followed (the ssr: false rule and the island registry
 * cover those), and neither is a "use server" module, which a client module
 * receives as a reference. A server module that imports Connect on the server
 * is not blamed: only a client module evaluates it during SSR.
 */
function clientModulesReachingConnect(entry: string): ClientConnect[] {
  const found: ClientConnect[] = [];
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const info = moduleInfo(file);
    if (info.serverActions) return;
    if (info.client) {
      const chain = connectChain(file);
      if (chain) found.push({ client: file, chain });
      return;
    }
    info.local.forEach(visit);
  };
  visit(entry);
  return found;
}

const fromSrc = (file: string): string => path.relative(SRC_DIR, file);

/** What a specifier names, as a path from src/, so `~/@/x`, `@/x` and a relative spelling compare equal. One that names no repo file stays as written and marked, so a typo shows in a diff. */
function targetOf(specifier: string, fromFile: string): string {
  const file = resolveLocal(specifier, fromFile);
  return file ? fromSrc(file) : `unresolved: ${specifier}`;
}

const describeChain = ({ chain }: ClientConnect): string =>
  chain
    .map((step, i) => (i < chain.length - 1 ? fromSrc(step) : step))
    .join(" -> ");

/**
 * What the walk found against the client modules known to reach Connect (as
 * paths from src/): the chains of any that are new, and the known ones that no
 * longer apply, which are taken off the list so that it can only shrink.
 */
function diffKnownClients(found: ClientConnect[], known: string[]) {
  return {
    unexpected: found
      .filter((f) => !known.includes(fromSrc(f.client)))
      .map(describeChain),
    stale: known.filter(
      (target) => !found.some((f) => fromSrc(f.client) === target),
    ),
  };
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
 * Every client island a stock server file loads through next/dynamic, by the
 * file that owns it. Each is client-only (ssr: false) because it reaches
 * Connect-RPC, directly or through hooks and helpers. The test below compares
 * what each file loads with this table, both ways; it does not check that
 * reason, which the walk further down checks for everything imported
 * statically. A server file loads an island with
 * nextDynamic(() => import(…), { ssr: false }), never with a static import. A
 * page that gains an island lists it here, and the test fails until it does.
 */
const CONNECT_ISLANDS: Record<string, string[]> = {
  "layout.tsx": ["~/@/components/charts/StockChartPanel"],
  "short-interest/page.tsx": [
    "~/@/components/company/peer-comparison-table",
    "~/@/components/company/stock-signals",
    "~/@/components/company/stock-verdict",
  ],
  "strategy/page.tsx": ["~/@/components/strategy/strategy-levels-chart"],
  "financials/page.tsx": [
    "~/@/components/company/company-tax-card",
    "~/@/components/company/dividend-history",
  ],
  "company/page.tsx": [
    "~/@/components/company/director-trades-table",
    "~/@/components/company/stock-connections",
  ],
  "news/page.tsx": ["~/@/components/company/event-timeline"],
};

/**
 * The client modules that reach @connectrpc by static imports from a stock
 * server file, and did before the tab routes existed. A new one fails the walk
 * below, and so does an entry that stops being true, so this list can only
 * shrink.
 *
 * Each fetches in the browser through a client-side action module that imports
 * @connectrpc/connect-web and @connectrpc/connect:
 * - layout.tsx and page.tsx: the "-with-retry" components that the server
 *   components companyProfile, companyStats and companyInfo render when their
 *   own server read fails (the Jan 2026 retry fallbacks), through
 *   app/actions/client/getStockDetails.ts.
 *
 * CompanyTaxCard was listed here as one of the old page's, and it was not safe
 * to carry over. On the old page it sat in the Financials panel of a client tab
 * shell that opens on Overview, so the server never rendered it; the Financials
 * route renders it inline, and a production build answered 500 for every stock
 * ("Element type is invalid ... got: undefined", the SSR failure CLAUDE.md
 * describes for @connectrpc). It is an island now (CONNECT_ISLANDS above).
 *
 * Moving any of the others behind nextDynamic(..., { ssr: false }) is a
 * rendering change to a live tab, so it is a decision for the owner of that
 * tab, not for this guard.
 */
const KNOWN_CLIENT_CONNECT: Record<string, string[]> = {
  "layout.tsx": [
    "~/@/components/ui/company-profile-with-retry",
    "~/@/components/ui/company-stats-with-retry",
  ],
  "page.tsx": ["~/@/components/ui/company-info-with-retry"],
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
      "%s loads exactly its islands through next/dynamic, and imports none statically",
      (name, file) => {
        // Files, not the strings that name them: `~/@/x`, `@/x` and a relative
        // path are one island.
        const islands = (CONNECT_ISLANDS[name] ?? []).map((specifier) =>
          targetOf(specifier, file),
        );
        const source = readSource(file);
        expect(
          nextDynamicLoads(source)
            .map((load) => targetOf(load.specifier, file))
            .sort(),
        ).toEqual([...islands].sort());
        const statics = importRefs(source)
          .filter((ref) => !ref.dynamic)
          .map((ref) => targetOf(ref.specifier, file));
        for (const island of islands) {
          expect(statics).not.toContain(island);
        }
      },
    );

    it.each(files)(
      "%s reaches @connectrpc through no statically imported client module, the known ones aside",
      (name, file) => {
        const known = (KNOWN_CLIENT_CONNECT[name] ?? []).map((specifier) =>
          targetOf(specifier, file),
        );
        expect(
          diffKnownClients(clientModulesReachingConnect(file), known),
        ).toEqual({ unexpected: [], stale: [] });
      },
    );
  });

  describe("the boundary's own readers", () => {
    describe("importRefs", () => {
      it("sees every way a file imports a module, and which of them are dynamic", () => {
        const refs = importRefs(`
          import a from "./a";
          import type { T } from "./type-only";
          import "./side-effect";
          export * from "./re-export";
          export { x } from "./named-re-export";
          const lazy = () => import("./lazy");
          const named = () => import(/* webpackChunkName: "c" */ "./commented");
          const wrapped = () => import(
            "./wrapped"
          );
          const required = require("./required");
        `);
        expect(refs).toEqual([
          { specifier: "./a", dynamic: false },
          { specifier: "./type-only", dynamic: false },
          { specifier: "./side-effect", dynamic: false },
          { specifier: "./re-export", dynamic: false },
          { specifier: "./named-re-export", dynamic: false },
          { specifier: "./lazy", dynamic: true },
          { specifier: "./commented", dynamic: true },
          { specifier: "./wrapped", dynamic: true },
          { specifier: "./required", dynamic: false },
        ]);
      });

      it("does not see an import named in a comment, a string or a template", () => {
        const refs = importRefs(`
          // import a from "@connectrpc/connect";
          /* import b from "@connectrpc/connect"; */
          const s = 'import c from "@connectrpc/connect"';
          const t = \`import d from "@connectrpc/connect"\`;
          const o = loader.import("@connectrpc/connect");
          import real from "./real";
        `);
        expect(refs.map((ref) => ref.specifier)).toEqual(["./real"]);
      });

      it("still sees an import that follows a // inside a string on the same line", () => {
        // Stripping comments with a regex ate everything after the `//` in a
        // string like this one, imports included.
        const refs = importRefs(
          `const glob = "src//x"; import hidden from "@connectrpc/connect";`,
        );
        expect(refs.map((ref) => ref.specifier)).toEqual([
          "@connectrpc/connect",
        ]);
      });
    });

    describe("directivesOf", () => {
      it("reads the directive prologue, whatever the quotes, semicolons and comments before it", () => {
        expect(
          directivesOf(
            `// header\n/* more */\n"use client";\nimport a from "./a";`,
          ),
        ).toEqual(["use client"]);
        expect(directivesOf(`'use client'\nimport a from "./a"`)).toEqual([
          "use client",
        ]);
        expect(directivesOf(`"use strict";\n"use server";`)).toEqual([
          "use strict",
          "use server",
        ]);
      });

      it("does not read a string after code, in a comment, or in an expression as a directive", () => {
        expect(directivesOf(`import a from "./a";\n"use client";`)).toEqual([]);
        expect(directivesOf(`// "use client"\nexport const a = 1;`)).toEqual(
          [],
        );
        expect(directivesOf(`const note = "use client";`)).toEqual([]);
      });
    });

    describe("resolveLocal", () => {
      const from = path.join(STOCK_DIR, "strategy/page.tsx");

      it("resolves the ~/, @/ and relative spellings of one file to that file", () => {
        const utils = path.join(SRC_DIR, "@/lib/utils.ts");
        expect(resolveLocal("~/@/lib/utils", from)).toBe(utils);
        expect(resolveLocal("@/lib/utils", from)).toBe(utils);
        expect(resolveLocal("../../../../@/lib/utils", from)).toBe(utils);
      });

      it("follows the tsconfig aliases that are not under src/@", () => {
        expect(resolveLocal("@/auth", from)).toBe(
          path.join(SRC_DIR, "server/auth.ts"),
        );
        expect(resolveLocal("@/app/actions/getStock", from)).toBe(
          path.join(SRC_DIR, "app/actions/getStock.ts"),
        );
      });

      it("leaves a package, and a file that is not there, unresolved", () => {
        expect(resolveLocal("react", from)).toBeNull();
        expect(resolveLocal("@connectrpc/connect", from)).toBeNull();
        expect(resolveLocal("~/does/not/exist", from)).toBeNull();
      });

      it("names an island by its file, whatever the spelling, so the registry compares files and not strings", () => {
        const island = "@/components/strategy/strategy-levels-chart.tsx";
        expect(
          targetOf("~/@/components/strategy/strategy-levels-chart", from),
        ).toBe(island);
        expect(
          targetOf("@/components/strategy/strategy-levels-chart", from),
        ).toBe(island);
        expect(
          targetOf(
            "../../../../@/components/strategy/strategy-levels-chart",
            from,
          ),
        ).toBe(island);
        // A specifier that names no file stays as written, marked, so a typo in
        // the registry shows in a diff instead of matching another typo.
        expect(targetOf("~/@/components/strategy/nope", from)).toBe(
          "unresolved: ~/@/components/strategy/nope",
        );
      });
    });

    describe("diffKnownClients", () => {
      const widget = path.join(SRC_DIR, "@/components/widget.tsx");
      const found: ClientConnect[] = [
        { client: widget, chain: [widget, "@connectrpc/connect"] },
      ];

      it("is quiet when the walk finds exactly the known client modules", () => {
        expect(diffKnownClients(found, ["@/components/widget.tsx"])).toEqual({
          unexpected: [],
          stale: [],
        });
      });

      it("reports a client module that is not known, with its chain", () => {
        expect(diffKnownClients(found, [])).toEqual({
          unexpected: ["@/components/widget.tsx -> @connectrpc/connect"],
          stale: [],
        });
      });

      it("reports a known client module that no longer reaches Connect, so the list can only shrink", () => {
        expect(diffKnownClients([], ["@/components/widget.tsx"])).toEqual({
          unexpected: [],
          stale: ["@/components/widget.tsx"],
        });
      });
    });

    describe("clientModulesReachingConnect", () => {
      const roots: string[] = [];
      afterAll(() => {
        for (const root of roots) {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });

      /** Writes a small module graph to a temp directory; returns the path to a file in it. */
      function graph(files: Record<string, string>): (name: string) => string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "stock-boundary-"));
        roots.push(root);
        for (const [name, content] of Object.entries(files)) {
          fs.writeFileSync(path.join(root, name), content);
        }
        return (name) => path.join(root, name);
      }

      /** The result by file name, so a fixture's temp path stays out of the assertion. */
      const shape = (found: ClientConnect[]) =>
        found.map(({ client, chain }) => ({
          client: path.basename(client),
          chain: chain.map((step, i) =>
            i < chain.length - 1 ? path.basename(step) : step,
          ),
        }));

      it("finds a client module that reaches Connect through helpers, however deep", () => {
        const at = graph({
          "page.tsx": `import { Island } from "./island";`,
          "island.tsx": `"use client";\nimport { useThing } from "./use-thing";`,
          "use-thing.ts": `import { api } from "./api";`,
          "api.ts": `import { createClient } from "@connectrpc/connect";`,
        });
        expect(shape(clientModulesReachingConnect(at("page.tsx")))).toEqual([
          {
            client: "island.tsx",
            chain: [
              "island.tsx",
              "use-thing.ts",
              "api.ts",
              "@connectrpc/connect",
            ],
          },
        ]);
      });

      it("finds it through a server module in between, as a wrapper renders a client fallback", () => {
        const at = graph({
          "page.tsx": `import Wrapper from "./wrapper";`,
          "wrapper.tsx": `import { Retry } from "./retry";`,
          "retry.tsx": `"use client";\nimport { fetchIt } from "./fetch-it";`,
          "fetch-it.ts": `import { transport } from "@connectrpc/connect-web";`,
        });
        expect(shape(clientModulesReachingConnect(at("page.tsx")))).toEqual([
          {
            client: "retry.tsx",
            chain: ["retry.tsx", "fetch-it.ts", "@connectrpc/connect-web"],
          },
        ]);
      });

      it("finds it when the page is itself the client module", () => {
        const at = graph({
          "page.tsx": `"use client";\nimport { api } from "./api";`,
          "api.ts": `import { createClient } from "@connectrpc/connect";`,
        });
        expect(shape(clientModulesReachingConnect(at("page.tsx")))).toEqual([
          {
            client: "page.tsx",
            chain: ["page.tsx", "api.ts", "@connectrpc/connect"],
          },
        ]);
      });

      it("passes a client module that does not reach Connect", () => {
        const at = graph({
          "page.tsx": `import { Widget } from "./widget";`,
          "widget.tsx": `"use client";\nimport { format } from "./format";\nimport { useState } from "react";`,
          "format.ts": `export const format = (n: number) => n.toFixed(1);`,
        });
        expect(clientModulesReachingConnect(at("page.tsx"))).toEqual([]);
      });

      it("does not follow a dynamic import: an island is a lazy boundary the ssr: false rule covers", () => {
        const at = graph({
          "page.tsx": `import nextDynamic from "next/dynamic";\nconst Island = nextDynamic(() => import("./island"), { ssr: false });`,
          "island.tsx": `"use client";\nimport { api } from "./api";`,
          "api.ts": `import { createClient } from "@connectrpc/connect";`,
        });
        expect(clientModulesReachingConnect(at("page.tsx"))).toEqual([]);
      });

      it('stops at a "use server" module: a client module imports a reference to it, not its code', () => {
        const at = graph({
          "page.tsx": `import { Widget } from "./widget";`,
          "widget.tsx": `"use client";\nimport { save } from "./action";`,
          "action.ts": `"use server";\nimport { createClient } from "@connectrpc/connect";`,
        });
        expect(clientModulesReachingConnect(at("page.tsx"))).toEqual([]);
      });

      it("does not blame a server module that imports Connect on the server", () => {
        const at = graph({
          "page.tsx": `import { load } from "./loader";`,
          "loader.ts": `import { createClient } from "@connectrpc/connect";`,
        });
        expect(clientModulesReachingConnect(at("page.tsx"))).toEqual([]);
      });

      it("terminates on an import cycle, and still finds the client module in it", () => {
        const at = graph({
          "page.tsx": `import { A } from "./a";`,
          "a.tsx": `"use client";\nimport { b } from "./b";`,
          "b.ts": `import { A } from "./a";\nimport { createClient } from "@connectrpc/connect";`,
        });
        expect(shape(clientModulesReachingConnect(at("page.tsx")))).toEqual([
          {
            client: "a.tsx",
            chain: ["a.tsx", "b.ts", "@connectrpc/connect"],
          },
        ]);
      });
    });
  });
});
