import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const statePath = resolve(packageRoot, ".squeeze-alerts.json");

function runSqueezeAlert(): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/index.ts",
        "squeeze-alert",
        "--dry-run",
        "--threshold=101",
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          SHORTED_API_URL: "http://127.0.0.1:9",
          TWITTER_DRY_RUN_DEFAULT: "true",
        },
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

test(
  "squeeze-alert dry-run exits cleanly when battleground RPC is unavailable",
  { timeout: 15_000 },
  async () => {
    rmSync(statePath, { force: true });

    const result = await runSqueezeAlert();

    assert.equal(result.code, 0);
    assert.match(result.stdout, /command=squeeze-alert dry_run=true/);
    assert.match(result.stdout, /GetBattlegroundStocks unavailable/);
    assert.match(result.stdout, /done \(dry-run\)/);
    assert.match(result.stderr, /network error|fetch failed/);
    assert.equal(existsSync(statePath), false);
  },
);
