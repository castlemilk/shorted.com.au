/// Guards for Taskfile.yml.
///
/// The Taskfile is the front door for operations, so its SAFETY properties are
/// the point of it, not a nicety. Each assertion here corresponds to a way this
/// repo has actually been damaged or nearly damaged:
///
///   * an exported prod DATABASE_URL silently retargeting a "local" command,
///     because services/Makefile declares it with `?=`;
///   * DDL or an MV refresh run against the transaction pooler, which kills long
///     statements mid-flight and starved five materialized views for 19 days;
///   * a production write invoked without anyone meaning to.
///
/// These are string assertions on purpose: every one of these failure modes is
/// silent at runtime, and a task that stops guarding still runs fine.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const taskfile = readFileSync(join(repoRoot, "Taskfile.yml"), "utf8");

/** Crude but sufficient: slice the text of one task by its two-space key. */
function taskBody(name) {
  const start = taskfile.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `task ${name} not found in Taskfile.yml`);
  const rest = taskfile.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9:._-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Every task key at the top level of `tasks:`. */
function allTaskNames() {
  const tasksAt = taskfile.indexOf("\ntasks:\n");
  assert.notEqual(tasksAt, -1, "no tasks: block");
  return [...taskfile.slice(tasksAt).matchAll(/\n {2}([a-z][a-z0-9:._-]*):\n/g)].map((m) => m[1]);
}

test("every production-write task requires an explicit CONFIRM", () => {
  // `prompt:` is not enough for these: `task --yes` and any non-TTY caller sail
  // straight through it. A required variable cannot be bypassed by accident.
  const prodWriters = ["db:prod:apply", "db:prod:refresh", "job:prod:exec", "deploy:revalidate"];

  for (const name of prodWriters) {
    const body = taskBody(name);
    assert.match(body, /requires:\s*\{?\s*vars:.*CONFIRM/s, `${name} must require CONFIRM`);
    assert.match(
      body,
      /\{\{\.CONFIRM\}\}"?\s*=\s*"prod"|"\{\{\.CONFIRM\}\}"\s*=\s*"prod"/,
      `${name} must check CONFIRM equals "prod", not merely that it is set`,
    );
  }
});

test("prod DDL and MV refresh are pinned to the SESSION pooler", () => {
  // The transaction pooler (6543) kills DDL and REFRESH ... CONCURRENTLY
  // mid-statement. A copy-pasted 6543 DSN must fail loudly, not half-apply.
  for (const name of ["db:prod:apply", "db:prod:refresh"]) {
    const body = taskBody(name);
    assert.match(body, /DB_PROD_SESSION/, `${name} must use the session-pooler DSN`);
    assert.match(body, /grep -q ":5432\/"/, `${name} must assert the DSN is on port 5432`);
    assert.doesNotMatch(body, /DB_PROD_TXN/, `${name} must not touch the transaction pooler`);
  }

  // And the refresh must disable the statement timeout, or a big view dies
  // partway and takes every later view with it.
  assert.match(taskBody("db:prod:refresh"), /statement_timeout=0/);
  assert.match(taskBody("db:prod:apply"), /statement_timeout=0/);
});

test("local database tasks pin their DSN so an ambient one cannot win", () => {
  // go-task's `env:` overrides the inherited environment. Without it, an
  // exported prod DATABASE_URL retargets these at Supabase.
  for (const name of ["db:shell", "db:migrate", "db:migrate:down", "job:housing:local"]) {
    const body = taskBody(name);
    assert.match(body, /env:.*DATABASE_URL.*DB_LOCAL/s, `${name} must pin DATABASE_URL to DB_LOCAL`);
  }

  const migrate = taskBody("db:migrate");
  assert.match(migrate, /localhost|127\\?\.0\\?\.0\\?\.1/, "db:migrate must assert its DSN is local");
});

test("the bulk prod migrate is a refusal, not a shortcut", () => {
  // services/Makefile has a migrate-up-prod target that replays ~34 migrations
  // against a database whose version counter is force-written to 75. Someone
  // will go looking for it, so the Taskfile answers with an explanation.
  const body = taskBody("db:prod:migrate");
  assert.match(body, /exit 1/, "db:prod:migrate must fail");
  assert.match(body, /db:prod:apply/, "it must point at the supported path");
  // Mentioning the target by name in the explanation is the point; INVOKING it
  // is the thing to prevent, so match the invocation form rather than the word.
  assert.doesNotMatch(body, /make\s+migrate-up-prod/, "it must not invoke the dangerous target");
});

test("no task silently runs the destructive make targets", () => {
  // These wipe state beyond this repo: a machine-wide docker volume prune, and
  // a compose teardown that always removes volumes even on success.
  for (const forbidden of ["test-clean", "docker volume prune", "docker system prune"]) {
    assert.ok(
      !taskfile.includes(forbidden),
      `Taskfile must not wrap ${forbidden} — it destroys other projects' containers`,
    );
  }
});

test("Go tasks are reproducible with CI", () => {
  // services/go.work replaces a private module with a sibling checkout that
  // exists only on a dev machine; without GOWORK=off every package fails
  // typecheck on any other machine, including CI.
  const header = taskfile.slice(0, taskfile.indexOf("\ntasks:\n"));
  assert.match(header, /^env:/m, "a global env: block is expected");
  assert.match(header, /GOWORK:\s*"off"/, "GOWORK must be off globally");
  assert.match(header, /GOPRIVATE:\s*github\.com\/skunkworq/, "GOPRIVATE must be set globally");

  // --concurrency 1 is an OOM guard; it lives in the make target we delegate to.
  assert.match(taskBody("test:lint"), /make lint-backend/, "test:lint must delegate to the make target that carries --concurrency 1");
});

test("every listed task has a description", () => {
  // `task --list` is the discovery surface. A task without a desc is invisible
  // there, so an undescribed task is either a mistake or should be deliberate.
  const undescribed = allTaskNames().filter((name) => {
    const body = taskBody(name);
    return !/\n\s+desc:/.test(body);
  });
  assert.deepEqual(undescribed, [], `tasks missing desc: ${undescribed.join(", ")}`);
});

test("tasks whose misuse is silent carry long help", () => {
  // Each of these has a failure mode that produces no error at the time.
  for (const name of [
    "db:prod:apply",
    "db:prod:refresh",
    "db:migrate",
    "job:housing:local",
    "job:prod:exec",
    "test:go",
    "test:lint",
    "test:e2e",
    "deploy:revalidate",
    "dev:ports",
  ]) {
    assert.match(taskBody(name), /\n\s+summary:\s*\|/, `${name} needs a summary explaining its landmine`);
  }
});
