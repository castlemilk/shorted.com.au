// Mints the next-auth beta.22 session fixtures that session-cookie-compat.test.mjs
// reads. Production ran beta.22 until the bump to beta.32, so every signed-in
// browser holds a beta.22 cookie. Run this only when the cookie format is meant
// to change, against a beta.22 install of exactly the versions pinned below:
//
//   npm install --no-save --prefix <scratch> next-auth@5.0.0-beta.22 @auth/core@0.35.3 jose@5.9.3
//   node scripts/session-cookie-compat.mint.mjs <scratch>/node_modules
//
// Writes session-cookie-compat.fixtures.json beside this file. The secret below
// is a test value. It signs nothing outside that fixture file.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PINNED = { "next-auth": "5.0.0-beta.22", "@auth/core": "0.35.3", jose: "5.9.3" };
const PROD = "__Secure-next-auth.session-token";
const DEV = "next-auth.session-token";
const SECRET = "session-cookie-compat fixture secret, test only";
// 90 years, so the fixtures decode until 2116.
const MAX_AGE = 90 * 365 * 24 * 60 * 60;
const CLAIMS = {
  sub: "session-fixture-user",
  id: "session-fixture-user",
  name: "Session Fixture",
  email: "session-fixture@example.test",
  picture: null,
  emailVerified: true,
  isAdmin: false,
};
// Large enough that the token splits into several session cookies.
const FILLER_LENGTH = 9000;

const nodeModules = process.argv[2];
if (!nodeModules) {
  console.error("usage: node scripts/session-cookie-compat.mint.mjs <beta.22 node_modules>");
  process.exit(2);
}
const root = path.resolve(nodeModules);
for (const [pkg, version] of Object.entries(PINNED)) {
  const found = JSON.parse(readFileSync(path.join(root, pkg, "package.json"), "utf8")).version;
  if (found !== version) {
    console.error(`${pkg} is ${found}, expected ${version}`);
    process.exit(1);
  }
}
const jwt = await import(pathToFileURL(path.join(root, "next-auth/jwt.js")).href);
const cookieUtil = await import(pathToFileURL(path.join(root, "@auth/core/lib/utils/cookie.js")).href);

const prodToken = await jwt.encode({ token: CLAIMS, secret: SECRET, salt: PROD, maxAge: MAX_AGE });
const devToken = await jwt.encode({ token: CLAIMS, secret: SECRET, salt: DEV, maxAge: MAX_AGE });
const chunkedToken = await jwt.encode({
  token: { ...CLAIMS, filler: "x".repeat(FILLER_LENGTH) },
  secret: SECRET,
  salt: PROD,
  maxAge: MAX_AGE,
});

// beta.22 must read back its own tokens before anything is written.
const readBack = await jwt.decode({ token: chunkedToken, secret: SECRET, salt: PROD });
if (readBack.email !== CLAIMS.email || readBack.filler.length !== FILLER_LENGTH) {
  throw new Error("beta.22 did not round-trip its own token");
}
const silent = { debug() {}, error() {}, warn() {} };
const store = new cookieUtil.SessionStore({ name: PROD, options: { secure: true } }, {}, silent);
const chunks = store.chunk(chunkedToken, {});
if (chunks.length < 3 || chunks.some((c) => !c.value)) {
  throw new Error(`expected 3 or more non-empty chunks, got ${chunks.length}`);
}

const fixtures = {
  about:
    "Session cookies minted by next-auth 5.0.0-beta.22, production's version before the beta.32 bump. " +
    "session-cookie-compat.test.mjs reads them. Re-mint with session-cookie-compat.mint.mjs only when the cookie format is meant to change.",
  minter: PINNED,
  secret: SECRET,
  maxAgeSeconds: MAX_AGE,
  claims: CLAIMS,
  cookies: {
    prod: { name: PROD, token: prodToken },
    dev: { name: DEV, token: devToken },
  },
  chunked: {
    name: PROD,
    fillerLength: FILLER_LENGTH,
    chunks: chunks.map((c) => ({ name: c.name, value: c.value })),
  },
};
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-cookie-compat.fixtures.json");
writeFileSync(out, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`wrote ${out} with ${chunks.length} chunks`);
