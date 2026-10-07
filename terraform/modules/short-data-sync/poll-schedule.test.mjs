// Contract for the intraday `short-data-sync -poll` trigger (poll.tf poll_sync).
// ASIC publishes at 11:30 Australia/Sydney; the poll brackets that on weekdays
// and the daily 10:00 UTC run stays the backstop. Run: node --test <this file>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
const pollTf = readFileSync(new URL("./poll.tf", import.meta.url), "utf8");
const variablesTf = readFileSync(new URL("./variables.tf", import.meta.url), "utf8");

function block(src, header) {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `${header} should be present`);
  const next = src.indexOf("\nresource ", start + header.length);
  return src.slice(start, next > -1 ? next : src.length);
}

const poll = block(pollTf, 'resource "google_cloud_scheduler_job" "poll_sync"');
const grant = block(pollTf, 'resource "google_cloud_run_v2_job_iam_member" "scheduler_poll_overrides"');

test("poll runs on weekdays only, in Sydney time", () => {
  assert.match(poll, /time_zone\s*=\s*"Australia\/Sydney"/);
  assert.match(poll, /schedule\s*=\s*var\.poll_schedule/);
  const def = variablesTf.match(/variable "poll_schedule"[\s\S]*?default\s*=\s*"([^"]+)"/);
  assert.ok(def, "poll_schedule needs a default");
  const [, hour, , , dow] = def[1].split(/\s+/);
  assert.equal(dow, "1-5", "weekdays only: ASIC does not publish at weekends");
  const [lo, hi] = hour.split("-").map(Number);
  assert.ok(lo <= 11 && hi >= 11, "the window must cover ASIC's 11:30 publication");
});

test("poll posts the -poll override to the v2 run API and honours the pause", () => {
  // v2 spelling (`timeout`), so it must never share a file with a v1 trigger.
  assert.doesNotMatch(pollTf, /\/v1\/namespaces/);
  assert.match(poll, /https:\/\/run\.googleapis\.com\/v2\/projects\/.*:run"/);
  assert.match(poll, /args\s*=\s*\["short-data-sync",\s*"-poll"\]/);
  assert.match(poll, /body\s*=\s*base64encode\(jsonencode\(/);
  assert.match(poll, /"Content-Type"\s*=\s*"application\/json"/);
  assert.match(poll, /paused\s*=\s*var\.scheduler_paused/);
  assert.match(poll, /google_cloud_run_v2_job_iam_member\.scheduler_poll_overrides/);
});

test("runWithOverrides is granted on this job only, never project-wide", () => {
  assert.match(grant, /role\s*=\s*"roles\/run\.developer"/);
  assert.match(grant, /name\s*=\s*google_cloud_run_v2_job\.short_data_sync\.name/);
  assert.match(grant, /scheduler_invoker\.email/);
  for (const src of [mainTf, pollTf]) {
    assert.doesNotMatch(src, /google_project_iam_\w+"[^{]*\{[^}]*roles\/run\.developer/);
  }
});
