// Contract for the intraday `short-data-sync -poll` trigger (poll.tf poll_sync).
// ASIC posts at 11:30:11 Australia/Sydney; the poll bursts just after that on
// weekdays, tails hourly for a late file, and the daily 10:00 UTC run stays the backstop. Run: node --test <this file>
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

function schedules() {
  const def = variablesTf.match(/variable "poll_schedules"[\s\S]*?default\s*=\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(def, "poll_schedules needs a default map");
  const out = {};
  for (const [, key, cron] of def[1].matchAll(/(\w+)\s*=\s*"([^"]+)"/g)) out[key] = cron;
  return out;
}

test("one scheduler per poll_schedules entry, weekdays only, in Sydney time", () => {
  assert.match(poll, /time_zone\s*=\s*"Australia\/Sydney"/);
  assert.match(poll, /for_each\s*=\s*var\.enable_poll_schedule \? var\.poll_schedules : \{\}/);
  assert.match(poll, /schedule\s*=\s*each\.value/);
  // The original single poll was `<job>-poll`; its state address must move,
  // not be destroyed and recreated.
  assert.match(pollTf, /moved\s*\{[^}]*from\s*=\s*google_cloud_scheduler_job\.poll_sync\[0\][^}]*to\s*=\s*google_cloud_scheduler_job\.poll_sync\["publish"\]/);
  assert.match(poll, /each\.key == "publish" \? "\$\{local\.service_name\}-poll"/);
  const all = schedules();
  assert.ok("publish" in all && "late" in all, "needs a publish burst and a late tail");
  for (const [key, cron] of Object.entries(all)) {
    const [, , , , dow] = cron.split(/\s+/);
    assert.equal(dow, "1-5", `${key}: weekdays only, ASIC does not publish at weekends`);
  }
});

test("the publish burst sits just after ASIC's 11:30:11 Sydney posting", () => {
  const [minutes, hour] = schedules().publish.split(/\s+/);
  assert.equal(hour, "11", "ASIC posts at 11:30 local; the burst belongs in that hour");
  const mins = minutes.split(",").map(Number);
  assert.ok(mins.every((m) => m > 30), "every burst poll must come after the 11:30 posting");
  assert.ok(mins[0] <= 35, "the first poll should land within five minutes of the posting");
  assert.ok(mins.length >= 2, "at least one re-poll in case of CDN or scheduler lag");
});

test("the late tail is sparse and covers the afternoon", () => {
  const [minutes, hours] = schedules().late.split(/\s+/);
  const [lo, hi] = hours.split("-").map(Number);
  assert.ok(lo >= 12 && hi >= 14, "the tail starts after the burst and reaches mid-afternoon");
  const perHour = minutes.split(",").length;
  const total = schedules().publish.split(/\s+/)[0].split(",").length + perHour * (hi - lo + 1);
  assert.ok(total <= 8, `aligned polling should be a handful of runs a day, got ${total}`);
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
