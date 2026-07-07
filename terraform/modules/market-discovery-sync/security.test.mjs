import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");

test("market-data-sync service is not publicly invokable", () => {
  assert.doesNotMatch(mainTf, /market_data_sync_public[\s\S]*?member\s+=\s+"allUsers"/);
  assert.match(mainTf, /market_data_sync_scheduler_invoker/);
  assert.match(mainTf, /member\s+=\s+"serviceAccount:\$\{google_service_account\.scheduler\.email\}"/);
});
