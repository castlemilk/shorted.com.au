import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  chromium,
  expect,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import { getApps, deleteApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { createPostgresCommunityStore } from "../../src/@/lib/community/postgres-community";
import { firestoreCommunityStore } from "../../src/@/lib/community/firestore-community";
import { getAdminApp } from "../../src/@/lib/firebase-admin";
import type { CommunityStore } from "../../src/@/lib/community/community-store";
import type {
  CommunityComment,
  CommunityPulseItem,
  CommunityThread,
} from "../../src/@/types/community";
import { loopbackTlsProxy } from "./fixtures.mjs";
import { syntheticSessionCookie } from "./production-session.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(directory, "../..");
const driver = process.env.COMMUNITY_STORE_DRIVER;
assert(
  driver === "postgres" || driver === "firestore",
  "Select an explicit test driver",
);
const databaseUrl = new URL(process.env.COMMUNITY_TEST_DATABASE_URL ?? "");
assert.equal(databaseUrl.hostname, "127.0.0.1");
assert.equal(databaseUrl.pathname, "/shorted_community_test");
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? "", /^127\.0\.0\.1:\d+$/);
assert.equal(
  process.env.AUTH_FIREBASE_PROJECT_ID,
  "demo-shorted-community-test",
);
assert.equal(process.env.NODE_ENV, "production");
assert.equal(process.env.ALLOW_E2E_AUTH, "false");
const redisUrl = new URL(process.env.REDIS_URL ?? "");
assert.equal(redisUrl.protocol, "redis:");
assert.equal(redisUrl.hostname, "127.0.0.1");
assert(redisUrl.password);
const stockOrigin = new URL(process.env.COMMUNITY_TEST_STOCK_ORIGIN ?? "");
assert.equal(stockOrigin.protocol, "http:");
assert.equal(stockOrigin.hostname, "127.0.0.1");
assert(
  !process.env.VERCEL_ENV,
  "Integration must not run against a deployed app",
);
const output = process.env.COMMUNITY_TEST_RESULTS!;
const pool = new Pool({
  connectionString: databaseUrl.toString(),
  connectionTimeoutMillis: 2000,
});
const store: CommunityStore =
  driver === "postgres"
    ? createPostgresCommunityStore(() => pool)
    : firestoreCommunityStore;
const author = {
  userId: "private-fixture-user",
  displayName: "private-name@example.test",
  handle: "private-fixture-handle",
  avatarUrl: "https://avatar.example.test/private-fixture",
  trustScore: 999,
};
const report: {
  driver: string;
  runtimeMode: string;
  cases: string[];
  status: string;
  error?: string;
  blockedBrowserHosts: string[];
} = {
  driver,
  runtimeMode: "production",
  cases: [],
  status: "failed",
  blockedBrowserHosts: [],
};
let app: ChildProcess | undefined;
let proxy: ReturnType<typeof loopbackTlsProxy> | undefined;
let browser: Browser | undefined;
let appLog: ReturnType<typeof createWriteStream> | undefined;
const contexts: Array<{ context: BrowserContext; name: string }> = [];

async function check(name: string, action: () => Promise<void>) {
  await action();
  report.cases.push(name);
  console.log(`PASS ${driver}: ${name}`);
}

type Target = "thread" | "comment" | "pulse" | "reply";
function reference(target: Target, id: string, parentId?: string) {
  const root = getFirestore(getAdminApp())
    .collection("stock_communities")
    .doc("CBA");
  if (target === "thread") return root.collection("threads").doc(id);
  if (target === "pulse") return root.collection("pulse").doc(id);
  assert(parentId);
  return target === "comment"
    ? root.collection("threads").doc(parentId).collection("comments").doc(id)
    : root.collection("pulse").doc(parentId).collection("replies").doc(id);
}

async function setStatus(
  target: Target,
  id: string,
  status: string,
  parentId?: string,
) {
  if (driver === "postgres") {
    const tables = {
      thread: "community_threads",
      comment: "community_comments",
      pulse: "community_pulse",
      reply: "community_pulse_replies",
    };
    await pool.query(`UPDATE ${tables[target]} SET status = $1 WHERE id = $2`, [
      status,
      id,
    ]);
  } else {
    await reference(target, id, parentId).update({ status });
  }
}

