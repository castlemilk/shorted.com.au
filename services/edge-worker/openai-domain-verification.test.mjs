import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

const challenge = "https://api.shorted.com.au/.well-known/openai-apps-challenge";
const proof = "swR1UbIz7NmrVtryxLnNUHIO-49mkLoNCzLoSPZX2yQ";

test("domain proof is exact text without an origin dependency", async () => {
  const response = await worker.fetch(new Request(challenge), {}, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), proof);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("domain proof supports HEAD and rejects mutations without forwarding", async () => {
  for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
    const response = await worker.fetch(new Request(challenge, { method }), {}, { waitUntil() {} });
    assert.equal(response.status, method === "HEAD" ? 200 : 405);
    assert.equal(await response.text(), "");
    if (method !== "HEAD") assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
});

test("other hosts and neighboring paths retain their existing origin routing", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(typeof input === "string" ? input : input.url);
    return new Response("origin response");
  };
  try {
    for (const url of [
      "https://shorted.com.au/.well-known/openai-apps-challenge",
      "https://api.shorted.com.au/.well-known/openai-apps-challenge/",
      "https://api.shorted.com.au/.well-known/other",
    ]) {
      const response = await worker.fetch(new Request(url), { SHORTS_API_ORIGIN: "https://origin.invalid" }, { waitUntil() {} });
      assert.equal(await response.text(), "origin response");
    }
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});
