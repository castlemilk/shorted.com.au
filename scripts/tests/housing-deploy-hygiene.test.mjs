import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const deployDir = join(repoRoot, "services/house-price-collector/deploy");
const commonScript = join(deployDir, "housing-crawl-common.sh");
// docs/housing-architecture.md is a redirect stub since the doc set was split
// into docs/feature/housing/ — point the drift guards at the real file, or they
// silently assert against a nine-line stub and pass for the wrong reason.
const housingArchitecture = join(repoRoot, "docs/feature/housing/architecture.md");

function readDeploy(file) {
  return readFileSync(join(deployDir, file), "utf8");
}

function plistSchedule(source) {
  const schedule = source.match(
    /<key>StartCalendarInterval<\/key>([\s\S]*?)(?=<key>StandardOutPath<\/key>)/,
  );
  assert.ok(schedule, "expected a StartCalendarInterval schedule");
  return schedule[1];
}

function waitForExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function waitForMatch(path, pattern, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && pattern.test(readFileSync(path, "utf8"))) return true;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  return false;
}

function makeFakeCollector(root) {
  const fakeBin = join(root, "fake-collector.sh");
  writeFileSync(
    fakeBin,
    `#!/usr/bin/env bash
set -u
count=0
if [[ -f "\${FAKE_COUNT_FILE:-}" ]]; then count="$(cat "$FAKE_COUNT_FILE")"; fi
count=$((count + 1))
if [[ -n "\${FAKE_COUNT_FILE:-}" ]]; then printf '%s\\n' "$count" > "$FAKE_COUNT_FILE"; fi
if [[ -n "\${FAKE_FIRST_LINE:-}" ]]; then printf '%s\\n' "$FAKE_FIRST_LINE"; fi
if [[ "\${FAKE_SIGNAL_FD3:-}" == "1" ]]; then printf 'started\\n' >&3; fi
if [[ "\${FAKE_WAIT_STDIN:-}" == "1" ]]; then read -r _; fi
case "\${FAKE_SCENARIO:-empty}" in
  stream) printf '%s\\n' '[agent] done: processed 0 job(s)' ;;
  rc3) printf '%s\\n' '[agent] done: processed 1 job(s)'; exit 3 ;;
  drain_then_empty)
    if [[ "$count" -eq 1 ]]; then
      printf '%s\\n' '[agent] done: processed 2 job(s)'
    else
      printf '%s\\n' '[agent] no more jobs'
    fi
    ;;
  zero) printf '%s\\n' '[agent] done: processed 0 job(s)' ;;
esac
`,
    { mode: 0o755 },
  );
  return fakeBin;
}

function runDrain({ scenario, maxRounds = "4" }) {
  const root = mkdtempSync(join(tmpdir(), "housing-drain-contract-"));
  const fakeBin = makeFakeCollector(root);
  const log = join(root, "drain.log");
  const countFile = join(root, "count");
  const command = `source "$COMMON_SCRIPT"; BIN="$FAKE_BIN"; LOG="$FAKE_LOG"; CRAWL_DRAIN_MAX_ROUNDS="$MAX_ROUNDS"; hc_drain_until_empty`;
  const result = spawnSync("/bin/bash", ["-c", command], {
    encoding: "utf8",
    env: {
      ...process.env,
      COMMON_SCRIPT: commonScript,
      FAKE_BIN: fakeBin,
      FAKE_LOG: log,
      FAKE_COUNT_FILE: countFile,
      FAKE_SCENARIO: scenario,
      MAX_ROUNDS: maxRounds,
      TMPDIR: root,
    },
  });
  return {
    ...result,
    count: Number(readFileSync(countFile, "utf8")),
    log: readFileSync(log, "utf8"),
    captures: readdirSync(root).filter((file) => file.startsWith("shorted-housing-drain.")),
  };
}

