/// <reference types="jest" />

/**
 * No em dash anywhere on the workspace (spec 14.9, section 7's copy rule). The scan covers
 * the ownership pages, components and lib; a figure's range is written "to", and a pause
 * in a line is a full stop, a colon or a comma.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const EM_DASH = String.fromCharCode(0x2014);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("the workspace copy (spec 14.9)", () => {
  const roots = [
    resolve(__dirname, ".."),
    resolve(__dirname, "../../../../app/ownership"),
    resolve(__dirname, "../../../lib/ownership"),
  ];

  it("carries no em dash in any ownership page, component or lib file", () => {
    const offenders = roots
      .flatMap((root) => filesUnder(root))
      .filter((path) => /\.(tsx?|css|md)$/.test(path))
      .filter((path) => readFileSync(path, "utf8").includes(EM_DASH));
    expect(offenders).toEqual([]);
  });
});