async function makeThread(
  status: "active" | "hidden" | "deleted" | "needs_review",
  title = `Synthetic ${status} thread`,
) {
  return store.createCommunityThread({
    stockCode: "CBA",
    type: "question",
    title,
    body: "Synthetic integration research only.",
    author,
    status,
    sources: [],
  });
}

function publicAuthors(value: unknown) {
  if (!value || typeof value !== "object") return;
  if ("author" in value && value.author) {
    assert.deepEqual(Object.keys(value.author).sort(), ["displayName"]);
  }
  for (const child of Object.values(value)) publicAuthors(child);
  assert(!JSON.stringify(value).includes("private-fixture"));
  assert(!JSON.stringify(value).includes("private-name@example.test"));
}

async function localPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForApp(baseUrl: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (app?.exitCode !== null) throw new Error("Next exited before readiness");
    try {
      const response = await fetch(`${baseUrl}/api/auth/csrf`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok && (await response.json()).csrfToken) return;
    } catch {
      /* compilation or server startup is still in progress */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next did not serve its auth route within 120 seconds");
}

async function contextFor(baseURL: string, name: string) {
  const context = await browser!.newContext({
    baseURL,
    serviceWorkers: "block",
    // Only these contexts trust the ephemeral loopback TLS certificate.
    ignoreHTTPSErrors: true,
  });
  context.setDefaultTimeout(30_000);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === baseURL || ["data:", "blob:"].includes(url.protocol))
      return route.continue();
    report.blockedBrowserHosts.push(url.hostname);
    await route.abort("blockedbyclient");
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  contexts.push({ context, name });
  return context;
}

