import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The prod root pins every provider to an EXACT version and commits the lock
// file. Floating constraints plus a gitignored lock file let cloudflare v5.26.0
// arrive unannounced on 2026-09-26 and fail a deploy that touched no Terraform.
const root = new URL("../../terraform/environments/prod/", import.meta.url);
const mainTf = readFileSync(new URL("main.tf", root), "utf8");
const lock = readFileSync(new URL(".terraform.lock.hcl", root), "utf8");
const gitignore = readFileSync(new URL("../../.gitignore", root), "utf8");

function requiredProviders() {
  const block = mainTf.match(/required_providers\s*\{([\s\S]*?)\n  \}/);
  assert.ok(block, "required_providers block not found");
  const out = {};
  for (const m of block[1].matchAll(/source\s*=\s*"([^"]+)"\s*\n\s*version\s*=\s*"([^"]+)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

test("every prod provider is pinned to an exact version", () => {
  const providers = requiredProviders();
  assert.ok(Object.keys(providers).length >= 4, `too few providers: ${JSON.stringify(providers)}`);
  for (const [source, version] of Object.entries(providers)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${source} is "${version}", not an exact version`);
  }
});

test("the committed lock file matches the pins, for every runner and laptop platform", () => {
  for (const [source, version] of Object.entries(requiredProviders())) {
    const entry = lock.match(
      new RegExp(`provider "registry\\.terraform\\.io/${source}" \\{\\s*version\\s*=\\s*"([^"]+)"[\\s\\S]*?hashes = \\[([\\s\\S]*?)\\]`),
    );
    assert.ok(entry, `${source} missing from .terraform.lock.hcl`);
    assert.equal(entry[1], version, `${source}: lock has ${entry[1]}, main.tf pins ${version}`);
    // One h1: hash per platform (linux/darwin x amd64/arm64): a lock built for
    // fewer platforms makes `terraform init` fail on the machines it lacks.
    const h1 = entry[2].match(/"h1:/g) ?? [];
    assert.ok(h1.length >= 4, `${source}: only ${h1.length} h1 hashes; lock all four platforms`);
  }
});

test("the prod lock file is not gitignored", () => {
  assert.match(gitignore, /^!environments\/prod\/\.terraform\.lock\.hcl$/m);
});
