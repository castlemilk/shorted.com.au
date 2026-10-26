/** @jest-environment node */
import getConfig from "next/config";
import { GET } from "./route";

jest.mock("next/config", () => ({ __esModule: true, default: jest.fn() }));
const config = getConfig as jest.Mock;
const previousCommit = process.env.NEXT_PUBLIC_RELEASE_COMMIT;

afterEach(() => {
  if (previousCommit === undefined)
    delete process.env.NEXT_PUBLIC_RELEASE_COMMIT;
  else process.env.NEXT_PUBLIC_RELEASE_COMMIT = previousCommit;
  jest.clearAllMocks();
});

test("returns the artifact's full commit when App Router has no runtime config", async () => {
  config.mockReturnValue(undefined);
  process.env.NEXT_PUBLIC_RELEASE_COMMIT = "a".repeat(40);
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(
    expect.objectContaining({ gitCommitFull: "a".repeat(40) }),
  );
});

test("runtime config's short hash cannot replace the artifact's full commit", async () => {
  config.mockReturnValue({
    publicRuntimeConfig: { version: "1.2.3", gitCommit: "oldhash" },
  });
  process.env.NEXT_PUBLIC_RELEASE_COMMIT = "b".repeat(40);
  expect(await (await GET()).json()).toEqual(
    expect.objectContaining({
      version: "1.2.3",
      gitCommit: "oldhash",
      gitCommitFull: "b".repeat(40),
    }),
  );
});

test("local builds report local instead of manufacturing a release identity", async () => {
  config.mockReturnValue(undefined);
  delete process.env.NEXT_PUBLIC_RELEASE_COMMIT;
  expect(await (await GET()).json()).toEqual(
    expect.objectContaining({ gitCommitFull: "local" }),
  );
});
