/// <reference types="jest" />
/**
 * A narrow shorts sync never revalidates the broad `shorts-data` tag. It
 * expires stock:<CODE>, shorts-latest, market-date:<date>, market-index and
 * report-<slug> instead (app/api/revalidate/shorts-change.ts). So a cached read
 * tagged ONLY `shorts-data` is refreshed by nothing but its own window after a
 * routine sync: a day, for most of them.
 *
 * These checks keep every shorts read on a helper that names its narrow scope
 * (stockPageCacheTags, shortsLatestCacheTags in stockPageCache.ts):
 *   1. no source file spells the "shorts-data" string except stockPageCache.ts;
 *   2. SHORTS_DATA_CACHE_TAG itself is used only where it travels with a narrow
 *      tag of its own. A new use goes in ALLOWED_BROAD_TAG_USERS with that tag.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC = path.resolve(__dirname, "../../..");

const ALLOWED_BROAD_TAG_USERS: Record<string, string> = {
  "app/actions/stockPageCache.ts": "defines the tag and its helpers",
  "app/actions/edgeRead.ts": "adds it beside the caller's scope tags",
  "app/actions/market/getMarketByDate.ts": "beside market-date:<date> and market-index",
  "app/actions/reports/getReportData.ts": "beside report-<slug>",
  "app/api/revalidate/route.ts": "reads tag=shorts-data as the broad request",
  "app/api/revalidate/shorts-change.ts": "the broad revalidation",
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["__tests__", "gen", "node_modules"].includes(entry.name) ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|stories)\.tsx?$/.test(entry.name)
      ? [full]
      : [];
  });
}

const files = sourceFiles(SRC);

function nodes(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

describe("shorts cache tag scopes", () => {
  it("finds the source it is meant to police", () => {
    expect(files.map((f) => path.relative(SRC, f))).toEqual(
      expect.arrayContaining(["app/actions/getTopShorts.ts", "app/actions/getStock.ts"]),
    );
  });

  it("spells the broad tag only in stockPageCache.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(SRC, file);
      if (relative === "app/actions/stockPageCache.ts") continue;
      if (!fs.readFileSync(file, "utf8").includes("shorts-data")) continue;
      for (const n of nodes(parse(file))) {
        if (
          (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
          n.text === "shorts-data"
        ) {
          offenders.push(relative);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses SHORTS_DATA_CACHE_TAG only beside a narrow tag of its own", () => {
    const users = files
      .filter((file) => {
        const sf = parse(file);
        return nodes(sf).some(
          (n) =>
            ts.isIdentifier(n) &&
            n.text === "SHORTS_DATA_CACHE_TAG" &&
            !ts.isImportSpecifier(n.parent),
        );
      })
      .map((file) => path.relative(SRC, file))
      .sort();
    expect(users).toEqual(Object.keys(ALLOWED_BROAD_TAG_USERS).sort());
  });
});
