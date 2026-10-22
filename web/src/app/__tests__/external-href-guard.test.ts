/**
 * An href taken from data goes through safeExternalHref (or safeLinkHref).
 *
 * Security review SEC-07: company websites and social links, news,
 * announcement, listing and register URLs, citations and community sources
 * were rendered as `href={article.url}`: whatever the row held, `javascript:`
 * included, and React 18 renders that, so the link ran in our origin when it
 * was followed. lib/safe-external-href.ts admits only http(s) (and, for
 * safeLinkHref, our own paths); lib/__tests__/safe-external-href.test.ts
 * holds the payloads.
 *
 * What it checks, in every .ts and .tsx file under src/ but tests, mocks and
 * generated code, read with TypeScript's own parser: an `href` written as a
 * bare field or variable whose name says it holds a URL (`url`, `website`,
 * `sourceUrl`, `linkedin_url`, `citations[0]`, ...). Such an href passes when
 *  - it is a call (safeExternalHref(...), or a builder such as stockTabHref),
 *  - its root is a variable the same file sets from safeExternalHref or
 *    safeLinkHref (`const href = safeExternalHref(x)`),
 *  - its root is siteConfig (constants in config/site.ts), or
 *  - it is listed in NOT_STORED below, with the reason it holds no stored URL.
 *
 * What it cannot see: a URL in a field named some other way (`f.v1`), and a
 * value checked in another module before it arrives.
 */

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC_DIR = path.resolve(__dirname, "../..");
const SKIPPED_DIRS = new Set(["__tests__", "__mocks__", "gen", "node_modules"]);

/** A name that holds a URL. */
const URL_NAME =
  /^(url|uri|website|homepage|links?|linkedin|twitter|facebook|youtube|instagram|citations?)$|(Url|_url|Uri|_uri)$/;

const SANITISERS = new Set(["safeExternalHref", "safeLinkHref"]);

/**
 * Raw hrefs the scan flags that hold no stored URL, as "<file> <expression>".
 * A check below fails once an entry no longer matches a site: delete it.
 */
const NOT_STORED: Record<string, string> = {
  "@/components/features/housing/sources-list.tsx s.url":
    "SOURCES, an editorial constant in features/housing/data/sources.ts",
  "@/components/housing/calculators/stamp-duty-calculator.tsx info.sourceUrl":
    "a constant in lib/housing/stamp-duty.ts",
  "@/components/ui/news-source-badge.tsx config.url": "NEWS_SOURCES, a constant map in the same file",
  "app/authors/[slug]/page.tsx author.sameAs.linkedin": "AUTHORS, a constant in data/authors.ts",
  "app/authors/[slug]/page.tsx author.sameAs.twitter": "AUTHORS, a constant in data/authors.ts",
  "app/authors/[slug]/page.tsx author.sameAs.website": "AUTHORS, a constant in data/authors.ts",
  "@/components/rate-limit/rate-limit-notice.tsx upgradeUrl":
    "a caller's constant, or the API's upgrade_url after parseUpgradeUrl (lib/retry.ts), which admits only a same-origin path or an http(s) URL",
  "@/components/stocks/latest-result-card.tsx document.url":
    "latestResultSourceDocument builds it with safeHttpUrl (fundamentals-model.ts), which is safeExternalHref",
  "app/oauth/authorize/consent-screen.tsx handoff.url":
    "the OAuth redirect URI, checked by the authorization server (services/shorts/internal/oauth/clients.go), which also admits RFC 8252 private-use schemes that an http(s)-only check would break",
  "app/oauth/authorize/consent-screen.tsx url":
    "the same OAuth redirect URI, handed to HandoffFallback",
};

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

/** The value an href reads: parentheses, casts and a `?? fallback` aside. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      current = current.left;
    } else {
      return current;
    }
  }
}

/** `article.url` → "url", `s.citations[0]` → "citations". */
function finalName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return finalName(unwrap(node.expression));
  return undefined;
}

