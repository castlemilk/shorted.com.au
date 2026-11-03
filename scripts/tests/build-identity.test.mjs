import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildIdentityEnv } from "../../web/src/config/build-identity.mjs";

const SHA = "6f1d9392cada83e7e910e36a7526e8821db44d36";
const NOW = new Date("2026-11-03T06:57:48.995Z");
const identity = (env, extra = {}) =>
  buildIdentityEnv({ env, now: NOW, packageVersion: "pkg-1.0.0", ...extra });

test("a CI production build reports the release commit, its short form and the ref", () => {
  // The environment terraform-deploy.yml gives `vercel build` for a push to main.
  assert.deepEqual(
    identity({
      SHORTED_RELEASE_SHA: SHA,
      SHORTED_RELEASE_REF: "main",
      VERCEL_ENV: "production",
    }, { gitVersion: "6f1d9392" }),
    {
      NEXT_PUBLIC_RELEASE_COMMIT: SHA,
      SHORTED_BUILD_VERSION: "6f1d9392",
      SHORTED_BUILD_DATE: "2026-11-03T06:57:48.995Z",
      SHORTED_BUILD_COMMIT: "6f1d939",
      SHORTED_BUILD_BRANCH: "main",
      SHORTED_BUILD_ENVIRONMENT: "production",
    },
  );
});

test("the deploy workflow's release ref is the branch, ahead of Vercel's and GitHub's", () => {
  const values = identity({
    SHORTED_RELEASE_REF: "main",
    VERCEL_GIT_COMMIT_REF: "feature",
    GITHUB_REF_NAME: "other",
  });
  assert.equal(values.SHORTED_BUILD_BRANCH, "main");
});

test("Vercel's commit variable is the fallback for the commit, and GitHub's ref for the branch", () => {
  const values = identity({
    VERCEL_GIT_COMMIT_SHA: SHA,
    VERCEL_GIT_COMMIT_REF: "feature",
  });
  assert.equal(values.NEXT_PUBLIC_RELEASE_COMMIT, SHA);
  assert.equal(values.SHORTED_BUILD_COMMIT, "6f1d939");
  assert.equal(values.SHORTED_BUILD_BRANCH, "feature");
  assert.equal(identity({ GITHUB_REF_NAME: "main" }).SHORTED_BUILD_BRANCH, "main");
});

test("the release SHA wins over Vercel's commit variable", () => {
  const other = "a".repeat(40);
  const values = identity({ SHORTED_RELEASE_SHA: SHA, VERCEL_GIT_COMMIT_SHA: other });
  assert.equal(values.NEXT_PUBLIC_RELEASE_COMMIT, SHA);
});

test("an empty variable counts as unset, so it falls through to the next source", () => {
  const values = identity({
    SHORTED_RELEASE_SHA: "",
    VERCEL_GIT_COMMIT_SHA: SHA,
    VERCEL_GIT_COMMIT_REF: "",
    GITHUB_REF_NAME: "main",
  });
  assert.equal(values.NEXT_PUBLIC_RELEASE_COMMIT, SHA);
  assert.equal(values.SHORTED_BUILD_BRANCH, "main");
});

test("a build with no release identity is local, and the tooling still reads local", () => {
  const values = identity({});
  assert.equal(values.NEXT_PUBLIC_RELEASE_COMMIT, "local");
  assert.equal(values.SHORTED_BUILD_COMMIT, "local");
  assert.equal(values.SHORTED_BUILD_BRANCH, "local");
  assert.equal(values.SHORTED_BUILD_ENVIRONMENT, "development");
  assert.equal(values.SHORTED_BUILD_VERSION, "pkg-1.0.0");
});

test("NODE_ENV names the environment when Vercel does not", () => {
  assert.equal(identity({ NODE_ENV: "production" }).SHORTED_BUILD_ENVIRONMENT, "production");
});

test("a malformed release SHA is refused rather than reported", () => {
  for (const sha of ["", "6F1D9392CADA83E7E910E36A7526E8821DB44D36", "6f1d939", `${SHA} `, "g".repeat(40)]) {
    const values = identity({ SHORTED_RELEASE_SHA: sha });
    assert.equal(values.NEXT_PUBLIC_RELEASE_COMMIT, "local", `sha ${JSON.stringify(sha)}`);
    assert.equal(values.SHORTED_BUILD_COMMIT, "local", `sha ${JSON.stringify(sha)}`);
  }
});

test("git's description is the version, and an empty one falls back to package.json", () => {
  assert.equal(identity({}, { gitVersion: "v0.2.2-748-g032f59db" }).SHORTED_BUILD_VERSION, "v0.2.2-748-g032f59db");
  assert.equal(identity({}, { gitVersion: "" }).SHORTED_BUILD_VERSION, "pkg-1.0.0");
});

test("every value is a non-empty string, so Next inlines every key", () => {
  for (const env of [{}, { SHORTED_RELEASE_SHA: "" }, { VERCEL_ENV: "", NODE_ENV: "" }]) {
    for (const [key, value] of Object.entries(identity(env))) {
      assert.equal(typeof value, "string", key);
      assert.notEqual(value, "", key);
    }
  }
});

test("the route reads only identity keys this module produces", () => {
  const route = readFileSync(
    new URL("../../web/src/app/api/version/route.ts", import.meta.url),
    "utf8",
  )
    // The route's comments quote `process.env.NAME`; only code counts.
    .replace(/^\s*\/\/.*$/gm, "");
  const reads = [...route.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(reads.length >= 5, "the route reads its identity from the environment");
  const produced = Object.keys(identity({}));
  for (const key of new Set(reads)) {
    assert.ok(produced.includes(key), `${key} is not produced by build-identity.mjs`);
  }
});

test("no runtime config: next.config.mjs and the version route do not use next/config", () => {
  const nextConfig = readFileSync(new URL("../../web/next.config.mjs", import.meta.url), "utf8");
  const route = readFileSync(new URL("../../web/src/app/api/version/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(nextConfig, /publicRuntimeConfig|serverRuntimeConfig|next\/config/);
  assert.doesNotMatch(route, /publicRuntimeConfig|next\/config/);
  assert.match(nextConfig, /env: buildIdentityValues/);
});
