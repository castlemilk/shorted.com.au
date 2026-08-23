import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertApplyAuthorized,
  buildRsyncArgs,
  parseArgs,
  run,
  storageMigrations,
} from "../shorted-dev-storage-migration.mjs";

test("migration plan copies both production dependencies into prod-owned buckets", () => {
  assert.deepEqual(storageMigrations, [
    { source: "shorted-company-logos", destination: "shorted-company-logos-prod" },
    { source: "shorted-financial-reports", destination: "shorted-financial-reports-prod" },
  ]);
});

test("copy commands use checksum comparison and never delete destination objects", () => {
  const args = buildRsyncArgs(storageMigrations[0], { dryRun: true });
  assert.deepEqual(args, [
    "storage",
    "rsync",
    "gs://shorted-company-logos",
    "gs://shorted-company-logos-prod",
    "--recursive",
    "--checksums-only",
    "--dry-run",
    "--project=rosy-clover-477102-t5",
  ]);
  assert.equal(args.includes("--delete-unmatched-destination-objects"), false);
});

test("copy execution requires the exact production confirmation", () => {
  assert.throws(() => assertApplyAuthorized({}), /CONFIRM_SHORTED_DEV_STORAGE_MIGRATION=prod/);
  assert.throws(
    () => assertApplyAuthorized({ CONFIRM_SHORTED_DEV_STORAGE_MIGRATION: "yes" }),
    /CONFIRM_SHORTED_DEV_STORAGE_MIGRATION=prod/,
  );
  assert.doesNotThrow(() =>
    assertApplyAuthorized({ CONFIRM_SHORTED_DEV_STORAGE_MIGRATION: "prod" }),
  );
});

test("CLI defaults to dry-run and accepts only an explicit apply flag", () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(["--apply"]), { apply: true });
  assert.throws(() => parseArgs(["--delete"]), /Unknown argument: --delete/);
});

test("dry-run plans both copies without production confirmation", () => {
  const calls = [];
  run({
    runner(command, args) {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ command }) => command === "gcloud"), true);
  assert.equal(calls.every(({ args }) => args.includes("--dry-run")), true);
});

test("confirmed apply copies both buckets and stops on the first failure", () => {
  const calls = [];
  assert.throws(
    () => run({ apply: true, env: {}, runner() { throw new Error("must not run"); } }),
    /CONFIRM_SHORTED_DEV_STORAGE_MIGRATION=prod/,
  );
  assert.throws(
    () =>
      run({
        apply: true,
        env: { CONFIRM_SHORTED_DEV_STORAGE_MIGRATION: "prod" },
        runner(command, args) {
          calls.push({ command, args });
          return { status: 9 };
        },
      }),
    /shorted-company-logos.*exit 9/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes("--dry-run"), false);
});