test("supported launchd templates use the proven daytime schedules", () => {
  const delta = readDeploy("com.shorted.housing-delta.plist.template");
  const full = readDeploy("com.shorted.housing-full.plist.template");

  assert.match(plistSchedule(delta), /<key>Hour<\/key><integer>10<\/integer>/);
  assert.match(delta, /daytime[\s\S]*(?:REA|Kasada)[\s\S]*(?:clearance|block)/i);

  const fullSchedule = plistSchedule(full);
  assert.deepEqual([...fullSchedule.matchAll(/<key>Day<\/key><integer>(\d+)<\/integer>/g)].map((m) => m[1]), ["1", "15"]);
  assert.equal((fullSchedule.match(/<key>Hour<\/key><integer>8<\/integer>/g) ?? []).length, 2);
  assert.match(full, /daytime[\s\S]*(?:REA|Kasada)[\s\S]*(?:clearance|block)/i);

  for (const [name, source] of [["delta", delta], ["full", full]]) {
    assert.doesNotMatch(plistSchedule(source), /<key>Hour<\/key><integer>[0-5]<\/integer>/, `${name} schedules a block-prone night hour`);
  }
});

test("legacy crawl plist is manual-only and prominently deprecated", () => {
  const legacy = readDeploy("com.shorted.housing-crawl.plist.template");
  assert.match(legacy.slice(0, 700), /DEPRECATED/);
  assert.match(legacy, /com\.shorted\.housing-delta\.plist\.template/);
  assert.match(legacy, /com\.shorted\.housing-full\.plist\.template/);
  assert.match(legacy, /manual[- ]only/i);
  assert.doesNotMatch(legacy, /StartCalendarInterval/);
  assert.doesNotMatch(legacy, /02:30|<integer>2<\/integer>[\s\S]*<integer>30<\/integer>/);
});

