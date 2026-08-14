/**
 * A "use client" politician surface must not drag the generated protobuf module
 * across the client boundary.
 *
 * THIS HAS NOW BITTEN TWICE. The failure mode is documented in CLAUDE.md and is
 * uniquely horrible to diagnose: the build reports
 *
 *   Error: Element type is invalid: expected a string (for built-in components)
 *   or a class/function (for composite components) but got: undefined.
 *
 * with a minified digest and no file name. It took the whole static build of
 * /politicians down when politician-explorer.tsx imported PartyChip from
 * compliance.tsx — compliance has no "use client" directive and imports
 * RegisterHolder from ~/gen/…/politicians_pb, so the protobuf runtime followed
 * it into the client bundle.
 *
 * JEST DOES NOT CATCH THIS. Every component test passed while the production
 * build failed, because jest resolves the module graph without the RSC client
 * boundary. Only a structural check or a full build finds it — so here is the
 * structural check.
 *
 * THE CHECK ITSELF WAS TOO WEAK, AND SOMETHING GOT THROUGH. Until 2026-07-31 it
 * only looked at each file's OWN import lines. The explorer kit's
 * about-this-data.tsx imported `../compliance` for SourceLine/CaveatNote, which
 * is one hop from the protobuf runtime, and every assertion here passed: the
 * import was direct in about-this-data, but about-this-data is not itself a
 * "use client" file, so no rule looked at it at all. The whole point of the
 * rule is that the danger is TRANSITIVE, so the walk is now transitive too, and
 * it covers the kit whether or not a given file carries the directive — a
 * props-only kit that cannot be imported by a client island is not a kit.
 *
 * The fix is always the same: import from `@/lib/politics/party-palette`, which
 * was split out of the heavy modules for exactly this reason and is pure data,
 * or take the strings as props.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const COMPONENT_DIR = join(__dirname, "..");
const EXPLORER_DIR = join(COMPONENT_DIR, "explorer");
/** `src/` — the root every path alias in tsconfig.json is expressed against. */
const SRC_DIR = join(__dirname, "..", "..", "..", "..");
const GEN_DIR = join(SRC_DIR, "gen");
const COMPLIANCE_FILE = join(COMPONENT_DIR, "compliance.tsx");

function collect(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "__tests__" || entry === "__snapshots__") return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return collect(full);
    return /\.tsx?$/.test(full) ? [full] : [];
  });
}

const FILES = collect(COMPONENT_DIR);

const CLIENT_FILES = FILES.filter((f) => {
  const src = readFileSync(f, "utf8");
  return /^\s*["']use client["']/m.test(src);
});

const EXPLORER_FILES = collect(EXPLORER_DIR);

/**
 * Components that are NEVER server-rendered, and so cannot cause the prerender
 * failure this file exists to prevent.
 *
 * suburb-politician-property-card.tsx is reached only through its sibling
 * loader, which is `dynamic(…, { ssr: false })` — deliberately, and its comment
 * says why: it keeps politicians_pb in its own async chunk instead of the hot
 * /housing/[state]/[suburb] bundle. It never prerenders, so importing the
 * compliance kit costs bundle weight rather than breaking the build.
 *
 * The exemption is for the SSR rule only. It is listed here rather than filtered
 * out silently so that the trade-off stays visible, and the test below checks
 * the loader really is ssr:false rather than trusting this comment.
 *
 * In the transitive walk it is a WALL, not just an excused root: the graph is
 * cut where it is reached, because the whole point of the ssr:false loader is
 * that what lies beyond it is a separate chunk.
 */
const NEVER_SERVER_RENDERED = ["suburb-politician-property-card.tsx"];

/** Modules that pull @bufbuild/protobuf or @connectrpc/connect in behind them. */
const FORBIDDEN_IMPORT = /from\s+["'](~\/gen\/|@bufbuild\/protobuf|@connectrpc\/connect)/;

/**
 * compliance.tsx is server-side: no "use client", and it imports the generated
 * RegisterHolder enum. A client component importing it inherits that.
 */
const FORBIDDEN_TRANSITIVE = /from\s+["'][^"']*\/compliance["']/;

/** Bare packages that ARE the runtime we are keeping out, by name. */
const FORBIDDEN_PACKAGES = [/^@bufbuild\/protobuf/, /^@connectrpc\/connect/];

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Aliases whose target is NOT under `src/@` (see tsconfig.json paths). */
const NON_AT_ROOTS = ["app", "server", "styles"];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every module specifier a file pulls in: static imports and re-exports, plus
 * `import()` and `require()`. Dynamic imports are followed on purpose — a lazy
 * chunk still ships the runtime — with the one sanctioned ssr:false boundary
 * handled by NEVER_SERVER_RENDERED above.
 */
function importsOf(file: string): string[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function resolveFile(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const index = join(base, `index${ext}`);
    if (existsSync(index)) return index;
  }
  return null;
}

/**
 * The tsconfig path aliases, by hand. Deliberately dependency-free: adding a
 * resolver package to make this test work would put the guard at the mercy of
 * the same bundler resolution it exists to second-guess.
 *
 * Returns null for anything that is not a local file — a bare package is either
 * on the forbidden list (checked by name) or irrelevant here.
 */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveFile(resolve(dirname(fromFile), specifier));
  }
  if (specifier.startsWith("~/")) {
    return resolveFile(join(SRC_DIR, specifier.slice(2)));
  }
  if (specifier === "@/auth") return resolveFile(join(SRC_DIR, "server", "auth"));
  if (specifier.startsWith("@/")) {
    const rest = specifier.slice(2);
    const root = rest.split("/")[0] ?? "";
    return resolveFile(
      NON_AT_ROOTS.includes(root)
        ? join(SRC_DIR, rest)
        : join(SRC_DIR, "@", rest),
    );
  }
  return null;
}

