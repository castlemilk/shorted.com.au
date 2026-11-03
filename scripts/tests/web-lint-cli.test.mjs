import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

// Next 16 removes `next lint`. The web app lints with the ESLint CLI instead,
// and nothing in the repository should invoke `next lint` again.

const root = new URL("../../", import.meta.url);
const repo = (path) => join(root.pathname, path);
const read = (path) => readFileSync(repo(path), "utf8");

test("npm run lint is the ESLint CLI over next lint's default directories and extensions", () => {
  const script = JSON.parse(read("web/package.json")).scripts.lint;
  assert.match(script, /^eslint /);
  assert.doesNotMatch(script, /next lint/);
  assert.match(script, /--max-warnings=1000\b/);
  // The directories next lint defaulted to, and its extension list (bin/next).
  for (const dir of ["app", "pages", "components", "lib", "src"]) {
    assert.match(script, new RegExp(`\\s${dir}(\\s|$)`), dir);
  }
  assert.deepEqual(script.match(/--ext\s+(\S+)/)?.[1].split(","), [
    ".js",
    ".mjs",
    ".cjs",
    ".jsx",
    ".ts",
    ".mts",
    ".cts",
    ".tsx",
  ]);
  // A directory that does not exist is skipped, as next lint skipped it.
  assert.match(script, /--no-error-on-unmatched-pattern/);
});

// Files that can run a command. Historical notes under docs/ count as callers
// too, so a copied command still works or fails loudly.
const roots = [
  "Makefile",
  "Taskfile.yml",
  "package.json",
  "web/package.json",
  "CLAUDE.md",
  "docs",
  "scripts",
  ".github/workflows",
  ".cursor",
  "web/scripts",
];
const extensions = /\.(md|mdx|yml|yaml|sh|json|mjs|cjs|js|ts|tsx|toml|txt|Makefile)$|^Makefile$|^Taskfile\.yml$/;
const skipDirs = new Set(["node_modules", ".next", "test-results", ".git"]);
// This file names the command to forbid it, so it is not a caller.
const self = "scripts/tests/web-lint-cli.test.mjs";

function* files(path) {
  const full = repo(path);
  if (!statSync(full, { throwIfNoEntry: false })) return;
  if (statSync(full).isFile()) {
    yield relative(root.pathname, full);
    return;
  }
  for (const entry of readdirSync(full)) {
    if (skipDirs.has(entry)) continue;
    yield* files(join(path, entry));
  }
}

test("no caller invokes next lint: a command in a file under these paths would break on Next 16", () => {
  // `next lint` followed by a flag, a path, or the end of a command. Prose that
  // names it in backticks ("`next lint`") is not a call.
  const invocation = /\bnext lint\b(?!`)/;
  const hits = [];
  for (const path of roots) {
    for (const file of files(path)) {
      if (file === self || !extensions.test(file)) continue;
      readFileSync(repo(file), "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (invocation.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
        });
    }
  }
  assert.deepEqual(hits, []);
});
