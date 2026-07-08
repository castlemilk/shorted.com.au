import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const workflowsDir = new URL("../../.github/workflows/", import.meta.url);

const deprecatedActionPins = [
  "actions/checkout@v4",
  "actions/setup-node@v4",
  "actions/upload-artifact@v4",
  "actions/setup-go@v5",
  "google-github-actions/auth@v2",
  "google-github-actions/setup-gcloud@v2",
  "docker/setup-buildx-action@v3",
  "docker/build-push-action@v6",
  "hashicorp/setup-terraform@v3",
];

const workflowFiles = readdirSync(workflowsDir)
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .map((file) => ({
    file,
    source: readFileSync(new URL(file, workflowsDir), "utf8"),
  }));

test("GitHub workflows use Node 24-compatible action majors", () => {
  for (const { file, source } of workflowFiles) {
    for (const pin of deprecatedActionPins) {
      assert.doesNotMatch(source, new RegExp(pin.replaceAll("/", "\\/")), `${file} still uses ${pin}`);
    }
  }
});

test("GitHub workflows do not pin Node setup below 24", () => {
  for (const { file, source } of workflowFiles) {
    assert.doesNotMatch(source, /node-version:\s*["']?(?:20|22)\b/, `${file} pins Node below 24`);
  }
});

test("local Node version files pin Node 24", () => {
  assert.equal(readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8").trim(), "24");
  assert.equal(readFileSync(new URL("../../.node-version", import.meta.url), "utf8").trim(), "24");
});
