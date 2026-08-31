import test from "node:test";
import assert from "node:assert/strict";

import { filterRequestHeaders } from "./worker.js";

// DOES THE ORIGIN LEARN WHO IS CALLING?
//
// The worker strips Cloudflare's headers before forwarding to the origin, which
// is right for hop-by-hop metadata and was wrong for the one header that
// identifies the caller. With cf-connecting-ip and x-forwarded-for both
// deleted, the only address the origin could see was Cloudflare's own.
//
// Measured on 2026-08-30, the first day app-layer rate limiting ran: every
// identifier in api_usage_monthly was a Cloudflare address (104.22.127.86,
// 172.69.60.206, 162.158.39.167 ...), so every caller behind a colo shared one
// bucket — 30 requests a minute for the whole colo at the anonymous tier. The
// Go side was fixed first and made no difference, because the header it needs
// was being deleted here. This is the other half.

const CLIENT = "203.0.113.9";

function inbound(extra = {}) {
  return new Headers({
    "cf-connecting-ip": CLIENT,
    "cf-ray": "abc123-SYD",
    "cf-ipcountry": "AU",
    "user-agent": "Mozilla/5.0",
    accept: "application/json",
    ...extra,
  });
}

test("the origin is told who the caller is", () => {
  const out = filterRequestHeaders(inbound());
  assert.equal(
    out.get("cf-connecting-ip"),
    CLIENT,
    "the origin cannot meter a caller it cannot see",
  );
  assert.equal(out.get("x-forwarded-for"), CLIENT);
});

// The value forwarded is CLOUDFLARE'S, never the client's own claim. An inbound
// x-forwarded-for is attacker-controlled, so it must not survive: otherwise a
// caller picks their own rate-limit bucket by sending a header.
test("a client's own forwarded-for claim is discarded, not merged", () => {
  const out = filterRequestHeaders(
    inbound({ "x-forwarded-for": "1.1.1.1, 8.8.8.8" }),
  );
  assert.equal(
    out.get("x-forwarded-for"),
    CLIENT,
    "a client-supplied hop survived and could choose its own bucket",
  );
});

// Same for a forged cf-connecting-ip: Cloudflare overwrites this header on the
// inbound request, so what we read is authoritative — but the test pins that we
// forward exactly one value and it is that one.
test("only a single authoritative address is forwarded", () => {
  const out = filterRequestHeaders(inbound());
  assert.ok(
    !out.get("x-forwarded-for").includes(","),
    `forwarded a chain (${out.get("x-forwarded-for")}) where the origin expects one address`,
  );
});

// The hygiene the function already provided must survive the change.
test("hop-by-hop and Cloudflare metadata are still stripped", () => {
  const out = filterRequestHeaders(inbound({ host: "api.shorted.com.au" }));
  for (const h of ["cf-ray", "cf-ipcountry", "cf-visitor", "cf-worker", "host"]) {
    assert.equal(out.get(h), null, `${h} was forwarded to the origin`);
  }
});

test("ordinary request headers are passed through untouched", () => {
  const out = filterRequestHeaders(inbound());
  assert.equal(out.get("user-agent"), "Mozilla/5.0");
  assert.equal(out.get("accept"), "application/json");
});

// Off-platform (local dev, tests) there is no cf-connecting-ip. Inventing one
// would be worse than omitting it: the Go side falls back to the peer address,
// which is correct there.
test("without a Cloudflare address nothing is fabricated", () => {
  const out = filterRequestHeaders(
    new Headers({ "user-agent": "curl/8", "x-forwarded-for": "1.1.1.1" }),
  );
  assert.equal(out.get("cf-connecting-ip"), null);
  assert.equal(
    out.get("x-forwarded-for"),
    null,
    "an unverifiable client claim was forwarded as if it were trustworthy",
  );
});

// IPv6 clients are a large share of Australian residential traffic and are easy
// to lose to a naive split on ':'.
test("IPv6 callers are forwarded intact", () => {
  const v6 = "2001:8003:4bd6:3300:10ec:fe80:f904:9214";
  const out = filterRequestHeaders(new Headers({ "cf-connecting-ip": v6 }));
  assert.equal(out.get("cf-connecting-ip"), v6);
  assert.equal(out.get("x-forwarded-for"), v6);
});
