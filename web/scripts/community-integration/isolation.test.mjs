import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import "./local-network-only.cjs";

test("outbound isolation rejects positional, object and normalized socket calls before connection", () => {
  for (const connect of [
    () => new net.Socket().connect(443, "example.test"),
    () => new net.Socket().connect({ host: "example.test", port: 443 }),
    () => net.createConnection({ host: "example.test", port: 443 }),
  ]) {
    assert.throws(connect, /blocked non-loopback connection/);
  }
});

test("outbound isolation permits an actual loopback service exchange", async () => {
  const server = net.createServer((socket) =>
    socket.end("synthetic-local-reply"),
  );
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const client = net.createConnection({
      host: "127.0.0.1",
      port: server.address().port,
    });
    let response = "";
    for await (const chunk of client) response += chunk;
    assert.equal(response, "synthetic-local-reply");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
