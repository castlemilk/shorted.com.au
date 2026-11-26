import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const playwright = new URL("../node_modules/playwright/", import.meta.url);
const { version } = JSON.parse(
  readFileSync(new URL("package.json", playwright), "utf8"),
);
const cli = fileURLToPath(new URL("cli.js", playwright));
const args = process.argv.slice(2);
const needsCompatibility =
  process.versions.node.startsWith("26.") && version === "1.52.0";

// Keep Playwright's locked browser revision when its installer hangs on Linux.
const useNode22 =
  needsCompatibility && args[0] === "install" && process.platform === "linux";
// Playwright 1.52's ESM loader also hangs during discovery. Use the existing
// tsx dependency to load TypeScript tests on Node 26.
const useTsx = needsCompatibility && args[0] === "test";

const options = { cwd: webRoot, stdio: "inherit" };
const result = useNode22
  ? spawnSync(
      "npm",
      [
        "exec",
        "--yes",
        `--package=node-linux-${process.arch}@22.23.5`,
        "--",
        "node",
        cli,
        ...args,
      ],
      options,
    )
  : spawnSync(
      process.execPath,
      [...(useTsx ? ["--import", "tsx"] : []), cli, ...args],
      useTsx
        ? { ...options, env: { ...process.env, PW_DISABLE_TS_ESM: "1" } }
        : options,
    );

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
