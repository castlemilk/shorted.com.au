import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DISCORD_ACTIVITY_PATH,
  discordActivityRedirect,
} from "../../web/src/config/discord-activity.mjs";

// Like stock-tab-redirects.test.mjs: imports only the dependency-free module,
// and reads next.config.mjs as text, because the repo-hygiene job installs
// nothing under web/.
const nextConfigSource = readFileSync(
  new URL("../../web/next.config.mjs", import.meta.url),
  "utf8",
);

const redirect = discordActivityRedirect();

test("Discord's launch of `/` goes to the Activity page", () => {
  assert.equal(redirect.source, "/");
  assert.equal(redirect.destination, "/embed/discord");
  assert.equal(DISCORD_ACTIVITY_PATH, "/embed/discord");
});

test("only a request carrying Discord's launch parameters is redirected", () => {
  // Both are always present on a Discord launch (the SDK refuses to start
  // without them); requiring both keeps a stray ?frame_id= on the homepage
  // from being sent anywhere.
  assert.deepEqual(
    redirect.has.map((c) => [c.type, c.key]).sort(),
    [
      ["query", "frame_id"],
      ["query", "instance_id"],
    ],
  );
  assert.ok(redirect.has.every((c) => !("value" in c)), "any value matches");
});

test("the redirect is temporary and relative", () => {
  // Permanent would be cached by the client for a path that is the homepage
  // to everyone else. Relative keeps the browser on the discordsays.com proxy:
  // an absolute https://shorted.com.au/ destination would leave Discord's
  // frame, which its CSP blocks.
  assert.equal(redirect.permanent, false);
  assert.ok(redirect.destination.startsWith("/") && !redirect.destination.startsWith("//"));
});

test("next.config.mjs serves the redirect", () => {
  assert.match(
    nextConfigSource,
    /import \{ discordActivityRedirect \} from "\.\/src\/config\/discord-activity\.mjs";/,
  );
  const redirects = nextConfigSource.slice(
    nextConfigSource.indexOf("async redirects()"),
    nextConfigSource.indexOf("async rewrites()"),
  );
  assert.match(redirects, /discordActivityRedirect\(\),/);
});

test("the Activity page sits where third-party framing is allowed", () => {
  // Discord frames the Activity from discord.com, so the page must be under
  // /embed/, the only path whose CSP is `frame-ancestors *`.
  assert.ok(DISCORD_ACTIVITY_PATH.startsWith("/embed/"));
  const embedHeaders = nextConfigSource.slice(
    nextConfigSource.indexOf('source: "/embed/:path*"'),
    nextConfigSource.indexOf("async redirects()"),
  );
  assert.match(embedHeaders, /"frame-ancestors \*"/);
  assert.match(nextConfigSource, /source: "\/\(\(\?!embed\)\.\*\)"/);
});
