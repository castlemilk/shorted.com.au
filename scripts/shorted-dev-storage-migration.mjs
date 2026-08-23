#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const productionProject = "rosy-clover-477102-t5";

export const storageMigrations = [
  {
    source: "shorted-company-logos",
    destination: "shorted-company-logos-prod",
  },
  {
    source: "shorted-financial-reports",
    destination: "shorted-financial-reports-prod",
  },
];

export function buildRsyncArgs(migration, { dryRun }) {
  const args = [
    "storage",
    "rsync",
    `gs://${migration.source}`,
    `gs://${migration.destination}`,
    "--recursive",
    "--checksums-only",
  ];
  if (dryRun) args.push("--dry-run");
  args.push(`--project=${productionProject}`);
  return args;
}

export function assertApplyAuthorized(env) {
  if (env.CONFIRM_SHORTED_DEV_STORAGE_MIGRATION !== "prod") {
    throw new Error(
      "Copy execution requires CONFIRM_SHORTED_DEV_STORAGE_MIGRATION=prod",
    );
  }
}

export function parseArgs(args) {
  const unknown = args.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  return { apply: args.includes("--apply") };
}

export function run({ apply = false, env = process.env, runner = spawnSync } = {}) {
  if (apply) assertApplyAuthorized(env);
  for (const migration of storageMigrations) {
    const result = runner(
      "gcloud",
      buildRsyncArgs(migration, { dryRun: !apply }),
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `gcloud storage rsync failed for ${migration.source} with exit ${result.status}`,
      );
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) run(parseArgs(process.argv.slice(2)));
