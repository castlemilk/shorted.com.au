import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  DISCORD_ACTIVITY_PATH,
  discordActivityHeadScript,
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

// The browser half. Runs the script the root layout puts in <head> against a
// document at `href`, and returns each address it wrote.
function addressesWritten(href) {
  const url = new URL(href);
  const written = [];
  vm.runInNewContext(discordActivityHeadScript(), {
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
    vm.runInNewContext(discordActivityHeadScript(), {
      URLSearchParams,
      location: {
        pathname: "/",
        search: "?frame_id=f&instance_id=i",
        hash: "",
      },
    }),
  );
});

// The sweep of <head>, and the address rule beside it. The fake document is the
// smallest the script touches: a <head> whose childNodes is a live list (the sweep
// removes from it) and a <body> it must leave alone. A throwing document or
// history is set per case, as a page with no such API would have it.
const element = (nodeName, childNodes = []) => ({ nodeType: 1, nodeName, childNodes });
const text = (nodeValue) => ({ nodeType: 3, nodeValue });
const comment = (nodeValue) => ({ nodeType: 8, nodeValue });

const PROXY_HOST = "https://1561906774955659336.discordsays.com";

/**
 * Runs the head script at `href` with `head` as the children of document.head and
 * `body` as the children of document.body. Returns the addresses it wrote.
 */
function runHeadScript(
  href,
  {
    head = [],
    body = [],
    documentThrows = false,
    headIsNull = false,
    historyThrows = false,
    noHistory = false,
  } = {},
) {
  const url = new URL(href);
  const written = [];
  const headNode = {
    childNodes: head,
    removeChild(node) {
      const at = this.childNodes.indexOf(node);
      if (at < 0) throw new Error("NotFoundError: not a child of this node");
      this.childNodes.splice(at, 1);
      return node;
    },
  };
  const sandbox = {
    URLSearchParams,
    location: {
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    },
  };
  if (!noHistory) {
    sandbox.history = {
      state: null,
      replaceState(_state, _title, next) {
        if (historyThrows) throw new Error("SecurityError");
        written.push(next);
      },
    };
  }
  Object.defineProperty(sandbox, "document", {
    get() {
      if (documentThrows) throw new Error("no document");
      return { head: headIsNull ? null : headNode, body: { childNodes: body } };
    },
  });
  vm.runInNewContext(discordActivityHeadScript(), sandbox);
  return written;
}

test("on a discordsays host, the sweep removes head's whitespace-only text nodes and nothing else", () => {
  const meta = element("META");
  const proxyScript = element("SCRIPT");
  const layoutScript = element("SCRIPT");
  const title = element("TITLE", [text("\n")]);
  const note = comment(" proxy ");
  const plain = text("\n Shorted \n");
  const nbsp = text("\u00a0");
  const head = [
    meta,
    text("\n"),
    proxyScript,
    text("\n"),
    layoutScript,
    text(" \t\r\n\f"),
    plain,
    nbsp,
    note,
    title,
  ];
  runHeadScript(`${PROXY_HOST}/`, { head });
  // The proxy's newlines are whitespace text among the elements, and they go.
  // Text with a letter in it stays, and so does NBSP, which is not HTML whitespace.
  assert.deepEqual(head, [meta, proxyScript, layoutScript, plain, nbsp, note, title]);
  // Whitespace inside <title> is text inside an element, not a child of <head>.
  assert.deepEqual(title.childNodes, [text("\n")]);
});

test("on any other host, the sweep removes nothing", () => {
  for (const href of [
    "https://shorted.com.au/",
    "https://www.shorted.com.au/?frame_id=f&instance_id=i",
    "http://localhost:3020/",
    "https://discordsays.com/",
    "https://1561906774955659336.discordsays.com.example.net/",
    "https://evil-discordsays.com/",
    "https://1561906774955659336.discordsays.co/",
  ]) {
    const head = [text("\n"), element("SCRIPT"), text("\n")];
    runHeadScript(href, { head });
    assert.equal(head.length, 3, href);
  }
});

