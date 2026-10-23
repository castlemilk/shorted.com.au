import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Every key here is fake, and no request leaves the loopback stub. Production
// (generativelanguage.googleapis.com) is never reached from this file.
const script = fileURLToPath(new URL("../validate-gemini-key.sh", import.meta.url));
const FAKE_KEY = "FAKE-KEY-test-0001-not-real";
const DEAD_ROUTE = "http://127.0.0.1:9/v1beta";

const ACCESS_TOKEN_UNSUPPORTED = {
  error: {
    code: 401,
    message: "API keys are not supported by this API.",
    status: "UNAUTHENTICATED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCESS_TOKEN_TYPE_UNSUPPORTED",
        domain: "googleapis.com",
      },
    ],
  },
};

const API_KEY_INVALID = {
  error: {
    code: 400,
    message: "API key not valid. Please pass a valid API key.",
    status: "INVALID_ARGUMENT",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
  },
};

const TEXT_REPLY = {
  candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
};

// Runs the validator with a clean environment: nothing from the outer shell can
// retarget it, and the retry delay is zero so the tests stay fast.
// VALIDATE_TEST_BASH picks the interpreter, so the whole suite can run under macOS bash 3.2.
const TEST_BASH = process.env.VALIDATE_TEST_BASH || "bash";

function runValidator(args, { baseUrl = DEAD_ROUTE, env = {}, bash = TEST_BASH } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bash, [script, ...args], {
      env: {
        PATH: process.env.PATH,
        GEMINI_VALIDATE_BASE_URL: baseUrl,
        GEMINI_VALIDATE_RETRY_DELAY_SEC: "0",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// A stub Gemini: `responder(index, request)` returns { status, json } or { status, text }.
// Every request it receives is recorded, so a test can assert on headers and URL.
async function startStub(responder) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const index = requests.length;
      requests.push({ method: req.method, url: req.url, key: req.headers["x-goog-api-key"], body });
      const reply = responder(index, req);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.json !== undefined ? JSON.stringify(reply.json) : reply.text ?? "");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1beta`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("a key that generates text exits 0 with an ok line, and travels in the header not the URL", async () => {
  const stub = await startStub(() => ({ status: 200, json: TEXT_REPLY }));
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^gemini key [0-9a-f]{12}: ok\n$/);
    assert.equal(stub.requests.length, 1);
    const [request] = stub.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.key, FAKE_KEY, "the key must be sent in x-goog-api-key");
    assert.equal(request.url, "/v1beta/models/gemini-2.5-flash:generateContent");
    assert.ok(!request.url.includes(FAKE_KEY), "the key must never appear in the URL");
    assert.match(request.body, /Reply with the single word/);
  } finally {
    await stub.close();
  }
});

test("a 401 ACCESS_TOKEN_TYPE_UNSUPPORTED exits 2 and prints the reason, without retrying", async () => {
  const stub = await startStub(() => ({ status: 401, json: ACCESS_TOKEN_UNSUPPORTED }));
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /^gemini key [0-9a-f]{12}: rejected: ACCESS_TOKEN_TYPE_UNSUPPORTED\n$/);
    assert.equal(stub.requests.length, 1, "a definitive rejection is never retried");
  } finally {
    await stub.close();
  }
});

test("a 400 API_KEY_INVALID exits 2 and prints the reason", async () => {
  const stub = await startStub(() => ({ status: 400, json: API_KEY_INVALID }));
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /rejected: API_KEY_INVALID/);
  } finally {
    await stub.close();
  }
});

test("a 403 with a reason exits 2", async () => {
  const stub = await startStub(() => ({
    status: 403,
    json: { error: { code: 403, status: "PERMISSION_DENIED", message: "Forbidden", details: [{ reason: "API_KEY_SERVICE_BLOCKED" }] } },
  }));
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /rejected: API_KEY_SERVICE_BLOCKED/);
  } finally {
    await stub.close();
  }
});

test("two 503s then a text reply exits 0 after retrying", async () => {
  const stub = await startStub((index) =>
    index < 2 ? { status: 503, json: { error: { code: 503, status: "UNAVAILABLE", message: "busy" } } } : { status: 200, json: TEXT_REPLY },
  );
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /: ok\n$/);
    assert.equal(stub.requests.length, 3, "the first try plus two retries");
  } finally {
    await stub.close();
  }
});

test("a persistent 503 exits 3 after three attempts and never prints the key", async () => {
  const stub = await startStub(() => ({ status: 503, json: { error: { code: 503, status: "UNAVAILABLE" } } }));
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.match(result.stdout, /^gemini key [0-9a-f]{12}: unverified: HTTP 503\n$/);
    assert.equal(stub.requests.length, 3);
  } finally {
    await stub.close();
  }
});

test("a 429 is treated as unknown, not as a rejection", async () => {
  const stub = await startStub(() => ({ status: 429, json: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } } }));
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.equal(stub.requests.length, 3);
  } finally {
    await stub.close();
  }
});

test("connection refused exits 3 after retrying", async () => {
  // Bind a port, then release it, so nothing is listening there.
  const stub = await startStub(() => ({ status: 200, json: TEXT_REPLY }));
  const closedBase = stub.baseUrl;
  await stub.close();
  const result = await runValidator([FAKE_KEY], { baseUrl: closedBase });
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /: unverified: network error \(curl exit 7\)\n$/);
});

test("an empty key exits 0 as skipped and makes no request", async () => {
  const stub = await startStub(() => {
    throw new Error("an empty key must not reach the network");
  });
  try {
    const result = await runValidator([""], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "gemini key: skipped (empty)\n");
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("a trailing newline is stripped before the key is tested and sent, as ensure-secret stores it", async () => {
  const stub = await startStub(() => ({ status: 200, json: TEXT_REPLY }));
  try {
    const result = await runValidator([`${FAKE_KEY}\n`], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(stub.requests[0].key, FAKE_KEY);
  } finally {
    await stub.close();
  }
});

test("a key with an embedded line break is rejected without a request", async () => {
  const stub = await startStub(() => {
    throw new Error("a malformed key must not reach the network");
  });
  try {
    const result = await runValidator([`${FAKE_KEY}\nX-Injected: 1`], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /rejected: malformed key/);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("the key value never appears in stdout or stderr, even when Google's reason echoes it", async () => {
  const echoing = {
    error: {
      code: 400,
      status: "INVALID_ARGUMENT",
      message: `API key not valid: ${FAKE_KEY}`,
      details: [{ reason: `KEY_ECHO_${FAKE_KEY}` }],
    },
  };
  const stub = await startStub(() => ({ status: 400, json: echoing }));
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /rejected: KEY_ECHO_\[redacted\]/);
    assert.ok(!result.stdout.includes(FAKE_KEY), "stdout leaked the key");
    assert.ok(!result.stderr.includes(FAKE_KEY), "stderr leaked the key");
  } finally {
    await stub.close();
  }
});

test("the key value never appears in stdout or stderr on the success path or the unknown path", async () => {
  const ok = await startStub(() => ({ status: 200, json: TEXT_REPLY }));
  const unknown = await startStub(() => ({ status: 200, json: { promptFeedback: { blockReason: "SAFETY" } } }));
  try {
    for (const stub of [ok, unknown]) {
      const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
      assert.ok(!result.stdout.includes(FAKE_KEY), "stdout leaked the key");
      assert.ok(!result.stderr.includes(FAKE_KEY), "stderr leaked the key");
    }
  } finally {
    await ok.close();
    await unknown.close();
  }
});

test("a 200 reply with no text exits 3 and names the block reason", async () => {
  const stub = await startStub(() => ({ status: 200, json: { promptFeedback: { blockReason: "SAFETY" } } }));
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.match(result.stdout, /unverified: SAFETY\n$/);
  } finally {
    await stub.close();
  }
});

test("a 403 with a non-JSON body is unknown, not a rejection", async () => {
  const stub = await startStub(() => ({ status: 403, text: "<html>blocked by a proxy</html>" }));
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.match(result.stdout, /unverified: HTTP 403 with no reason/);
  } finally {
    await stub.close();
  }
});

test("the model comes from the second argument, then GEMINI_VALIDATE_MODEL, then the chat default", async () => {
  const stub = await startStub(() => ({ status: 200, json: TEXT_REPLY }));
  try {
    await runValidator([FAKE_KEY, "gemini-arg-model"], { baseUrl: stub.baseUrl, env: { GEMINI_VALIDATE_MODEL: "gemini-env-model" } });
    await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl, env: { GEMINI_VALIDATE_MODEL: "gemini-env-model" } });
    await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.deepEqual(
      stub.requests.map((request) => request.url.split("/").pop()),
      ["gemini-arg-model:generateContent", "gemini-env-model:generateContent", "gemini-2.5-flash:generateContent"],
    );
  } finally {
    await stub.close();
  }
});

test("a base URL that is not loopback is refused before anything is sent", async () => {
  for (const baseUrl of [
    "https://example.com/v1beta",
    "http://127.0.0.1:1@evil.example/v1beta",
    "http://evil.example:8080/127.0.0.1",
  ]) {
    const result = await runValidator([FAKE_KEY], { baseUrl });
    assert.equal(result.code, 1, `${baseUrl}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /loopback stub/);
  }
});

