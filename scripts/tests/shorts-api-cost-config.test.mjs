import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const modulePath = new URL(
  "../../terraform/modules/shorts-api/main.tf",
  import.meta.url,
);
const source = readFileSync(modulePath, "utf8");

test("shorts API serves eight concurrent requests on one vCPU", () => {
  const cpu = source.match(/^\s*cpu\s*=\s*"([^"]+)"/m)?.[1];
  const concurrency = source.match(
    /^\s*max_instance_request_concurrency\s*=\s*(\d+)/m,
  )?.[1];

  assert.deepEqual(
    { cpu, concurrency: Number(concurrency) },
    { cpu: "1", concurrency: 8 },
  );
});

test("GOMEMLIMIT leaves headroom under the container memory limit", () => {
  const memory = source.match(/^\s*memory\s*=\s*"(\d+)(Mi|Gi)"/m);
  const gomemlimit = source.match(
    /name\s*=\s*"GOMEMLIMIT"\s*\n\s*value\s*=\s*"(\d+)(MiB|GiB)"/,
  );
  assert.ok(memory, "the service sets a container memory limit");
  assert.ok(gomemlimit, "the service sets GOMEMLIMIT");
  const toMiB = ([, n, unit]) =>
    Number(n) * (unit.startsWith("G") ? 1024 : 1);
  const limit = toMiB(memory);
  const soft = toMiB(gomemlimit);
  // The runtime must collect before the kernel kills the container: the soft
  // limit stays at or under 80% of the hard one.
  assert.ok(
    soft <= limit * 0.8,
    `GOMEMLIMIT ${soft} MiB must be at most 80% of the ${limit} MiB container limit`,
  );
});

test("production wires the uptime alerts to the job-monitoring email channel", () => {
  const prod = readFileSync(
    new URL("../../terraform/environments/prod/main.tf", import.meta.url),
    "utf8",
  );
  const start = prod.indexOf('module "shorts_api"');
  assert.ok(start >= 0, "prod declares the shorts_api module");
  const block = prod.slice(start, prod.indexOf("\n}\n", start));
  // The module's check block warns only at a production plan; this pins the
  // wiring itself, so removing it fails here before any plan runs.
  assert.match(
    block,
    /notification_channel_ids\s*=\s*compact\(\[module\.job_monitoring\.notification_channel_id\]\)/,
  );
});
