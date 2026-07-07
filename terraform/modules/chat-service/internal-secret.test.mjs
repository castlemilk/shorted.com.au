import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
const variables = readFileSync(new URL("./variables.tf", import.meta.url), "utf8");

test("chat-service has access to INTERNAL_SERVICE_SECRET", () => {
  assert.match(
    main,
    /resource\s+"google_secret_manager_secret_iam_member"\s+"internal_service_secret"/,
  );
  assert.match(variables, /default\s+=\s+"INTERNAL_SERVICE_SECRET"/);
  assert.match(main, /secret_id\s+=\s+var\.internal_service_secret_name/);
  assert.match(
    main,
    /member\s+=\s+"serviceAccount:\$\{google_service_account\.chat_service\.email\}"/,
  );
});

test("chat-service injects INTERNAL_SERVICE_SECRET from Secret Manager", () => {
  assert.match(main, /name\s+=\s+"INTERNAL_SERVICE_SECRET"/);
  assert.match(main, /secret\s+=\s+var\.internal_service_secret_name/);
  assert.match(main, /version\s+=\s+"latest"/);
});

test("chat-service declares the internal service secret once", () => {
  assert.equal(
    main.match(/resource\s+"google_secret_manager_secret_iam_member"\s+"internal_service_secret"/g)?.length,
    1,
  );
  assert.equal(main.match(/name\s+=\s+"INTERNAL_SERVICE_SECRET"/g)?.length, 1);
});
