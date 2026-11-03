// Session cookies written by next-auth 5.0.0-beta.22 must still be read by the
// installed next-auth. Production ran beta.22 until the bump to beta.32, so every
// signed-in browser holds a beta.22 cookie, and a format break would sign them out.
//
// The tokens are real beta.22 output, committed as fixtures. A test that minted
// and read with the same installed version would prove nothing about cookies
// already in browsers. session-cookie-compat.mint.mjs regenerates the fixtures,
// and only when the cookie format is meant to change. They decode until 2116.
//
// Run: npm run test:session-cookies (in web/). CI: storybook-tests.yml, interaction job.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decode, encode, getToken } from "next-auth/jwt";

const { secret, claims, cookies, chunked } = JSON.parse(
  readFileSync(new URL("./session-cookie-compat.fixtures.json", import.meta.url), "utf8"),
);

// Compares the claims the fixture was minted with, not just that decoding passed.
function assertClaims(payload, expected) {
  assert.ok(payload, "no session payload");
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(payload[key], value, `claim ${key}`);
  }
}

// A refused token and a null result both mean "not a session".
async function decodeOrNull(token, salt, key = secret) {
  try {
    return await decode({ token, secret: key, salt });
  } catch {
    return null;
  }
}

const headerOf = (jwe) => JSON.parse(Buffer.from(jwe.split(".")[0], "base64url").toString("utf8"));

for (const [label, cookie] of Object.entries(cookies)) {
  test(`a beta.22 ${label} session cookie decodes to its claims`, async () => {
    assertClaims(await decode({ token: cookie.token, secret, salt: cookie.name }), claims);
  });
}

test("getToken reads a beta.22 cookie and a beta.22 Bearer token", async () => {
  const { name, token } = cookies.prod;
  const fromCookie = await getToken({
    req: new Request("https://shorted.com.au/admin", { headers: { cookie: `${name}=${token}` } }),
    secret,
    cookieName: name,
  });
  assertClaims(fromCookie, claims);
  const fromBearer = await getToken({
    req: new Request("https://shorted.com.au/chat.v1.ChatService/SendMessageStream", {
      headers: { authorization: `Bearer ${token}` },
    }),
    secret,
    cookieName: name,
  });
  assertClaims(fromBearer, claims);
});

test("a beta.22 session split across cookies is reassembled in either order", async () => {
  assert.deepEqual(
    chunked.chunks.map((c) => c.name),
    chunked.chunks.map((_, i) => `${chunked.name}.${i}`),
    "chunk names",
  );
  for (const ordered of [chunked.chunks, [...chunked.chunks].reverse()]) {
    const cookie = ["theme=dark", ...ordered.map((c) => `${c.name}=${c.value}`), "_ga=GA1.2.3"].join("; ");
    const payload = await getToken({
      req: new Request("https://shorted.com.au/chat", { headers: { cookie } }),
      secret,
      cookieName: chunked.name,
    });
    assertClaims(payload, claims);
    assert.equal(payload?.filler?.length, chunked.fillerLength, "filler length");
  }
});

test("a beta.22 token is refused under another salt, another secret, or with one bit changed", async () => {
  const { name, token } = cookies.prod;
  assert.equal(await decodeOrNull(token, cookies.dev.name), null, "another salt");
  assert.equal(await decodeOrNull(token, name, `${secret} (other)`), null, "another secret");
  const parts = token.split(".");
  const ciphertext = Buffer.from(parts[3], "base64url");
  ciphertext[0] ^= 0x01;
  parts[3] = ciphertext.toString("base64url");
  assert.equal(await decodeOrNull(parts.join("."), name), null, "one bit changed");
});

test("a token written now keeps the beta.22 header and derived key", async () => {
  const fresh = await encode({ token: claims, secret, salt: cookies.prod.name, maxAge: 3600 });
  const header = headerOf(fresh);
  assert.deepEqual(Object.keys(header).sort(), ["alg", "enc", "kid"]);
  assert.equal(header.alg, "dir");
  assert.equal(header.enc, "A256CBC-HS512");
  assert.equal(header.kid, headerOf(cookies.prod.token).kid, "kid (thumbprint of the derived key)");
  assertClaims(await decode({ token: fresh, secret, salt: cookies.prod.name }), claims);
});