test("a missing argument is a usage error", async () => {
  const result = await runValidator([]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /usage: validate-gemini-key\.sh KEY/);
});

test("the script works under macOS's bash 3.2 as well as the runner's bash", async () => {
  const stub = await startStub((index) =>
    index === 0 ? { status: 503, json: { error: { code: 503 } } } : { status: 200, json: TEXT_REPLY },
  );
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl, bash: "/bin/bash" });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /: ok\n$/);
  } finally {
    await stub.close();
  }
});

// The Cuttlefish runners are not known to ship jq or python3, so the validator
// must run with only the tools it names. The PATH here holds symlinks to those
// tools and nothing else: no jq, no python3.
test("runs on a runner with no jq and no python3, using only the tools it names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "validate-gemini-path-"));
  const stub = await startStub((index) =>
    index === 0 ? { status: 401, json: ACCESS_TOKEN_UNSUPPORTED } : { status: 200, json: TEXT_REPLY },
  );
  try {
    for (const tool of ["curl", "awk", "cut", "tr", "sed", "grep", "head", "mktemp", "sleep", "rm", "sha256sum", "shasum"]) {
      const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (found) symlinkSync(found, join(dir, tool));
    }
    const result = await new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", [script, FAKE_KEY], {
        env: { PATH: dir, GEMINI_VALIDATE_BASE_URL: stub.baseUrl, GEMINI_VALIDATE_RETRY_DELAY_SEC: "0" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /rejected: ACCESS_TOKEN_TYPE_UNSUPPORTED/);
    assert.ok(!result.stdout.includes(FAKE_KEY));
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