test("the sweep runs on the Activity's page as well as on the root, with or without launch parameters", () => {
  for (const href of [
    `${PROXY_HOST}/embed/discord?frame_id=f&instance_id=i`,
    `${PROXY_HOST}/embed/discord?code=CBA`,
    `${PROXY_HOST}/`,
    `${PROXY_HOST}/?frame_id=f`,
  ]) {
    const head = [text("\n"), element("SCRIPT"), text("\n")];
    const written = runHeadScript(href, { head });
    assert.equal(head.length, 1, href);
    assert.equal(head[0].nodeType, 1, href);
    // The address rule is unchanged: none of these is the root with both parameters.
    assert.deepEqual(written, [], href);
  }
});

test("the root launch gets both: the sweep, and the address moved to the Activity page", () => {
  const head = [text("\n"), element("SCRIPT"), text("\n")];
  const written = runHeadScript(`${PROXY_HOST}/?frame_id=f&instance_id=i`, { head });
  assert.equal(head.length, 1);
  assert.deepEqual(written, ["/embed/discord?frame_id=f&instance_id=i"]);
});

test("the sweep leaves <body> and everything outside <head> alone", () => {
  const body = [text("\n"), element("DIV")];
  const head = [text("\n"), element("SCRIPT")];
  runHeadScript(`${PROXY_HOST}/`, { head, body });
  assert.equal(head.length, 1);
  assert.equal(body.length, 2);
  assert.equal(body[0].nodeValue, "\n");
});

test("a throwing document does not stop the address fix", () => {
  const href = `${PROXY_HOST}/?frame_id=f&instance_id=i`;
  assert.deepEqual(runHeadScript(href, { documentThrows: true }), [
    "/embed/discord?frame_id=f&instance_id=i",
  ]);
  // A document with no <head> is the same case: the sweep reads it, and fails.
  assert.deepEqual(runHeadScript(href, { headIsNull: true }), [
    "/embed/discord?frame_id=f&instance_id=i",
  ]);
});

test("a throwing history does not stop the sweep, which runs first", () => {
  const head = [text("\n"), element("SCRIPT"), text("\n")];
  let written;
  assert.doesNotThrow(() => {
    written = runHeadScript(`${PROXY_HOST}/?frame_id=f&instance_id=i`, {
      head,
      historyThrows: true,
    });
  });
  assert.deepEqual(written, []);
  assert.equal(head.length, 1);
});

test("without a history API the sweep still runs", () => {
  const head = [text("\n"), element("SCRIPT")];
  runHeadScript(`${PROXY_HOST}/`, { head, noHistory: true });
  assert.equal(head.length, 1);
});

test("the head script stays ES5, so it runs in any webview the proxy hands it to", () => {
  assert.doesNotMatch(discordActivityHeadScript(), /=>|`|\b(?:let|const|class)\b/);
});

test("the root layout renders the script in <head>, before the body's RSC payload", () => {
  const layout = readFileSync(
    new URL("../../web/src/app/layout.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    layout,
    /import \{ discordActivityHeadScript \} from "~\/config\/discord-activity\.mjs";/,
  );
  const head = layout.slice(
    layout.indexOf("<head>"),
    layout.indexOf("</head>"),
  );
  // Prettier can break the element over lines, so allow any whitespace, and
  // bare boolean attributes (suppressHydrationWarning) before the content.
  const tag =
    /<script(?:\s+[A-Za-z]+)*\s+dangerouslySetInnerHTML=\{\{\s*__html:\s*discordActivityHeadScript\(\)\s*\}\}\s*\/>/;
  assert.match(head, tag);
  // The body pushes the RSC payload hydration reads, so the script must come first.
  assert.ok(layout.search(tag) < layout.indexOf("<body"));
});
