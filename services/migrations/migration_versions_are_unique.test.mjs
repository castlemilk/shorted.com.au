import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

// golang-migrate refuses a directory where two up files share a version
// (source/iofs: ErrDuplicateMigration). That stops `task setup`, `make migrate-up` and
// the migrate-test stack at their first read of this directory. Keep this a guard:
// a new migration takes the next free number after origin/main and any open PR.
const dir = path.dirname(fileURLToPath(import.meta.url));

test("no two up migrations share a version number, so golang-migrate can read the directory", () => {
  const byVersion = new Map();
  for (const file of readdirSync(dir).filter((f) => /^\d+_.*\.up\.sql$/.test(f))) {
    const version = file.split("_")[0];
    byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
  }
  const duplicates = [...byVersion.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(duplicates, [], `duplicate migration versions: ${JSON.stringify(duplicates)}`);
});
