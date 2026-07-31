/**
 * The kit's own boundary check: props-only, client-safe, no protobuf.
 *
 * This file checks each kit file's OWN imports. The TRANSITIVE walk — the one
 * that catches a kit file reaching the protobuf runtime two hops away, as
 * about-this-data.tsx did through compliance.tsx — lives in
 * ../../__tests__/client-boundary.test.ts and covers this directory.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COMPONENT_DIR = join(__dirname, "..");
const COMPONENT_FILES = readdirSync(COMPONENT_DIR)
  .filter((entry) => /\.tsx?$/.test(entry))
  .map((entry) => join(COMPONENT_DIR, entry));

const FORBIDDEN_IMPORTS =
  /(?:politicians_pb|@bufbuild\/protobuf|@connectrpc\/connect|recharts|visx|d3)/i;

/**
 * compliance.tsx has no "use client" and imports the generated RegisterHolder
 * enum, so a kit file importing it makes the whole kit unusable from a client
 * island. The band that needed its copy takes the strings as props instead.
 */
const COMPLIANCE_IMPORT = /from\s+["'][^"']*\/compliance["']/;

describe("explorer component boundary", () => {
  it("finds the kit files it means to check", () => {
    expect(COMPONENT_FILES.length).toBeGreaterThan(0);
  });

  it("keeps every kit component server-safe", () => {
    for (const file of COMPONENT_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/^\s*["']use client["']/m);
      expect(source).not.toMatch(FORBIDDEN_IMPORTS);
    }
  });

  it("imports nothing from the server-side compliance kit", () => {
    for (const file of COMPONENT_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(COMPLIANCE_IMPORT);
    }
  });
});
