/**
 * The strategy kit must not reach the protobuf runtime or Connect from a file a
 * client island may compose: importing them drags the generated descriptors
 * into the route bundle, and the static build fails with the undiagnosable
 * "Element type is invalid" (see components/picks/__tests__/client-boundary.test.ts).
 * This checks each kit file's own imports; the transitive walk is the picks test.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const COMPONENT_DIR = join(__dirname, "..");
const FORBIDDEN = /^(?:@bufbuild\/protobuf|@connectrpc\/|~\/gen|@\/gen)/;
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g;

function kitFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory())
      return entry === "__tests__" ? [] : kitFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("strategy components import no protobuf or Connect module", () => {
  for (const file of kitFiles(COMPONENT_DIR)) {
    it(`${file.slice(COMPONENT_DIR.length + 1)} imports only plain modules`, () => {
      const source = readFileSync(file, "utf8");
      const specs = [...source.matchAll(IMPORT_RE)].map((m) => m[1]!);
      expect(specs.filter((s) => FORBIDDEN.test(s))).toEqual([]);
    });
  }
});
