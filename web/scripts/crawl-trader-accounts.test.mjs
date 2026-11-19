import assert from "node:assert/strict";
import test from "node:test";
import {
  createReader,
  extractPage,
  socialUrl,
} from "./crawl-trader-accounts.mjs";

const original = "https://issuer.example";
const readWith = (sites, fetcher) =>
  createReader(sites, fetcher, async () => {});

test("recognises canonical account links without treating sharing, login or posts as profiles", () => {
  assert.equal(
    socialUrl("http://twitter.com/GeoffWilsonWAM?mx=2"),
    "https://x.com/geoffwilsonwam",
  );
  assert.equal(
    socialUrl("//www.linkedin.com/company/13728?trk=footer", original),
    "https://www.linkedin.com/company/13728/",
  );
  assert.equal(
    socialUrl("https://www.youtube.com/@Bg2Pod/videos"),
    "https://www.youtube.com/@bg2pod",
  );
  for (const url of [
    "https://x.com/i/flow/login",
    "https://x.com/share",
    "https://www.facebook.com/share.php?u=x",
    "https://www.linkedin.com/posts/post",
    "https://instagram.com/p/abc",
    "https://example.com/@Bg2Pod",
    "https://bad@example.com/",
  ])
    assert.equal(socialUrl(url), undefined);
});

test("collects deduplicated outgoing accounts while keeping a captioned photo as a candidate", () => {
  const html =
    '<meta property="og:image" content="/head.jpg"><meta property="og:image:alt" content="Geoff Wilson AO"><a href="https://x.com/WilsonAssetMgmt">Firm</a><a href="https://twitter.com/WilsonAssetMgmt">Firm again</a><img alt="Company logo" src="/logo.png">';
  const page = extractPage(html, original);
  assert.deepEqual(page.links, ["https://x.com/wilsonassetmgmt"]);
  assert.deepEqual(page.photos, [
    { label: "Geoff Wilson AO", url: original + "/head.jpg" },
  ]);
});

test("honours robots at redirected destinations and never requests an unlisted host", async () => {
  const second = "https://social.example",
    calls = [];
  const read = readWith([original, second], async (url) => {
    const u = new URL(url);
    calls.push(u.href);
    if (u.pathname === "/robots.txt")
      return new Response(
        u.origin === original ? "" : "User-agent: *\nDisallow: /private*",
      );
    return new Response(null, {
      status: 302,
      headers: {
        location:
          u.pathname === "/outside"
            ? "https://unknown.example/photo"
            : second + "/private-profile",
      },
    });
  });
  assert.equal((await read(original + "/redirect")).status, "restricted");
  assert.equal((await read(original + "/outside")).status, "unavailable");
  assert(
    !calls.some(
      (c) => c.includes("/private-profile") || c.includes("unknown.example"),
    ),
  );
  assert.equal(calls.filter((c) => c === original + "/robots.txt").length, 1);
});

test("separates missing, signed-out and document responses from reachable public pages", async () => {
  const read = readWith([original], async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/robots.txt") return new Response(null, { status: 404 });
    if (pathname === "/missing") return new Response(null, { status: 410 });
    if (pathname === "/restricted") return new Response(null, { status: 429 });
    if (pathname === "/moved")
      return new Response(null, {
        status: 302,
        headers: { location: "/login" },
      });
    if (pathname === "/pdf")
      return new Response(null, {
        headers: { "Content-Type": "application/pdf" },
      });
    const title =
      pathname === "/wall" ? "Sign in to continue" : "Public company";
    return new Response("<title>" + title + "</title>", {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  });
  for (const [route, status] of [
    ["missing", "missing"],
    ["restricted", "restricted"],
    ["moved", "restricted"],
    ["wall", "restricted"],
    ["pdf", "document"],
    ["public", "responded"],
  ]) {
    assert.equal((await read(original + "/" + route)).status, status, route);
  }
});

test("keeps unreachable robots and oversized responses out of the evidence", async () => {
  let visits = 0;
  const denied = readWith([original], async () => {
    visits++;
    return new Response(null, { status: 503 });
  });
  assert.equal((await denied(original + "/person")).status, "unavailable");
  assert.equal(visits, 1);
  const large = readWith([original], async (url) =>
    new URL(url).pathname === "/robots.txt"
      ? new Response(null, { status: 404 })
      : new Response("x".repeat(2_000_001), {
          headers: { "Content-Type": "text/html" },
        }),
  );
  assert.equal((await large(original + "/huge")).status, "unavailable");
});
