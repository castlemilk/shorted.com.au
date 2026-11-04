/// <reference types="jest" />

/**
 * Spec 14.8: every fund link goes through `fundHref(key)`, so the one encoding of a
 * fund's key lives in kinds.ts. This walks the source tree and fails on any file
 * that builds a fund path by hand. The needle is split so this file does not match it.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

import { fundHref } from "../kinds";

const SRC = resolve(__dirname, "../../../..");
const NEEDLE = "/ownership/funds/" + "${";
const OWNER = join(SRC, "@", "lib", "ownership", "kinds.ts");
const SOURCE = /\.(ts|tsx|mjs|js|jsx)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return SOURCE.test(name) ? [path] : [];
  });
}

describe("fund links (spec 14.8)", () => {
  it("builds no fund path outside kinds.ts", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => file !== OWNER && file !== __filename)
      .filter((file) => readFileSync(file, "utf8").includes(NEEDLE))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it("encodes a super option's key as one segment", () => {
    expect(fundHref("aware/High Growth")).toBe("/ownership/funds/aware%2FHigh%20Growth");
  });
});
