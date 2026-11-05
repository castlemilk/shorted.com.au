/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mockClient = {
  listSavedStrategies: jest.fn(),
  saveStrategy: jest.fn(),
  unsaveStrategy: jest.fn(),
};

jest.mock("@connectrpc/connect", () => ({
  createClient: () => mockClient,
}));

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));

const mockCreateTransport = jest.fn(async (_options?: unknown) => ({
  transport: {},
  email: "",
}));
jest.mock("../../auth-transport", () => ({
  createSignedInTransport: (options?: unknown) => mockCreateTransport(options),
}));

import { auth } from "~/server/auth";
import { listSavedStrategies, saveStrategy, unsaveStrategy } from "../saved";

const mockAuth = auth as unknown as jest.Mock;

function signIn(uid = "user-a") {
  mockAuth.mockResolvedValue({ user: { id: uid } });
}

/** A Connect-shaped error: the code the action reads, as the transport throws it. */
function connectError(code: number, message = "boom") {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("saved strategy actions", () => {
  it("answers signed-out without calling the API", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(listSavedStrategies()).resolves.toEqual({ ok: false, reason: "signed-out" });
    await expect(saveStrategy("canslim")).resolves.toEqual({ ok: false, reason: "signed-out" });
    await expect(unsaveStrategy("canslim")).resolves.toEqual({ ok: false, reason: "signed-out" });
    expect(mockClient.listSavedStrategies).not.toHaveBeenCalled();
    expect(mockClient.saveStrategy).not.toHaveBeenCalled();
    expect(mockClient.unsaveStrategy).not.toHaveBeenCalled();
  });

  it("reads identity only, never an address", async () => {
    signIn();
    mockClient.listSavedStrategies.mockResolvedValue({ strategies: [], limit: 20 });
    await listSavedStrategies();
    expect(mockCreateTransport).toHaveBeenCalledWith({ withEmail: false });
  });

  it("lists the saves with their counts, in the order the API gives", async () => {
    signIn();
    mockClient.listSavedStrategies.mockResolvedValue({
      limit: 20,
      strategies: [
        {
          strategyRef: "canslim",
          strategyId: "canslim",
          name: "CAN SLIM",
          savedAt: "2026-11-01T09:00:00Z",
          statusCounts: { triggered: 2, setup: 1, watch: 9, unknown: 4 },
        },
        { strategyRef: "variant:mine", strategyId: "", name: "", savedAt: "2026-11-02T09:00:00Z", statusCounts: undefined },
      ],
    });
    const result = await listSavedStrategies();
    expect(result).toEqual({
      ok: true,
      limit: 20,
      strategies: [
        {
          strategyRef: "canslim",
          strategyId: "canslim",
          name: "CAN SLIM",
          savedAt: "2026-11-01T09:00:00Z",
          counts: { triggered: 2, setup: 1, watch: 9, unknown: 4 },
        },
        { strategyRef: "variant:mine", strategyId: "", name: "", savedAt: "2026-11-02T09:00:00Z", counts: null },
      ],
    });
  });

  it("reports a failed list as unavailable, not as an empty list", async () => {
    signIn();
    mockClient.listSavedStrategies.mockRejectedValue(connectError(14));
    await expect(listSavedStrategies()).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("maps a refused save past the cap to limit", async () => {
    signIn();
    mockClient.saveStrategy.mockRejectedValue(connectError(9));
    await expect(saveStrategy("variant:v99")).resolves.toEqual({ ok: false, reason: "limit" });
  });

  it("maps an unknown strategy to not-found", async () => {
    signIn();
    mockClient.saveStrategy.mockRejectedValue(connectError(5));
    await expect(saveStrategy("canslim")).resolves.toEqual({ ok: false, reason: "not-found" });
  });

  it("maps any other failure to unavailable", async () => {
    signIn();
    mockClient.saveStrategy.mockRejectedValue(connectError(13));
    await expect(saveStrategy("canslim")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns the saved entry on a save", async () => {
    signIn();
    mockClient.saveStrategy.mockResolvedValue({
      saved: { strategyRef: "canslim", strategyId: "canslim", name: "CAN SLIM", savedAt: "2026-11-01T09:00:00Z" },
    });
    const result = await saveStrategy("  CANSLIM ");
    expect(mockClient.saveStrategy).toHaveBeenCalledWith({ strategyRef: "CANSLIM" });
    expect(result).toMatchObject({ ok: true, strategy: { strategyRef: "canslim", counts: null } });
  });

  it("refuses a malformed reference before any call", async () => {
    signIn();
    await expect(saveStrategy("../etc")).resolves.toEqual({ ok: false, reason: "not-found" });
    await expect(saveStrategy("variant:")).resolves.toEqual({ ok: false, reason: "not-found" });
    await expect(unsaveStrategy("a b")).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(mockClient.saveStrategy).not.toHaveBeenCalled();
    expect(mockClient.unsaveStrategy).not.toHaveBeenCalled();
  });

  it("removes a save and reports success", async () => {
    signIn();
    mockClient.unsaveStrategy.mockResolvedValue({});
    await expect(unsaveStrategy("canslim")).resolves.toEqual({ ok: true });
    expect(mockClient.unsaveStrategy).toHaveBeenCalledWith({ strategyRef: "canslim" });
  });
});

describe("saved strategy actions guards", () => {
  it("imports no cache helper: a saved list is per viewer and never shared", () => {
    const source = readFileSync(join(__dirname, "..", "saved.ts"), "utf8");
    expect(source).not.toMatch(/next\/cache|unstable_cache|kv-cache|memoryCache|sharedRead|revalidate/);
  });

  it("exports only async functions and types from a use-server module", () => {
    const source = readFileSync(join(__dirname, "..", "saved.ts"), "utf8");
    const exported = [...source.matchAll(/^export (async function|const|function|let|var|interface|type) (\w+)/gm)];
    for (const [, kind, name] of exported) {
      expect(["async function", "interface", "type"]).toContain(kind);
      expect(name).toBeTruthy();
    }
  });
});
