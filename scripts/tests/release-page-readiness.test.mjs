import assert from "node:assert/strict";
import { test } from "node:test";
import { releasePageText } from "../../web/e2e/helpers/release-page-readiness.mjs";

function streamedPage(t, snapshots, { waitCost = 20, readCost = 5 } = {}) {
  let now = 0;
  let read = 0;
  const waits = [];
  const reads = [];
  t.mock.method(performance, "now", () => now);
  const page = {
    async waitForFunction(_predicate, patterns, { timeout }) {
      waits.push({ patterns, timeout });
      now += waitCost;
    },
    locator(selector) {
      assert.equal(selector, "body");
      return {
        async innerText({ timeout }) {
          reads.push(timeout);
          now += readCost;
          return snapshots[Math.min(read++, snapshots.length - 1)];
        },
      };
    },
  };
  return { page, waits, reads };
}

test("a shell replacing ready content is rechecked before returning text", async (t) => {
  const ready = "ASX Short Selling Reports\nWeek 42, 2026";
  const { page, waits, reads } = streamedPage(t, ["Shorted\nProduct\nReports", ready]);

  assert.equal(await releasePageText(page, [/Short Selling Reports/i, /Week \d+, 20\d{2}/i], 100), ready);
  assert.equal(waits.length, 2);
  assert.deepEqual(waits.map(({ timeout }) => timeout), [100, 75]);
  assert.deepEqual(reads, [80, 55]);
});

test("every required pattern must match the returned snapshot", async (t) => {
  const ready = "ASX Short Selling Reports\nWeek 42, 2026";
  const { page, waits } = streamedPage(t, ["ASX Short Selling Reports", ready]);

  assert.equal(await releasePageText(page, [/Short Selling Reports/gi, /Week 42/], 100), ready);
  assert.equal(waits.length, 2);
  assert.deepEqual(waits[0].patterns, [
    { source: "Short Selling Reports", flags: "gi" },
    { source: "Week 42", flags: "" },
  ]);
});

test("content that disappears permanently still fails within the shared deadline", async (t) => {
  const { page, waits, reads } = streamedPage(t, ["Shorted\nProduct\nReports"], {
    waitCost: 10,
    readCost: 10,
  });

  await assert.rejects(releasePageText(page, [/Short Selling Reports/i], 15), /timed out/i);
  assert.equal(waits.length, 1);
  assert.deepEqual(reads, [5]);
});

test("a browser readiness timeout remains a test failure", async () => {
  const timeout = new Error("page.waitForFunction: Timeout exceeded");
  const page = {
    async waitForFunction() { throw timeout; },
    locator() { assert.fail("must not read a page that never became ready"); },
  };

  await assert.rejects(releasePageText(page, [/Short Selling Reports/i]), (error) => error === timeout);
});

test("an already complete page returns its body without another wait", async (t) => {
  const { page, waits } = streamedPage(t, ["Who owns the ASX"]);

  assert.equal(await releasePageText(page, [/Who owns the ASX/], 100), "Who owns the ASX");
  assert.equal(waits.length, 1);
});
