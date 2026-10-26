import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// VALIDATE_TEST_BASH picks the interpreter, so the whole suite can run under macOS bash 3.2.
const TEST_BASH = process.env.VALIDATE_TEST_BASH || "bash";
const PS_AVAILABLE = spawnSync("ps", ["-p", String(process.pid)]).status === 0;

// Starts the validator with a clean environment: nothing from the outer shell can
// retarget it, and the retry delay is zero so the tests stay fast. The child is
// returned at once so a test can look at the process while it runs. `input` is
// written to stdin and stdin is closed.
function startValidator(args, { baseUrl = DEAD_ROUTE, env = {}, bash = TEST_BASH, flags = [], input = "" } = {}) {
  const child = spawn(bash, [...flags, script, ...args], {
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
  child.stdin.on("error", () => {}); // the script may exit before it reads stdin
  child.stdin.end(input);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

function runValidator(args, options) {
  return startValidator(args, options).done;
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

// The files directly inside dir whose text contains needle. A key found on disk is a leak.
function filesContaining(dir, needle) {
  return readdirSync(dir).filter((name) => {
    try {
      return readFileSync(join(dir, name), "utf8").includes(needle);
    } catch {
      return false;
    }
  });
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

// Exit 4 is not a pass. The deploy wrapper writes only on exit 0, so an empty key
// must never report the success code.
test("an empty key exits 4 as skipped and makes no request", async () => {
  const stub = await startStub(() => {
    throw new Error("an empty key must not reach the network");
  });
  try {
    const result = await runValidator([""], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 4, result.stdout + result.stderr);
    assert.equal(result.stdout, "gemini key: skipped (empty)\n");
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

// ensure-secret.sh strips trailing CR/LF before it decides a value is empty, so a
// value of only CR/LF is empty to it too. It must not reach a write.
test("a value that is only CR or LF is empty: exit 4 and no request, from argv or stdin", async () => {
  const stub = await startStub(() => {
    throw new Error("an empty key must not reach the network");
  });
  try {
    for (const value of ["\r", "\n", "\r\n", "\n\r\n"]) {
      const fromArgv = await runValidator([value], { baseUrl: stub.baseUrl });
      assert.equal(fromArgv.code, 4, `argv ${JSON.stringify(value)}: ${fromArgv.stdout}${fromArgv.stderr}`);
      assert.equal(fromArgv.stdout, "gemini key: skipped (empty)\n");
      const fromStdin = await runValidator(["-"], { baseUrl: stub.baseUrl, input: value });
      assert.equal(fromStdin.code, 4, `stdin ${JSON.stringify(value)}: ${fromStdin.stdout}${fromStdin.stderr}`);
    }
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test("the key on stdin is tested and sent; empty stdin exits 4", async () => {
  const stub = await startStub(() => ({ status: 200, json: TEXT_REPLY }));
  try {
    const result = await runValidator(["-"], { baseUrl: stub.baseUrl, input: `${FAKE_KEY}\n` });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^gemini key [0-9a-f]{12}: ok\n$/);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].key, FAKE_KEY, "the key from stdin must be sent in x-goog-api-key");

    const empty = await runValidator(["-"], { baseUrl: stub.baseUrl, input: "" });
    assert.equal(empty.code, 4, empty.stdout + empty.stderr);
    assert.equal(stub.requests.length, 1, "an empty stdin makes no request");
  } finally {
    await stub.close();
  }
});

// Starts a run whose stub holds its reply until the test has read the validator's
// argument list, so the list is read while the key would still be in it.
async function argvWhileSending(args, input) {
  let arrive;
  const arrived = new Promise((resolve) => (arrive = resolve));
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let key;
  const server = createServer((req, res) => {
    key = req.headers["x-goog-api-key"];
    req.resume();
    req.on("end", () => {
      arrive();
      held.then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(TEXT_REPLY));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { child, done } = startValidator(args, { baseUrl: `http://127.0.0.1:${server.address().port}/v1beta`, input });
  let argv = "";
  try {
    await arrived;
    argv = spawnSync("ps", ["-o", "args=", "-p", String(child.pid)], { encoding: "utf8" }).stdout;
  } finally {
    release();
  }
  const result = await done;
  server.close();
  return { argv, key, result };
}

test("the key is never in the validator's argument list when it comes on stdin", { skip: !PS_AVAILABLE, timeout: 30000 }, async () => {
  const positional = await argvWhileSending([FAKE_KEY], "");
  // Control: if ps cannot show a key passed as an argument, the check below proves nothing.
  assert.ok(positional.argv.includes(FAKE_KEY), `control failed: ps did not show the positional key:\n${positional.argv}`);
  assert.equal(positional.result.code, 0, positional.result.stdout + positional.result.stderr);

  const piped = await argvWhileSending(["-"], `${FAKE_KEY}\n`);
  assert.equal(piped.key, FAKE_KEY, "the key from stdin must be the one that was tested");
  assert.ok(!piped.argv.includes(FAKE_KEY), `the key was in the validator's argument list:\n${piped.argv}`);
  assert.equal(piped.result.code, 0, piped.result.stdout + piped.result.stderr);
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

// HTTP drops a header's leading and trailing spaces, so a padded key would be checked
// trimmed and answer 200, while ensure-secret.sh stores the padded value. No Gemini key
// has whitespace, so a padded key is refused before any request, on argv and on stdin.
test("a key with whitespace anywhere is rejected without a request, from argv or stdin", async () => {
  const stub = await startStub(() => {
    throw new Error("a padded key must not reach the network");
  });
  try {
    const padded = [`  ${FAKE_KEY}`, `${FAKE_KEY}   `, `${FAKE_KEY}\t`, `\t${FAKE_KEY}`, `FAKE-inner ${FAKE_KEY}`, "   "];
    for (const key of padded) {
      const fromArgv = await runValidator([key], { baseUrl: stub.baseUrl });
      assert.equal(fromArgv.code, 2, `argv ${JSON.stringify(key)}: ${fromArgv.stdout}${fromArgv.stderr}`);
      assert.match(fromArgv.stdout, /^gemini key [0-9a-f]{12}: rejected: malformed key \(whitespace\)\n$/);
      const fromStdin = await runValidator(["-"], { baseUrl: stub.baseUrl, input: key });
      assert.equal(fromStdin.code, 2, `stdin ${JSON.stringify(key)}: ${fromStdin.stdout}${fromStdin.stderr}`);
      assert.ok(!fromStdin.stdout.includes(FAKE_KEY), "the key must not be printed");
    }
    // The strip runs first, so a key that only has spaces left once CR/LF are gone is still refused.
    const afterStrip = await runValidator(["-"], { baseUrl: stub.baseUrl, input: `${FAKE_KEY} \n` });
    assert.equal(afterStrip.code, 2, afterStrip.stdout + afterStrip.stderr);
    assert.match(afterStrip.stdout, /rejected: malformed key \(whitespace\)/);
    assert.equal(stub.requests.length, 0, "a padded key must never reach the network");
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

// A 200 reply's finish reason is printed as the cause, so it is scrubbed like a refusal's reason.
test("the key is scrubbed from a 200 reply's finish reason too", async () => {
  const echoing = { candidates: [{ finishReason: `OTHER_${FAKE_KEY}` }] };
  const stub = await startStub(() => ({ status: 200, json: echoing }));
  try {
    const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl });
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.match(result.stdout, /unverified: OTHER_\[redacted\]\n$/);
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

// Each config is a hostile ~/.curlrc. A plain curl reads it and leaks the key, which
// the control run proves, so the clean validator run below means something.
const HOSTILE_CURLRC = [
  ["trace to stdout", 'trace-ascii = "-"\n'],
  ["trace to a file", 'trace-ascii = "TRACE_FILE"\n'],
  ["verbose to stdout", 'verbose\nstderr = "-"\n'],
];

function curlHome(config) {
  const dir = mkdtempSync(join(tmpdir(), "validate-gemini-curlrc-"));
  writeFileSync(join(dir, ".curlrc"), config.replace("TRACE_FILE", join(dir, "trace.log")));
  return dir;
}

test("a hostile curl config cannot make the validator print or write the key", async () => {
  const stub = await startStub(() => ({ status: 200, json: TEXT_REPLY }));
  try {
    for (const [label, config] of HOSTILE_CURLRC) {
      const control = curlHome(config);
      try {
        const plain = spawnSync(
          "curl",
          ["-sS", "-o", "/dev/null", "--max-time", "10", "-H", `x-goog-api-key: ${FAKE_KEY}`, `${stub.baseUrl}/models/gemini-2.5-flash:generateContent`],
          { encoding: "utf8", env: { PATH: process.env.PATH, CURL_HOME: control, HOME: control } },
        );
        assert.ok(
          plain.stdout.includes(FAKE_KEY) || filesContaining(control, FAKE_KEY).length > 0,
          `${label}: control failed, a plain curl did not leak the key`,
        );
      } finally {
        rmSync(control, { recursive: true, force: true });
      }

      const home = curlHome(config);
      try {
        const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl, env: { CURL_HOME: home, HOME: home } });
        assert.equal(result.code, 0, `${label}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /^gemini key [0-9a-f]{12}: ok\n$/, label);
        assert.ok(!result.stdout.includes(FAKE_KEY), `${label}: stdout leaked the key`);
        assert.ok(!result.stderr.includes(FAKE_KEY), `${label}: stderr leaked the key`);
        assert.deepEqual(filesContaining(home, FAKE_KEY), [], `${label}: the key reached a file`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  } finally {
    await stub.close();
  }
});

// bash -x, SHELLOPTS=xtrace and a BASH_ENV that sets -x all trace the script's own
// commands to stderr, where the workflow step log keeps them.
test("the key stays out of stderr under bash -x, SHELLOPTS=xtrace and a BASH_ENV that sets -x", async () => {
  // Control: this bash does print an assignment's value under -x, so a clean run below means something.
  const probe = spawnSync(TEST_BASH, ["-x", "-c", 'KEY="$1"', "probe", FAKE_KEY], { encoding: "utf8" });
  assert.ok(probe.stderr.includes(FAKE_KEY), "control failed: bash -x did not trace the assignment");

  const stub = await startStub(() => ({ status: 200, json: TEXT_REPLY }));
  const dir = mkdtempSync(join(tmpdir(), "validate-gemini-xtrace-"));
  const bashEnv = join(dir, "bash-env.sh");
  writeFileSync(bashEnv, "set -x\n");
  try {
    for (const { label, flags = [], env = {} } of [
      { label: "bash -x", flags: ["-x"] },
      { label: "SHELLOPTS=xtrace", env: { SHELLOPTS: "xtrace" } },
      { label: "BASH_ENV", env: { BASH_ENV: bashEnv } },
    ]) {
      const result = await runValidator([FAKE_KEY], { baseUrl: stub.baseUrl, flags, env });
      assert.equal(result.code, 0, `${label}: ${result.stdout}${result.stderr}`);
      assert.ok(!result.stderr.includes(FAKE_KEY), `${label}: the xtrace on stderr leaked the key`);
      assert.ok(!result.stdout.includes(FAKE_KEY), `${label}: stdout leaked the key`);
    }
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The status is the only text taken from curl. Anything else curl writes to stdout is
// never printed, even when it carries the key.
test("curl output that is not a status code is never printed, key or not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "validate-gemini-shim-"));
  try {
    writeFileSync(
      join(dir, "curl"),
      ["#!/usr/bin/env bash", "cat >/dev/null", `printf 'trace: x-goog-api-key: %s\\n' '${FAKE_KEY}'`, ""].join("\n"),
      { mode: 0o755 },
    );
    const result = await runValidator([FAKE_KEY], { env: { PATH: `${dir}:${process.env.PATH}` } });
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.match(result.stdout, /^gemini key [0-9a-f]{12}: unverified: unexpected curl output\n$/);
    assert.ok(!result.stdout.includes(FAKE_KEY), "stdout leaked the key");
    assert.ok(!result.stderr.includes(FAKE_KEY), "stderr leaked the key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
  assert.match(result.stderr, /usage: validate-gemini-key\.sh \[-\|KEY\]/);
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

// A curl shim on PATH records what the validator hands curl. The key must arrive
// only in the header text on stdin, never as a curl argument, where ps, /proc and
// execve audit logs can read it. The validator's own ps test sees only bash.
test("curl receives the key only in the header on stdin, never as an argument", async () => {
  const dir = mkdtempSync(join(tmpdir(), "validate-gemini-curlshim-"));
  const realCurl = spawnSync("/bin/sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
  const stub = await startStub(() => ({ status: 200, json: TEXT_REPLY }));
  try {
    writeFileSync(
      join(dir, "curl"),
      `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/argv"\ntee "${dir}/stdin" | "${realCurl}" "$@"\n`,
      { mode: 0o755 },
    );
    const result = await runValidator([FAKE_KEY], {
      baseUrl: stub.baseUrl,
      env: { PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const argv = readFileSync(join(dir, "argv"), "utf8");
    assert.ok(!argv.includes(FAKE_KEY), "the key must not be a curl argument");
    assert.match(readFileSync(join(dir, "stdin"), "utf8"), new RegExp(`^x-goog-api-key: ${FAKE_KEY}$`, "m"));
    assert.equal(stub.requests[0].key, FAKE_KEY);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The loopback test stub is plain http, which curl would hand to an http_proxy in
// cleartext. The validator passes --noproxy for that URL, so a proxy on the runner
// never sees the key. A dead proxy proves it: through the proxy the call would fail.
test("a runner http_proxy is bypassed for the loopback stub", async () => {
  const stub = await startStub(() => ({ status: 200, json: TEXT_REPLY }));
  try {
    const result = await runValidator([FAKE_KEY], {
      baseUrl: stub.baseUrl,
      env: { http_proxy: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", all_proxy: "http://127.0.0.1:9" },
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});