test("README leads with the supported delta/full setup and retires legacy jobs", () => {
  const readme = readDeploy("README.md");
  // The heading gained a "Real-estate crawl —" qualifier when the NSW VG
  // deployment section landed in the same README, so match the section by its
  // distinguishing phrase rather than a literal prefix.
  const supported = readme.search(/^## .*supported deployment/im);
  const deprecated = readme.search(/^## Deprecated/im);
  assert.ok(supported >= 0 && deprecated > supported, "supported delta/full deployment must precede deprecated paths");
  assert.match(readme.slice(supported, deprecated), /housing-delta[\s\S]*housing-full/);
  assert.match(readme.slice(supported, deprecated), /daily[^\n]*10:00/i);
  assert.match(readme.slice(supported, deprecated), /(?:1st|1)[^\n]*(?:15th|15)[^\n]*08:00/i);
  assert.match(readme.slice(supported, deprecated), /daytime[\s\S]*(?:REA|Kasada)[\s\S]*(?:clearance|block)/i);
  assert.match(readme.slice(supported, deprecated), /launchctl unload[^\n]*com\.shorted\.housing-crawl\.plist/);
  assert.match(readme.slice(supported, deprecated), /launchctl unload[^\n]*com\.shorted\.housing-agent\.plist/);
  assert.equal((readme.match(/for job in housing-delta housing-full/g) ?? []).length, 1, "keep one canonical install loop");
  // The daytime-only rule protects the REA/Domain crawl, whose overnight runs get
  // Kasada-blocked. It must NOT cover the NSW Valuer-General section earlier in
  // this README: that mode is a plain ZIP fetch with no browser and no bot wall,
  // so its 04:30 monthly slot is deliberate. Scope the assertion to the crawl
  // half of the document.
  assert.doesNotMatch(readme.slice(supported), /\b(?:0[0-5]):[0-5][0-9]\b/,
    "crawl runbook must not recommend block-prone 00:00–05:59 schedules");
});

test("housing docs document only the collector's real resume-window variable", () => {
  const readme = readDeploy("README.md");
  const architecture = readFileSync(housingArchitecture, "utf8");
  for (const [name, source] of [["deploy README", readme], ["housing architecture", architecture]]) {
    assert.match(source, /CRAWL_LISTINGS_RESUME_WINDOW_H/);
    assert.doesNotMatch(source, /(?<!LISTINGS_)CRAWL_RESUME_WINDOW_H/, `${name} documents a dead resume variable`);
  }
});

test("housing docs explain that implicit trace output stays outside the checkout", () => {
  for (const [name, source] of [
    ["deploy README", readDeploy("README.md")],
    ["housing architecture", readFileSync(housingArchitecture, "utf8")],
  ]) {
    assert.match(source, /CRAWL_TRACE=1[\s\S]*private[\s\S]*(?:OS )?temp/i, `${name} omits the safe implicit trace directory`);
    assert.match(source, /CRAWL_TRACE_DIR[\s\S]*explicit/i, `${name} omits the explicit trace-directory override`);
  }
});

test("README carries the five silent-outage modes and fastest diagnosis path", () => {
  const readme = readDeploy("README.md");
  for (const contract of [
    /BrandBrainAgent\.app[\s\S]*~\/\.brandbrain\/diag-port[\s\S]*control_secret/,
    /thin-suburb[\s\S]*CRAWL_LISTINGS_MIN_PER_PAGE=1/i,
    /hung[\s\S]*ps -o pid,etime,stat[\s\S]*kill/i,
    /in_progress[\s\S]*older than ~?2h[\s\S]*PURGE_DRY_RUN[\s\S]*re-enqueue/i,
    /never-attempted[\s\S]*deferred[\s\S]*not_before[\s\S]*refund/i,
  ]) {
    assert.match(readme, contract);
  }
  assert.match(readme, /fastest diagnosis order/i);
  assert.match(readme, /SELECT max\(created_at\) FROM property_price_events/);
  assert.match(readme, /status=pending\|failed/);
  assert.match(readme, /direct[^\n]*-mode agent[\s\S]*CRAWL_DRY_RUN=true[\s\S]*CRAWL_DRY_RUN=false/i);
  assert.match(readme, /CRAWL_FRESHNESS_WEBHOOK/);
});

test("drain streams collector output before the round finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "housing-drain-stream-"));
  const fakeBin = makeFakeCollector(root);
  const log = join(root, "drain.log");

  const command = `source "$COMMON_SCRIPT"; BIN="$FAKE_BIN"; LOG="$FAKE_LOG"; CRAWL_DRAIN_MAX_ROUNDS=1; hc_drain_until_empty`;
  const child = spawn("/bin/bash", ["-c", command], {
    env: {
      ...process.env,
      COMMON_SCRIPT: commonScript,
      FAKE_BIN: fakeBin,
      FAKE_LOG: log,
      FAKE_FIRST_LINE: "collector started",
      FAKE_SIGNAL_FD3: "1",
      FAKE_WAIT_STDIN: "1",
      FAKE_SCENARIO: "stream",
      TMPDIR: root,
    },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const exitPromise = waitForExit(child);
  const markerPromise = new Promise((resolvePromise, reject) => {
    child.stdio[3].once("data", resolvePromise);
    child.stdio[3].once("error", reject);
  });

  await markerPromise;
  const streamedBeforeRelease = await waitForMatch(log, /collector started/);
  child.stdin.end("continue\n");
  const exit = await exitPromise;
  assert.equal(streamedBeforeRelease, true, "collector output was not logged while the round was still blocked");
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal((readFileSync(log, "utf8").match(/collector started/g) ?? []).length, 1, "streamed lines must not be appended twice");
  assert.deepEqual(readdirSync(root).filter((file) => file.startsWith("shorted-housing-drain.")), []);
});

test("drain preserves rc=3 and stable processed/empty contracts", () => {
  const rc3 = runDrain({ scenario: "rc3" });
  assert.equal(rc3.status, 3, rc3.stderr);
  assert.equal(rc3.count, 1);
  assert.deepEqual(rc3.captures, []);

  const drained = runDrain({ scenario: "drain_then_empty" });
  assert.equal(drained.status, 0, drained.stderr);
  assert.equal(drained.count, 2);
  assert.match(drained.log, /queue empty after 2 round\(s\)/);
  assert.deepEqual(drained.captures, []);

  const zero = runDrain({ scenario: "zero" });
  assert.equal(zero.status, 0, zero.stderr);
  assert.equal(zero.count, 1);
  assert.match(zero.log, /0 processed and queue not reported empty/);
  assert.deepEqual(zero.captures, []);
});
