import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedReleaseHeaders, scopeReleaseBrowserHeaders } from "../../web/e2e/helpers/scoped-release-headers.mjs";
const app = "https://shorted-com-hfod9ow29-document-analyser.vercel.app";
const api = "https://api.shorted.com.au";
const headers = { "X-Shorted-Testing-Bypass": "inert-fixture-value", "User-Agent": "fixture", Authorization: "inert-existing-auth" };

test("release bypass reaches only configured owned HTTPS app/API origins", () => {
  for (const url of [app + "/signin", api + "/health"]) {
    assert.deepEqual(scopedReleaseHeaders(url, app, api, headers), headers);
  }
  assert.deepEqual(headers, { "X-Shorted-Testing-Bypass": "inert-fixture-value", "User-Agent": "fixture", Authorization: "inert-existing-auth" });
});

test("third parties, lookalike hosts and unconfigured owned origins never receive bypass", () => {
  for (const url of ["https://identitytoolkit.googleapis.com/v1/projects", "https://accounts.google.com/", "https://shorted.com.au.evil.example/", "https://shorted.com.au/", "https://shorted-com-other-document-analyser.vercel.app/", "http://api.shorted.com.au/", "https://api.shorted.com.au:444/", "invalid", "https://shorted.com.au@evil.example/"]) {
    assert.deepEqual(scopedReleaseHeaders(url, app, api, headers), { "User-Agent": "fixture", Authorization: "inert-existing-auth" });
  }
  assert.equal(scopedReleaseHeaders("https://evil.example/", "https://evil.example/", api, {"x-shorted-testing-bypass":"fixture"})["x-shorted-testing-bypass"], undefined);
});

test("browser routing preserves existing handlers while stripping inherited bypass", async () => {
  let handler;
  await scopeReleaseBrowserHeaders({ route: async (_pattern, value) => { handler = value; } }, app, api);
  let fallbackHeaders;
  await handler({request: () => ({url: () => "https://accounts.google.com/", headers: () => headers}), fallback: async ({headers: value}) => { fallbackHeaders = value; }});
  assert.deepEqual(fallbackHeaders, {"User-Agent":"fixture", Authorization:"inert-existing-auth"});
});