/** `article.url` → "article". */
function rootName(node: ts.Expression): string | undefined {
  let current = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function callsSanitiser(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && SANITISERS.has(node.expression.text)) {
    return true;
  }
  return ts.forEachChild(node, (child) => callsSanitiser(child) || undefined) ?? false;
}

/** Whether the file sets a variable of this name from a sanitiser. */
function sanitisedVariable(file: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      callsSanitiser(node.initializer)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Raw data hrefs in a file, as "<line> <expression>". */
function rawDataHrefs(file: ts.SourceFile): { line: number; expression: string }[] {
  const found: { line: number; expression: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(file) === "href" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      const value = unwrap(node.initializer.expression);
      const name = finalName(value);
      const root = rootName(value);
      if (
        name &&
        URL_NAME.test(name) &&
        root !== "siteConfig" &&
        !(root && sanitisedVariable(file, root))
      ) {
        found.push({
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          expression: node.initializer.expression.getText(file),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the scan", () => {
  it("flags the hrefs SEC-07 found", () => {
    const file = parse(
      "old.tsx",
      `export const A = ({ article, stock, person, s, url }) => (
        <>
          <a href={article.url}>a</a>
          <Link href={stock.website}>b</Link>
          <a href={person.linkedin_url}>c</a>
          <a href={s.citations[0]}>d</a>
          <a href={url}>e</a>
          <a href={trade.announcementUrl ?? ""}>f</a>
        </>
      );`,
    );

    expect(rawDataHrefs(file).map((site) => site.expression)).toEqual([
      "article.url",
      "stock.website",
      "person.linkedin_url",
      "s.citations[0]",
      "url",
      'trade.announcementUrl ?? ""',
    ]);
  });

  it("passes a sanitised href, a builder, an internal href and siteConfig", () => {
    const file = parse(
      "new.tsx",
      `const websiteHref = safeExternalHref(stock.website);
       const links = { linkedin: safeExternalHref(raw.linkedin) };
       export const A = ({ article, item }) => (
         <>
           <a href={safeExternalHref(article.url)}>a</a>
           <a href={websiteHref}>b</a>
           <a href={links.linkedin}>c</a>
           <Link href={stockTabHref(code, "news")}>d</Link>
           <Link href={item.href}>e</Link>
           <a href={siteConfig.founder.website}>f</a>
           <a href={\`/shorts/\${code}\`}>g</a>
         </>
       );`,
    );

    expect(rawDataHrefs(file)).toEqual([]);
  });

  it("does not take a variable set some other way as sanitised", () => {
    const file = parse(
      "fake.tsx",
      `const website = stock.website.trim();
       export const A = () => <a href={website}>a</a>;`,
    );

    expect(rawDataHrefs(file).map((site) => site.expression)).toEqual(["website"]);
  });
});

describe("hrefs in src/", () => {
  const sites = sourceFiles().flatMap((name) =>
    rawDataHrefs(parse(name, fs.readFileSync(path.join(SRC_DIR, name), "utf8"))).map(
      (site) => ({ name, ...site }),
    ),
  );

  it("take no stored URL raw", () => {
    const offenders = sites
      .filter(({ name, expression }) => !(`${name} ${expression}` in NOT_STORED))
      .map(({ name, line, expression }) => `${name}:${line} href={${expression}}`);

    // Wrap the value: href={safeExternalHref(x.url)} (safeLinkHref for prose
    // that links our own pages), and render the text alone when it returns
    // undefined. A value that is not stored data goes in NOT_STORED, with why.
    expect(offenders).toEqual([]);
  });

  it("lists no NOT_STORED entry that matches nothing", () => {
    const seen = new Set(sites.map(({ name, expression }) => `${name} ${expression}`));

    expect(Object.keys(NOT_STORED).filter((key) => !seen.has(key))).toEqual([]);
  });
});
