#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const portalWrapperShapeAllowlist = new Set([
  "services/house-price-collector/crawl_details_extract_test.go",
  "services/house-price-collector/crawl_listings_extract_test.go",
  "services/house-price-collector/crawl_listings_test.go",
  "services/house-price-collector/crawl_property_extract_test.go",
  "services/house-price-collector/crawl_test.go",
  "services/house-price-collector/crawl_warmcheck_test.go",
  "services/jobs/internal/jobs/houseprices/crawl_details_extract_test.go",
  "services/jobs/internal/jobs/houseprices/crawl_listings_extract_test.go",
  "services/jobs/internal/jobs/houseprices/crawl_listings_test.go",
  "services/jobs/internal/jobs/houseprices/crawl_property_extract_test.go",
  "services/jobs/internal/jobs/houseprices/crawl_test.go",
  "services/jobs/internal/jobs/houseprices/crawl_warmcheck_test.go",
]);

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
  return path.startsWith("web/") || path.startsWith("services/");
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

/**
 * `git -C <dir>` does NOT override an inherited GIT_DIR, and every git hook
 * exports one. Left alone, this listed the hook's repository while resolving the
 * paths against `root` — so every path failed isRegularFile(), the scan found
 * ZERO files, and the gate reported a clean pass. It has to be stripped, or the
 * check silently stops checking in exactly the place it is meant to run.
 */
function gitEnvStripped() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function trackedFiles(root) {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z", "--", "services", "web"], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    env: gitEnvStripped(),
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
    ...collectFiles(join(root, "services")),
    ...collectFiles(join(root, "web")),
  ];
}

function signatures(source, path) {
  const matches = [];
  const allowPortalWrapperShape = portalWrapperShapeAllowlist.has(path);
  if (!allowPortalWrapperShape && /window\s*\.\s*ArgonautExchange\s*=/.test(source)) {
    matches.push("REA Argonaut bootstrap");
  }
  if (!allowPortalWrapperShape && /canonicalSearchId/.test(source)) {
    matches.push("REA canonical search payload");
  }
  if (!allowPortalWrapperShape && /__NEXT_DATA__/.test(source) && /["']?totalListings["']?\s*:/.test(source) && /["']?searchRequest["']?\s*:/.test(source)) {
    matches.push("Domain search bootstrap");
  }
  if (/https?:\/\/(?:www\.)?realestate\.com\.au\/property(?:\/[a-z0-9]|-(?!not-found(?:[/?#"']|$))[a-z0-9])/i.test(source)) {
    matches.push("REA canonical listing URL");
  }
  if (/https?:\/\/(?:www\.)?domain\.com\.au\/[a-z0-9][a-z0-9+_/-]*-\d{9,}(?:[/?#"']|$)/i.test(source)) {
    matches.push("Domain canonical listing URL");
  }
  if (/["'](?:fulladdress|shortaddress|streetaddress|street)["']\s*:\s*["']\d+(?:[/ -])/i.test(source)) {
    matches.push("numbered listing address");
  }
  const hasListingShape = /["'](?:listingcompany|listingModel|listingId|resolvedListings)["']\s*:/i.test(source);
  const hasAustralianLocality =
    /["']state["']\s*:\s*["'](?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)["'][\s\S]{0,160}["'](?:postCode|postcode)["']\s*:\s*["'](?!0000)\d{4}["']/i.test(source) ||
    /["'](?:postCode|postcode)["']\s*:\s*["'](?!0000)\d{4}["'][\s\S]{0,160}["']state["']\s*:\s*["'](?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)["']/i.test(source);
  if (hasListingShape && hasAustralianLocality) {
    matches.push("Australian listing locality");
  }
  return matches;
}

function main() {
  const root = parseRoot(process.argv.slice(2));
  const files = scopedFiles(root).sort();
  const findings = [];

  for (const file of files) {
    const source = readFileSync(file).toString("utf8");
    const path = relative(root, file).split(sep).join("/");
    for (const signature of signatures(source, path)) {
      findings.push({
        path,
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
