#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseRoot(argv) {
  if (argv.length === 0) {
    return defaultRoot;
  }
  if (argv.length === 2 && argv[0] === "--root" && argv[1]) {
    return resolve(argv[1]);
  }
  throw new Error("usage: node scripts/check-portal-content-provenance.mjs [--root <path>]");
}

function collectFiles(directory, { insideTestdata = true } = {}) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return files;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") {
        continue;
      }
      files.push(...collectFiles(path, { insideTestdata: insideTestdata || entry.name === "testdata" }));
    } else if (entry.isFile() && insideTestdata) {
      files.push(path);
    }
  }
  return files;
}

function isInScope(path) {
  return path.startsWith("web/") || (path.startsWith("services/") && path.includes("/testdata/"));
}

function isRegularFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function trackedFiles(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--", "services", "web"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter(isInScope)
    .map((path) => join(root, path))
    .filter(isRegularFile);
}

function scopedFiles(root) {
  const tracked = trackedFiles(root);
  if (tracked !== null) {
    return tracked;
  }
  return [
    ...collectFiles(join(root, "services"), { insideTestdata: false }),
    ...collectFiles(join(root, "web")),
  ];
}

function signatures(source) {
  const matches = [];
  if (/window\s*\.\s*ArgonautExchange\s*=/.test(source)) {
    matches.push("REA Argonaut bootstrap");
  }
  if (/canonicalSearchId/.test(source)) {
    matches.push("REA canonical search payload");
  }
  if (/__NEXT_DATA__/.test(source) && /["']?totalListings["']?\s*:/.test(source) && /["']?searchRequest["']?\s*:/.test(source)) {
    matches.push("Domain search bootstrap");
  }
  return matches;
}

function main() {
  const root = parseRoot(process.argv.slice(2));
  const files = scopedFiles(root).sort();
  const findings = [];

  for (const file of files) {
    const source = readFileSync(file).toString("utf8");
    for (const signature of signatures(source)) {
      findings.push({
        path: relative(root, file).split(sep).join("/"),
        signature,
      });
    }
  }

  if (findings.length > 0) {
    console.error("Portal content provenance violations:");
    for (const finding of findings) {
      console.error(`- ${finding.path}: ${finding.signature}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Portal content provenance check passed (${files.length} scoped files scanned).`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
