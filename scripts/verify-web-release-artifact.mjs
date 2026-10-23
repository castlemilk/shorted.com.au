import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertRuntime } from "./vercel-release.mjs";

// Inspect the existing build. Do not start a server, request data or rebuild it.
const [output = ".next", sha] = process.argv.slice(2);
assert.match(
  sha ?? "",
  /^[a-f0-9]{40}$/,
  "Expected the complete build source SHA",
);
const settings = JSON.parse(
  readFileSync(resolve(output, "required-server-files.json"), "utf8"),
);
assert.equal(
  settings.config.env.NEXT_PUBLIC_RELEASE_COMMIT,
  sha,
  "Build config must contain its exact source identity",
);

// Change the runtime environment before loading the actual compiled handler.
// A runtime lookup must not be able to make an old artifact claim a newer SHA.
process.env.NEXT_PUBLIC_RELEASE_COMMIT = "runtime-value-must-not-win";
const require = createRequire(import.meta.url);
const compiled = require(resolve(output, "server/app/api/version/route.js"));
const response = await compiled.routeModule.userland.GET();
assert.equal(response.status, 200);
assert.equal(response.headers.get("cache-control"), "private, no-store");
assertRuntime(await response.json(), sha);
console.log(
  `Compiled web version handler accepted ${sha}; runtime environment override rejected.`,
);