try {
  const parents: Array<{
    status: string;
    thread: CommunityThread;
    pulse: CommunityPulseItem;
    comment: CommunityComment;
    reply: CommunityComment;
  }> = [];
  for (const status of [
    "active",
    "needs_review",
    "hidden",
    "deleted",
  ] as const) {
    const thread = await makeThread(status);
    const pulse = await store.createCommunityPulseItem({
      stockCode: "CBA",
      body: `Synthetic ${status} pulse`,
      author,
      status,
    });
    const comment = await store.createCommunityComment({
      stockCode: "CBA",
      threadId: thread.id,
      body: `Synthetic child of ${status} thread`,
      author,
      status: "active",
    });
    const reply = await store.createCommunityPulseReply({
      stockCode: "CBA",
      pulseId: pulse.id,
      body: `Synthetic child of ${status} pulse`,
      author,
      status: "active",
    });
    parents.push({ status, thread, pulse, comment, reply });
  }
  const active = parents[0]!;
  await check(
    "real adapter enforces active parent visibility for thread/detail/comments/pulse/replies",
    async () => {
      assert.deepEqual(
        (await store.listCommunityThreads("CBA")).map((item) => item.id),
        [active.thread.id],
      );
      assert.deepEqual(
        (await store.listCommunityPulseItems("CBA")).map((item) => item.id),
        [active.pulse.id],
      );
      for (const parent of parents) {
        assert.equal(
          Boolean(await store.getCommunityThread("CBA", parent.thread.id)),
          parent.status === "active",
        );
        assert.equal(
          (await store.listCommunityComments("CBA", parent.thread.id)).length,
          parent.status === "active" ? 1 : 0,
        );
        assert.equal(
          (await store.listCommunityPulseReplies("CBA", parent.pulse.id))
            .length,
          parent.status === "active" ? 1 : 0,
        );
      }
      assert.equal(
        await store.getCommunityThread("BHP", active.thread.id),
        null,
      );
      assert.deepEqual(
        await store.listCommunityComments("BHP", active.thread.id),
        [],
      );
      assert.deepEqual(
        await store.listCommunityPulseReplies("BHP", active.pulse.id),
        [],
      );
      assert.deepEqual(
        await store.listCommunityComments("CBA", "missing-parent"),
        [],
      );
    },
  );
  await check(
    "real adapter filters child statuses and observes each committed transition",
    async () => {
      for (const status of ["needs_review", "hidden", "deleted", "active"]) {
        await setStatus("comment", active.comment.id, status, active.thread.id);
        await setStatus("reply", active.reply.id, status, active.pulse.id);
        assert.equal(
          (await store.listCommunityComments("CBA", active.thread.id)).length,
          status === "active" ? 1 : 0,
        );
        assert.equal(
          (await store.listCommunityPulseReplies("CBA", active.pulse.id))
            .length,
          status === "active" ? 1 : 0,
        );
      }
    },
  );
  await check(
    "real summary drops a hidden headline on the next read",
    async () => {
      if (driver === "firestore") {
        await getFirestore(getAdminApp())
          .collection("stock_communities")
          .doc("CBA")
          .set({ headline: active.thread.title, status: "active" });
      }
      await store.getStockCommunitySummary("CBA");
      await setStatus("thread", active.thread.id, "hidden");
      assert(
        !JSON.stringify(await store.getStockCommunitySummary("CBA")).includes(
          active.thread.title,
        ),
      );
      await setStatus("thread", active.thread.id, "active");
    },
  );
  if (driver === "firestore") {
    await check(
      "emulator excludes legacy missing/unknown statuses",
      async () => {
        await reference("thread", active.thread.id).update({
          status: FieldValue.delete(),
        });
        assert.equal(
          await store.getCommunityThread("CBA", active.thread.id),
          null,
        );
        assert.deepEqual(
          await store.listCommunityComments("CBA", active.thread.id),
          [],
        );
        await setStatus("thread", active.thread.id, "unexpected-status");
        assert.equal(
          await store.getCommunityThread("CBA", active.thread.id),
          null,
        );
        await setStatus("thread", active.thread.id, "active");
      },
    );
  } else {
    await check(
      "Postgres rejects invalid persisted statuses and hides a mismatched-stock child",
      async () => {
        await assert.rejects(
          pool.query(
            "UPDATE community_threads SET status = 'unexpected-status' WHERE id = $1",
            [active.thread.id],
          ),
          /check constraint/,
        );
        await pool.query(
          "UPDATE community_comments SET stock_code = 'BHP' WHERE id = $1",
          [active.comment.id],
        );
        assert.deepEqual(
          await store.listCommunityComments("BHP", active.thread.id),
          [],
        );
        await pool.query(
          "UPDATE community_comments SET stock_code = 'CBA' WHERE id = $1",
          [active.comment.id],
        );
      },
    );
  }

  const port = await localPort();
  const appOrigin = `http://127.0.0.1:${port}`;
  proxy = loopbackTlsProxy({
    target: appOrigin,
    keyPath: process.env.COMMUNITY_TEST_TLS_KEY!,
    certPath: process.env.COMMUNITY_TEST_TLS_CERT!,
  });
  await new Promise<void>((resolve, reject) => {
    proxy!.once("error", reject);
    proxy!.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  assert(address && typeof address !== "string");
  const baseUrl = `https://127.0.0.1:${address.port}`;
  const env: NodeJS.ProcessEnv = { ...process.env, NEXTAUTH_URL: baseUrl };
  appLog = createWriteStream(path.join(output, `${driver}-next.log`));
  app = spawn(
    process.execPath,
    [
      path.join(webRoot, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: webRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  app.stdout!.pipe(appLog);
  app.stderr!.pipe(appLog);
  await waitForApp(appOrigin);
  // Direct Playwright API intentionally avoids the repository's documented
  // Node 24 + Playwright 1.52 CLI test-discovery hang.
  browser = await chromium.launch({ headless: true });
  const writer = await contextFor(baseUrl, "writer");
  const reader = await contextFor(baseUrl, "reader");
  const page = await writer.newPage();
  const readerPage = await reader.newPage();
  const getPublic = async (pathname: string, status = 200) => {
    const response = await reader.request.get(pathname);
    assert.equal(response.status(), status, pathname);
    assert.equal(response.headers()["cache-control"], "no-store", pathname);
    const body = await response.json();
    publicAuthors(body);
    return body;
  };

  await check(
    "real production auth reads only the writer's synthetic encrypted session and rejects a wrong secret",
    async () => {
      await writer.addCookies([
        await syntheticSessionCookie(process.env.NEXTAUTH_SECRET!, driver),
      ]);
      const session = await (
        await writer.request.get("/api/auth/session")
      ).json();
      assert.equal(session.user?.id, `synthetic-community-${driver}`);
      assert.equal(
        session.user?.email,
        `community-integration-${driver}@example.test`,
      );
      assert.equal(session.user?.isAdmin, false);
      assert.equal(session.user?.emailVerified, true);
      const anonymous = await (
        await reader.request.get("/api/auth/session")
      ).json();
      assert(!anonymous?.user);
      const wrongCookie = await syntheticSessionCookie(randomUUID(), driver);
      const rejected = await reader.request.get("/api/auth/session", {
        headers: { cookie: `${wrongCookie.name}=${wrongCookie.value}` },
      });
      assert.equal(rejected.status(), 200);
      assert(!(await rejected.json())?.user);
    },
  );

  let threadId = "";
  let commentId = "";
  const title = `Synthetic saved reply journey ${driver}`;
  const reply = `Synthetic persisted reply for ${driver}`;
  await check(
    "UI thread/reply writes persist and survive author reload and direct navigation",
    async () => {
      await page.goto(`${baseUrl}/shorts/CBA/community`);
      await page
        .getByRole("button", { name: "Start a thread", exact: true })
        .click();
      await page.getByLabel("Thread title", { exact: true }).fill(title);
      await page
        .getByLabel("Thread body", { exact: true })
        .fill(
          "Synthetic integration content. This is not investment research.",
        );
      const createdResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/api/community/CBA/threads"),
      );
      await page
        .getByRole("button", { name: "Post thread", exact: true })
        .click();
      const created = await createdResponse;
      assert.equal(created.status(), 201);
      const threadBody = await created.json();
      publicAuthors(threadBody);
      threadId = threadBody.thread.id;
      await page.goto(`${baseUrl}/shorts/CBA/community/${threadId}`);
      await page.getByLabel("Comment body", { exact: true }).fill(reply);
      const commentResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/threads/${threadId}/comments`),
      );
      await page
        .getByRole("button", { name: "Post comment", exact: true })
        .click();
      const saved = await commentResponse;
      assert.equal(saved.status(), 201);
      const body = await saved.json();
      publicAuthors(body);
      commentId = body.comment.id;
      assert.equal(body.comment.status, "active");
      assert(
        (await store.listCommunityComments("CBA", threadId)).some(
          (comment) => comment.id === commentId && comment.body === reply,
        ),
      );
      await expect(page.getByText(reply, { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText(reply, { exact: true })).toBeVisible();
      await page.goto(`${baseUrl}/shorts/CBA/community`);
      await page.goto(`${baseUrl}/shorts/CBA/community/${threadId}`);
      await expect(page.getByText(reply, { exact: true })).toBeVisible();
    },
  );

  await check(
    "fresh signed-out reader sees saved reply and all API/SSR authors use public DTOs",
    async () => {
      await readerPage.goto(`${baseUrl}/shorts/CBA/community/${threadId}`);
      await expect(readerPage.getByText(reply, { exact: true })).toBeVisible();
      await readerPage.reload();
      await expect(readerPage.getByText(reply, { exact: true })).toBeVisible();
      for (const route of [
        "threads",
        `threads/${active.thread.id}`,
        `threads/${active.thread.id}/comments`,
        "pulse",
        `pulse/${active.pulse.id}/replies`,
        "summary",
      ])
        await getPublic(`/api/community/CBA/${route}`);
      await readerPage.goto(
        `${baseUrl}/shorts/CBA/community/${active.thread.id}`,
      );
      const html = await readerPage.content();
      assert(!html.includes("private-fixture"));
      assert(!html.includes("private-name@example.test"));
      // Author labels are serialized in public DTOs; the current thread/reply
      // components do not display them. Verify that boundary and actual content.
      assert(
        html.includes(
          String.raw`\"author\":{\"displayName\":\"Community member\"}`,
        ),
        "Legacy authors must use the generic public label in the SSR payload",
      );
      await expect(
        readerPage.getByText(active.thread.title, { exact: true }),
      ).toBeVisible();
      await expect(
        readerPage.getByText(active.comment.body, { exact: true }),
      ).toBeVisible();
    },
  );

  await check(
    "review-held POST is an author-local preview and absent for fresh readers/reload",
    async () => {
      const heldReply = `Synthetic guaranteed result ${driver}`;
      await page.getByLabel("Comment body", { exact: true }).fill(heldReply);
      const pending = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/threads/${threadId}/comments`),
      );
      await page
        .getByRole("button", { name: "Post comment", exact: true })
        .click();
      const response = await pending;
      assert.equal(response.status(), 201);
      const heldResponse = await response.json();
      publicAuthors(heldResponse);
      assert.equal(heldResponse.comment.status, "needs_review");
      await expect(page.getByText(heldReply, { exact: true })).toBeVisible();
      await readerPage.goto(`${baseUrl}/shorts/CBA/community/${threadId}`);
      await expect(
        readerPage.getByText(heldReply, { exact: true }),
      ).toHaveCount(0);
      assert(
        !JSON.stringify(
          await getPublic(`/api/community/CBA/threads/${threadId}/comments`),
        ).includes(heldReply),
      );
      await page.reload();
      await expect(page.getByText(heldReply, { exact: true })).toHaveCount(0);
    },
  );

  await check(
    "next API request and full reload remove a newly hidden reply",
    async () => {
      await getPublic(`/api/community/CBA/threads/${threadId}/comments`);
      await setStatus("comment", commentId, "hidden", threadId);
      assert(
        !(
          await getPublic(`/api/community/CBA/threads/${threadId}/comments`)
        ).comments.some((item: { id: string }) => item.id === commentId),
      );
      await readerPage.reload();
      await expect(readerPage.getByText(reply, { exact: true })).toHaveCount(0);
      await setStatus("comment", commentId, "active", threadId);
    },
  );

  await check(
    "warm API reads re-evaluate held/hidden/deleted parents and their summaries/children",
    async () => {
      for (const status of ["needs_review", "hidden", "deleted"]) {
        await getPublic(`/api/community/CBA/threads/${threadId}`);
        await getPublic("/api/community/CBA/threads");
        await getPublic("/api/community/CBA/summary");
        await setStatus("thread", threadId, status);
        await getPublic(`/api/community/CBA/threads/${threadId}`, 404);
        assert.equal(
          (await getPublic(`/api/community/CBA/threads/${threadId}/comments`))
            .comments.length,
          0,
        );
        assert(
          !(await getPublic("/api/community/CBA/threads")).threads.some(
            (item: { id: string }) => item.id === threadId,
          ),
        );
        assert(
          !JSON.stringify(
            await getPublic("/api/community/CBA/summary"),
          ).includes(title),
        );
        await readerPage.reload();
        await expect(readerPage.getByText(title, { exact: true })).toHaveCount(
          0,
        );
        await expect(readerPage.getByText(reply, { exact: true })).toHaveCount(
          0,
        );
        await setStatus("thread", threadId, "active");
      }
      await readerPage.goto(`${baseUrl}/shorts/CBA/community/${threadId}`);
      await expect(readerPage.getByText(reply, { exact: true })).toBeVisible();
      await readerPage.screenshot({
        path: path.join(output, `${driver}-saved-reply.png`),
        fullPage: true,
      });
      assert(
        !report.blockedBrowserHosts.some(
          (host) =>
            host === "shorted.com.au" || host.endsWith(".shorted.com.au"),
        ),
        "App attempted a production Shorted request; browser isolation blocked it",
      );
    },
  );
  report.status = "passed";
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  for (const { context, name } of contexts) {
    try {
      await context.tracing.stop({
        path: path.join(output, `${driver}-${name}-trace.zip`),
      });
    } catch {
      /* retain original failure */
    }
    await context.close().catch(() => undefined);
  }
  await browser?.close().catch(() => undefined);
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => app!.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  appLog?.end();
  if (proxy?.listening) {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy!.close(() => resolve()));
  }
  await pool.end();
  await Promise.all(getApps().map(deleteApp));
  report.blockedBrowserHosts = [...new Set(report.blockedBrowserHosts)].sort();
  await writeFile(
    path.join(output, `${driver}-assertions.json`),
    JSON.stringify(report, null, 2),
  );
}
