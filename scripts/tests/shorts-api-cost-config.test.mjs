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
