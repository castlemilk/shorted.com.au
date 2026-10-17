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
///   * a production write invoked without anyone meaning to;
///   * a guard expressed as PGOPTIONS, which Supabase's pooler drops, so the
///     "read-only" prod shell could write and every refresh ran under a
///     2-minute statement timeout while believing it had none.
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
const prodPsql = readFileSync(join(repoRoot, "scripts/prod-psql.sh"), "utf8");

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
  const prodWriters = ["db:prod:apply", "db:prod:refresh", "job:prod:exec", "deploy:revalidate", "news:publish:remote"];

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

});

test("prod database tasks set their guards INSIDE a transaction, never via PGOPTIONS", () => {
  // Measured 2026-09-23: Supavisor drops libpq startup options on 5432 and
  // 6543 alike. `PGOPTIONS='-c default_transaction_read_only=on'` then reads
  // back `off`, and `-c statement_timeout=0` leaves the role's 2-minute
  // default. The tasks looked guarded and were not. Each one must go through
  // the wrapper, which SETs over the connection and checks the result there.
  const routes = {
    "db:prod:psql": /scripts\/prod-psql\.sh read-only \{\{\.CLI_ARGS\}\}/,
    "db:prod:apply": /scripts\/prod-psql\.sh apply "\{\{\.FILE\}\}"/,
    "db:prod:refresh": /scripts\/prod-psql\.sh refresh "\$fn"/,
    "debug:housing": /scripts\/prod-psql\.sh read-only -tA/,
  };
  for (const [name, route] of Object.entries(routes)) {
    const body = taskBody(name);
    assert.match(body, route, `${name} must run through scripts/prod-psql.sh`);
    assert.match(body, /PGURL:\s*"\{\{\.DB_PROD_SESSION\}\}"/, `${name} must use the session pooler`);
  }

  // Any bare psql against a prod DSN would bypass the guards. The only prod
  // psql in the Taskfile is the wrapper's.
  assert.doesNotMatch(taskfile, /(^|[\s'"(])psql\s+"\$PGURL"/m, "a task calls psql on a prod DSN directly");

  // No task may set a guard through PGOPTIONS. Clearing an ambient value
  // (`PGOPTIONS: ""`) is fine; setting one is the no-op this test exists for.
  assert.doesNotMatch(
    taskfile,
    /PGOPTIONS[=:]\s*["']?-c/,
    "a PGOPTIONS guard is silently dropped by the pooler; SET LOCAL it in a transaction instead",
  );
});

test("the prod wrapper scopes each guard to one transaction and checks it before the work", () => {
  // Whether Supavisor's session pooler resets a session-level SET before the
  // next client gets the backend is unverified, so a guard must be SET LOCAL:
  // it cannot outlive the transaction on any pooler. The behaviour is pinned
  // in scripts/tests/prod-psql.test.mjs; these are the load-bearing lines.
  const section = (from, to) => prodPsql.slice(prodPsql.indexOf(`\n${from})`), prodPsql.indexOf(`\n${to})`));

  const readOnly = section("read-only", "apply");
  assert.match(
    readOnly,
    /-c "BEGIN READ ONLY;\nSET LOCAL default_transaction_read_only = on;\nSET LOCAL statement_timeout = '\$read_timeout';\n\$\(guard on "\$read_timeout"\);\n\$\{sql\}ROLLBACK;"/,
    "a probe is ONE -c string: BEGIN READ ONLY, SET LOCAL, check, SQL, ROLLBACK",
  );
  assert.match(readOnly, /node "\$classifier" --probe/, "a probe must be screened for COMMIT/ROLLBACK");

  const apply = section("apply", "refresh");
  assert.match(
    apply,
    /--single-transaction \\\n\s*-c "SET LOCAL statement_timeout = 0" -c "\$\(guard off 0\)" \\\n\s*-f "\$file" \\\n\s*-c "RESET ALL"/,
    "apply: one transaction, SET LOCAL statement_timeout = 0 and its check before -f, RESET ALL after",
  );
  // The session fallback exists only for files the classifier says cannot run
  // in a transaction, and it must warn and RESET ALL.
  assert.match(apply, /3\)\n\s*warn [\s\S]*-c "SET statement_timeout = 0"[\s\S]*-f "\$file" \\\n\s*-c "RESET ALL"/);
  assert.equal((prodPsql.match(/-c "SET statement_timeout = 0"/g) || []).length, 1, "exactly one session-level SET, the fallback");
  assert.doesNotMatch(prodPsql, /SET default_transaction_read_only/, "the read-only default is never SET at session level");

  const refresh = section("refresh", "*");
  assert.match(
    refresh,
    /--single-transaction \\\n\s*-c "SET LOCAL statement_timeout = 0" -c "\$\(guard off 0\)" \\\n\s*-c "SELECT \$fn\(\)"/,
    "refresh: one transaction, SET LOCAL statement_timeout = 0 and its check before the call",
  );
  assert.match(refresh, /grep -c 'WARNING: \*Skipping '/, "a skipped view must fail the refresh");

  // The checks must be able to fail, and fail the run.
  assert.match(prodPsql, /psql_base=\(psql "\$PGURL" -X -v ON_ERROR_STOP=1\)/);
  assert.match(prodPsql, /current_setting\('transaction_read_only'\) <> '\$want_read_only'[\s\S]*RAISE EXCEPTION/);
  assert.match(prodPsql, /current_setting\('statement_timeout'\)::interval <> '\$want_timeout'::interval[\s\S]*RAISE EXCEPTION/);
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
    "news:publish:remote",
    "dev:ports",
  ]) {
    assert.match(taskBody(name), /\n\s+summary:\s*\|/, `${name} needs a summary explaining its landmine`);
  }
});

test("live runbooks do not prescribe a PGOPTIONS guard", () => {
  // The docs are where the PGOPTIONS recipe was copied from, so fixing the
  // tasks alone would leave the next operator to paste it back. A runbook may
  // explain why PGOPTIONS does nothing; it may not put it in a command.
  const runbooks = [
    "CLAUDE.md",
    "docs/feature/housing/operations.md",
    "docs/feature/housing/architecture.md",
    "docs/feature/politicians/operations.md",
    "docs/economy-architecture.md",
    ".claude/skills/housing-suburb-data/SKILL.md",
    "services/migrations/PROD_APPLIED.md",
    "web/scripts/geo/hazards/README.md",
  ];
  for (const path of runbooks) {
    const text = readFileSync(join(repoRoot, path), "utf8");
    const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
    assert.doesNotMatch(fenced, /PGOPTIONS=/, `${path} has a PGOPTIONS command; use task db:prod:apply / db:prod:refresh`);
  }
});
