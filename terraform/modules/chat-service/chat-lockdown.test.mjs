import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
const variablesTf = readFileSync(new URL("./variables.tf", import.meta.url), "utf8");

test("chat service receives the internal service secret", () => {
  assert.match(variablesTf, /variable "internal_service_secret_name"/);
  assert.match(variablesTf, /default\s+=\s+"INTERNAL_SERVICE_SECRET"/);
  assert.match(mainTf, /resource "google_secret_manager_secret_iam_member" "internal_service_secret"/);
  assert.match(mainTf, /secret_id\s+=\s+var\.internal_service_secret_name/);
  assert.match(mainTf, /name\s+=\s+"INTERNAL_SERVICE_SECRET"[\s\S]*?secret\s+=\s+var\.internal_service_secret_name/);
  assert.match(mainTf, /google_secret_manager_secret_iam_member\.internal_service_secret/);
});
