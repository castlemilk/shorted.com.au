import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { get } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loopbackTlsProxy } from "./fixtures.mjs";
import "./local-network-only.cjs";

test("HTTPS fixture preserves the secure session cookie and forwarded origin on a real loopback exchange", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "shorted-tls-test-"));
  let proxy;
  const upstream = createServer((request, response) => {
    response.setHeader(
      "Set-Cookie",
      "__Secure-probe=synthetic; Secure; HttpOnly; SameSite=Lax; Path=/",
    );
    response.end(
      JSON.stringify({
        path: request.url,
        cookie: request.headers.cookie,
        host: request.headers.host,
        forwardedHost: request.headers["x-forwarded-host"],
        forwardedProto: request.headers["x-forwarded-proto"],
      }),
    );
  });
  const keyPath = path.join(temporary, "key.pem");
  const certPath = path.join(temporary, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      {
        timeout: 10_000,
        stdio: "ignore",
      },
    );
    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    proxy = loopbackTlsProxy({
      target: `http://127.0.0.1:${upstream.address().port}`,
      keyPath,
      certPath,
    });
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const host = `127.0.0.1:${proxy.address().port}`;
    const { body, cookies } = await new Promise((resolve, reject) => {
      get(
        `https://${host}/api/auth/session?synthetic=1`,
        {
          rejectUnauthorized: false,
          headers: { cookie: "__Secure-next-auth.session-token=synthetic" },
        },
        async (response) => {
          try {
            let body = "";
            for await (const chunk of response) body += chunk;
            resolve({
              body: JSON.parse(body),
              cookies: response.headers["set-cookie"],
            });
          } catch (error) {
            reject(error);
          }
        },
      ).on("error", reject);
    });
    assert.deepEqual(body, {
      path: "/api/auth/session?synthetic=1",
      cookie: "__Secure-next-auth.session-token=synthetic",
      host,
      forwardedHost: host,
      forwardedProto: "https",
    });
    assert.deepEqual(cookies, [
      "__Secure-probe=synthetic; Secure; HttpOnly; SameSite=Lax; Path=/",
    ]);
    assert.throws(() =>
      loopbackTlsProxy({ target: "http://example.test:80", keyPath, certPath }),
    );
  } finally {
    for (const server of [proxy, upstream]) {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
