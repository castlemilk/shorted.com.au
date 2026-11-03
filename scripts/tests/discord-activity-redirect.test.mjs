import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  DISCORD_ACTIVITY_PATH,
  discordActivityRedirect,
  discordActivityUrlScript,
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

// The browser half. Runs the script the root layout puts in <head> against a
// document at `href`, and returns each address it wrote.
function addressesWritten(href) {
  const url = new URL(href);
  const written = [];
  vm.runInNewContext(discordActivityUrlScript(), {
    URLSearchParams,
    location: { pathname: url.pathname, search: url.search, hash: url.hash },
    history: {
      state: null,
      replaceState(_state, _title, next) {
        written.push(next);
      },
    },
  });
  return written;
}

test("the browser moves Discord's launch of `/` to the Activity page, keeping query and hash", () => {
  // The address a browser behind Discord's proxy holds: still `/`, with the query
  // the server redirected on.
  assert.deepEqual(
    addressesWritten(
      "https://1234.discordsays.com/?frame_id=f&instance_id=i&platform=desktop&custom_id=activity%3ABHP%3Acombined%3A6m#top",
    ),
    [
      "/embed/discord?frame_id=f&instance_id=i&platform=desktop&custom_id=activity%3ABHP%3Acombined%3A6m#top",
    ],
  );
});

test("the browser leaves every other address alone", () => {
  for (const href of [
    "https://1234.discordsays.com/",
    "https://shorted.com.au/?frame_id=f",
    "https://shorted.com.au/?instance_id=i",
    "https://shorted.com.au/?frame_id=&instance_id=i",
    "https://shorted.com.au/?frame_id=f&instance_id=",
    "https://shorted.com.au/top?frame_id=f&instance_id=i",
    "https://shorted.com.au/embed/discord?frame_id=f&instance_id=i",
  ]) {
    assert.deepEqual(addressesWritten(href), [], href);
  }
});

test("a repeated launch parameter counts as present, as it does for Next's redirect", () => {
  assert.deepEqual(
    addressesWritten(
      "https://shorted.com.au/?frame_id=&frame_id=&instance_id=i",
    ),
    ["/embed/discord?frame_id=&frame_id=&instance_id=i"],
  );
});

test("without a history API the script does nothing and does not throw", () => {
  assert.doesNotThrow(() =>
    vm.runInNewContext(discordActivityUrlScript(), {
      URLSearchParams,
      location: {
        pathname: "/",
        search: "?frame_id=f&instance_id=i",
        hash: "",
      },
    }),
  );
});

test("the root layout renders the script in <head>, before the body's RSC payload", () => {
  const layout = readFileSync(
    new URL("../../web/src/app/layout.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    layout,
    /import \{ discordActivityUrlScript \} from "~\/config\/discord-activity\.mjs";/,
  );
  const head = layout.slice(
    layout.indexOf("<head>"),
    layout.indexOf("</head>"),
  );
  // Prettier can break the element over lines, so allow any whitespace, and
  // bare boolean attributes (suppressHydrationWarning) before the content.
  const tag =
    /<script(?:\s+[A-Za-z]+)*\s+dangerouslySetInnerHTML=\{\{\s*__html:\s*discordActivityUrlScript\(\)\s*\}\}\s*\/>/;
  assert.match(head, tag);
  // The body pushes the RSC payload hydration reads, so the script must come first.
  assert.ok(layout.search(tag) < layout.indexOf("<body"));
});
