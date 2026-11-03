/** @jest-environment node */
import { GET } from "./route";

// Jest does not run next.config.mjs, so these are the values the build would
// have inlined. The route reads them at request time here; in a built artifact
// the same reads are replaced by literals (see the comment in route.ts).
const KEYS = [
  "NEXT_PUBLIC_RELEASE_COMMIT",
  "SHORTED_BUILD_VERSION",
  "SHORTED_BUILD_DATE",
  "SHORTED_BUILD_COMMIT",
  "SHORTED_BUILD_BRANCH",
  "SHORTED_BUILD_ENVIRONMENT",
] as const;
const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

const SHA = "6f1d9392cada83e7e910e36a7526e8821db44d36";

test("reports the build identity the artifact was built with", async () => {
  process.env.NEXT_PUBLIC_RELEASE_COMMIT = SHA;
  process.env.SHORTED_BUILD_VERSION = "6f1d9392";
  process.env.SHORTED_BUILD_DATE = "2026-11-03T06:57:48.995Z";
  process.env.SHORTED_BUILD_COMMIT = "6f1d939";
  process.env.SHORTED_BUILD_BRANCH = "main";
  process.env.SHORTED_BUILD_ENVIRONMENT = "production";

  const response = await GET();

  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    version: "6f1d9392",
    buildDate: "2026-11-03T06:57:48.995Z",
    gitCommit: "6f1d939",
    gitCommitFull: SHA,
    gitBranch: "main",
    environment: "production",
    uptime: expect.any(Number),
    nodeVersion: process.version,
  });
});

test("keeps the response field names the release tooling reads", async () => {
  process.env.NEXT_PUBLIC_RELEASE_COMMIT = SHA;
  const body = (await (await GET()).json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(
    [
      "buildDate",
      "environment",
      "gitBranch",
      "gitCommit",
      "gitCommitFull",
      "nodeVersion",
      "uptime",
      "version",
    ].sort(),
  );
});

test("a build with no identity reports local instead of inventing one", async () => {
  for (const key of KEYS) delete process.env[key];
  const body = (await (await GET()).json()) as Record<string, unknown>;
  expect(body).toEqual(
    expect.objectContaining({
      version: "dev",
      gitCommit: "local",
      gitCommitFull: "local",
      gitBranch: "local",
      environment: "development",
    }),
  );
  expect(Date.parse(body.buildDate as string)).not.toBeNaN();
});