function isUnder(file: string, dir: string): boolean {
  return !relative(dir, file).startsWith("..");
}

function isWall(file: string): boolean {
  return NEVER_SERVER_RENDERED.some((name) => file.endsWith(`${sep}${name}`));
}

function forbiddenReason(file: string): string | null {
  if (isUnder(file, GEN_DIR)) return "generated protobuf module";
  if (file === COMPLIANCE_FILE) return "compliance.tsx (imports ~/gen)";
  return null;
}

function show(file: string): string {
  return relative(SRC_DIR, file);
}

/**
 * Walk the import graph from `root` and describe the first path that reaches
 * the protobuf runtime, or null if none does.
 *
 * The whole CHAIN is reported, not just the endpoint: "about-this-data.tsx ->
 * compliance.tsx -> politicians_pb" is a fixable sentence, whereas "this file
 * is bad" sends the next person hunting through a graph by hand.
 */
function findForbiddenPath(
  root: string,
  { walls = true }: { walls?: boolean } = {},
): string | null {
  const seen = new Set<string>([root]);
  const queue: string[][] = [[root]];
  while (queue.length) {
    const chain = queue.shift();
    const file = chain?.[chain.length - 1];
    if (!chain || !file) continue;
    for (const specifier of importsOf(file)) {
      if (FORBIDDEN_PACKAGES.some((pattern) => pattern.test(specifier))) {
        return [...chain, specifier].map(show).join(" -> ");
      }
      const resolved = resolveSpecifier(specifier, file);
      if (!resolved || seen.has(resolved)) continue;
      const reason = forbiddenReason(resolved);
      if (reason) {
        return `${[...chain, resolved].map(show).join(" -> ")} (${reason})`;
      }
      seen.add(resolved);
      if (walls && isWall(resolved)) continue;
      if (/\.(?:tsx?|jsx?|mjs|cjs)$/.test(resolved)) queue.push([...chain, resolved]);
    }
  }
  return null;
}

/**
 * The roots the transitive rule applies to.
 *
 *   - every "use client" politician component (the original rule), and
 *   - every file in the explorer kit, client-marked or not: the kit's contract
 *     is that a client island can compose it, and a contract only checked on
 *     files that already carry the directive is checked after the fact.
 */
const TRANSITIVE_ROOTS = [
  ...CLIENT_FILES.filter((f) => !isWall(f)),
  ...EXPLORER_FILES,
].filter((file, index, all) => all.indexOf(file) === index);

describe("politician client boundary", () => {
  it("finds the client components it means to check", () => {
    // A guard on the guard: if the discovery ever returns nothing, every
    // assertion below passes vacuously and the check silently stops working.
    expect(CLIENT_FILES.length).toBeGreaterThan(0);
    expect(EXPLORER_FILES.length).toBeGreaterThan(0);
    expect(TRANSITIVE_ROOTS.length).toBeGreaterThan(CLIENT_FILES.length);
  });

  it.each(CLIENT_FILES)("%s does not import generated protobuf modules", (file) => {
    const src = readFileSync(file, "utf8");
    const match = src.match(FORBIDDEN_IMPORT);
    expect(match?.[0] ?? null).toBeNull();
  });

  it.each(CLIENT_FILES.filter((f) => !NEVER_SERVER_RENDERED.some((n) => f.endsWith(n))))(
    "%s does not import the server-side compliance kit",
    (file) => {
      const src = readFileSync(file, "utf8");
      const match = src.match(FORBIDDEN_TRANSITIVE);
      expect(match?.[0] ?? null).toBeNull();
    },
  );

  it.each(TRANSITIVE_ROOTS)(
    "%s reaches no protobuf module through ANY import path",
    (file) => {
      expect(findForbiddenPath(file)).toBeNull();
    },
  );

  // The walk above is only worth anything if it actually finds a multi-hop
  // path. This is that proof, on a real one rather than a fixture: the suburb
  // card is a client component that imports compliance.tsx, which imports the
  // generated enum — precisely the two-hop shape that about-this-data.tsx had
  // and that the old direct-import rule could not see. If this ever returns
  // null the resolver has quietly stopped resolving and every assertion above
  // is passing for the wrong reason.
  it("the transitive walk really does find a two-hop path", () => {
    const card = join(COMPONENT_DIR, "suburb-politician-property-card.tsx");
    const path = findForbiddenPath(card, { walls: false });
    expect(path).not.toBeNull();
    expect(path).toContain("compliance.tsx");
  });

  it.each(NEVER_SERVER_RENDERED)("%s is genuinely never server-rendered", (name) => {
    // The exemption above is only sound while this holds. If someone drops the
    // loader or flips ssr back on, the exempted component starts prerendering
    // with the protobuf runtime behind it and takes a route's build down.
    const loader = readFileSync(
      join(COMPONENT_DIR, name.replace(/\.tsx$/, "-loader.tsx")),
      "utf8",
    );
    expect(loader).toMatch(/ssr:\s*false/);
  });

  it("compliance.tsx is still the server-side module this rule assumes", () => {
    // If someone adds "use client" to compliance.tsx the rule above becomes
    // unnecessary — and this test should be revisited rather than left asserting
    // something that no longer means anything.
    const compliance = readFileSync(COMPLIANCE_FILE, "utf8");
    expect(/^\s*["']use client["']/m.test(compliance)).toBe(false);
    expect(compliance).toMatch(/from\s+["']~\/gen\//);
  });
});
